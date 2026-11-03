<#
.SYNOPSIS
  Déploie (ou met à jour) une installation du Meeting Room Portal sur un tenant Microsoft 365.

.DESCRIPTION
  Une installation = un fichier deployments/<nom>.json. Le script enchaîne, dans cet ordre :
    Prerequisites  outils et modules PowerShell nécessaires
    Infra          ressources Azure (Bicep) dans l'abonnement du tenant cible
    Entra          app registration, groupe, rôle, credential fédéré, accès conditionnel
                   (puis second passage Infra si le Client ID a changé)
    Exchange       RBAC for Applications, contrôle des salles
    Teams          stratégie de réunion de l'organisateur
    App            paquet applicatif + contrôle de santé

  Tout est idempotent : relancer le script met l'installation en conformité avec sa configuration.
  Les identifiants générés (Client ID, Managed Identity, URL) sont écrits dans
  deployments/<nom>.state.json, à committer (aucun secret).

.EXAMPLE
  ./scripts/deploy.ps1 -Config deployments/test.json
  ./scripts/deploy.ps1 -Config deployments/prod.json -Steps Infra,App
#>
#Requires -Version 7.2
[CmdletBinding()]
param(
  [Parameter(Mandatory)] [string] $Config,
  [ValidateSet('Prerequisites', 'Infra', 'Entra', 'Exchange', 'Teams', 'App')]
  [string[]] $Steps = @('Prerequisites', 'Infra', 'Entra', 'Exchange', 'Teams', 'App'),
  [string] $PackagePath,
  [switch] $RotateSessionSecret,
  [switch] $Force
)

$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$isCi = [bool]$env:GITHUB_ACTIONS

# ------------------------------------------------------------------------------- Configuration

$guid = '^[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$'
$email = '^[^@\s]+@[^@\s]+\.[a-zA-Z]{2,}$'
$domain = '^([a-zA-Z0-9-]+\.)+[a-zA-Z]{2,}$'

function Read-DeploymentConfig([string] $path) {
  if (-not (Test-Path $path)) { throw "Fichier de configuration introuvable : $path" }
  $c = Get-Content $path -Raw | ConvertFrom-Json
  $errors = [System.Collections.Generic.List[string]]::new()
  $check = { param($ok, $message) if (-not $ok) { $errors.Add($message) } }

  & $check ($c.name -cmatch '^[a-z0-9]{1,8}$') 'name : 1 à 8 caractères, minuscules et chiffres.'
  & $check ($c.tenantId -match $guid) 'tenantId : GUID du tenant Microsoft 365 cible.'
  & $check ($c.subscriptionId -match $guid) 'subscriptionId : GUID de l''abonnement Azure (rattaché au tenant cible).'
  & $check ($c.resourceGroup -match '^[\w\-\.\(\)]{1,90}$') 'resourceGroup : nom de groupe de ressources.'
  & $check ([bool]$c.location) 'location : région Azure (ex. francecentral).'
  & $check ($c.partner.tenantId -match $guid) 'partner.tenantId : GUID du tenant partenaire.'
  & $check ($c.partner.tenantId -ne $c.tenantId) 'partner.tenantId doit être différent de tenantId.'
  & $check ($c.partner.displayName -and $c.partner.displayName.Length -le 40) 'partner.displayName : 1 à 40 caractères.'
  $partnerDomains = @($c.partner.domains | Where-Object { $_ })
  $attendeeDomains = @($c.allowedAttendeeDomains | Where-Object { $_ })
  & $check ($partnerDomains.Count -gt 0 -and -not ($partnerDomains | Where-Object { $_ -notmatch $domain })) 'partner.domains : domaines e-mail des invités du partenaire.'
  & $check ($c.organizerUpn -match $email) 'organizerUpn : adresse de la boîte organisatrice.'
  & $check ($attendeeDomains.Count -gt 0 -and -not ($attendeeDomains | Where-Object { $_ -notmatch $domain })) 'allowedAttendeeDomains : liste de domaines.'
  if ($c.namePrefix) { & $check ($c.namePrefix -cmatch '^[a-z0-9]{1,10}$') 'namePrefix : 1 à 10 caractères, minuscules et chiffres.' }
  if ($c.customBaseUrl) { & $check ($c.customBaseUrl -match '^https://') 'customBaseUrl : URL https.' }

  if ($errors.Count) { throw "Configuration invalide ($path) :`n  - $($errors -join "`n  - ")" }

  $booking = [ordered]@{ dayStart = '08:00'; dayEnd = '19:00'; slotMinutes = 15; maxDurationMinutes = 240; horizonDays = 30; maxActivePerUser = 10; allowWeekends = $false }
  if ($c.booking) { foreach ($p in $c.booking.PSObject.Properties) { $booking[$p.Name] = $p.Value } }

  [pscustomobject]@{
    Name                     = $c.name
    InstanceName             = "MeetingRoomPortal-$($c.name)"
    TenantId                 = $c.tenantId.ToLowerInvariant()
    SubscriptionId           = $c.subscriptionId
    ResourceGroup            = $c.resourceGroup
    Location                 = $c.location
    NamePrefix               = $c.namePrefix ?? 'roomportal'
    PartnerTenantId          = $c.partner.tenantId.ToLowerInvariant()
    PartnerDisplayName       = $c.partner.displayName
    PartnerDomains           = $partnerDomains
    OrganizerUpn             = $c.organizerUpn.ToLowerInvariant()
    AllowedAttendeeDomains   = $attendeeDomains
    AllowInternalUsers       = [bool]$c.allowInternalUsers
    TimeZone                 = $c.timeZone ?? 'Europe/Paris'
    AppServiceSku            = $c.appServiceSku ?? 'B1'
    CustomBaseUrl            = $c.customBaseUrl ?? ''
    VnetAddressPrefix        = $c.network.vnetAddressPrefix ?? '10.60.0.0/24'
    AppSubnetPrefix          = $c.network.appSubnetPrefix ?? '10.60.0.0/26'
    Booking                  = $booking
    OrganizerAttributeNumber = $c.exchange.organizerAttributeNumber ?? 15
    FixRoomProcessing        = [bool]$c.exchange.fixRoomProcessing
  }
}

$configPath = (Resolve-Path $Config).Path
$cfg = Read-DeploymentConfig $configPath
$statePath = [IO.Path]::ChangeExtension($configPath, '.state.json')
$state = if (Test-Path $statePath) { Get-Content $statePath -Raw | ConvertFrom-Json -AsHashtable } else { @{} }

function Save-State {
  $state.updatedAt = (Get-Date).ToUniversalTime().ToString('o')
  $state | ConvertTo-Json | Set-Content $statePath -Encoding utf8
}

# ------------------------------------------------------------------------------- Outils

function Invoke-Az {
  $output = & az @args --only-show-errors
  if ($LASTEXITCODE -ne 0) { throw "Échec de la commande : az $($args[0]) $($args[1])" }
  $output
}
function Invoke-AzJson { (Invoke-Az @args -o json) -join "`n" | ConvertFrom-Json }

function Write-Step([string] $title) { Write-Host "`n=== $title ===" -ForegroundColor Cyan }

# ------------------------------------------------------------------------------- Étapes

function Step-Prerequisites {
  Write-Step 'Prérequis'
  $missing = @()
  if (-not (Get-Command az -ErrorAction SilentlyContinue)) { $missing += 'Azure CLI : winget install Microsoft.AzureCLI' }
  if ('App' -in $Steps -and -not $PackagePath -and -not (Get-Command npm -ErrorAction SilentlyContinue)) { $missing += 'Node.js 22 : winget install OpenJS.NodeJS.LTS' }
  $modules = @{
    Entra    = @('Microsoft.Graph.Authentication', 'Microsoft.Graph.Applications', 'Microsoft.Graph.Groups', 'Microsoft.Graph.Users', 'Microsoft.Graph.Identity.SignIns')
    Exchange = @('ExchangeOnlineManagement')
    Teams    = @('MicrosoftTeams')
  }
  foreach ($step in $modules.Keys) {
    if ($step -notin $Steps) { continue }
    foreach ($module in $modules[$step]) {
      if (-not (Get-Module -ListAvailable -Name $module)) { $missing += "Module $module : Install-Module $module -Scope CurrentUser" }
    }
  }
  if ($missing) { throw "Prérequis manquants :`n  - $($missing -join "`n  - ")" }
  Write-Host 'OK'
}

function Step-Infra([bool] $allowNewSecret = $true) {
  Write-Step "Infrastructure Azure ($($cfg.ResourceGroup))"
  $account = Invoke-AzJson account show
  if ($account.tenantId -ne $cfg.TenantId) {
    throw "Azure CLI est connecté au tenant $($account.tenantId). Lancez : az login --tenant $($cfg.TenantId)"
  }
  Invoke-Az account set --subscription $cfg.SubscriptionId | Out-Null
  if ((Invoke-AzJson account show).tenantId -ne $cfg.TenantId) {
    throw "L'abonnement $($cfg.SubscriptionId) n'appartient pas au tenant $($cfg.TenantId) : l'identité managée doit vivre dans le tenant des boîtes Exchange."
  }

  if ((Invoke-Az group exists --name $cfg.ResourceGroup) -ne 'true') {
    Invoke-Az group create --name $cfg.ResourceGroup --location $cfg.Location --tags application=meeting-room-portal "environment=$($cfg.Name)" | Out-Null
  }

  $parameters = [ordered]@{
    namePrefix             = $cfg.NamePrefix
    environmentName        = $cfg.Name
    location               = $cfg.Location
    partnerTenantId        = $cfg.PartnerTenantId
    partnerDisplayName     = $cfg.PartnerDisplayName
    entraClientId          = $state.entraClientId ?? ''
    organizerUpn           = $cfg.OrganizerUpn
    allowedAttendeeDomains = ($cfg.AllowedAttendeeDomains -join ',')
    customBaseUrl          = $cfg.CustomBaseUrl
    allowInternalUsers     = $cfg.AllowInternalUsers
    bookingRules           = $cfg.Booking
    appServiceSkuName      = $cfg.AppServiceSku
    vnetAddressPrefix      = $cfg.VnetAddressPrefix
    appSubnetPrefix        = $cfg.AppSubnetPrefix
    timeZone               = $cfg.TimeZone
  }

  # La clé de session n'est générée qu'à la création (ou sur demande) : sinon Bicep conserve celle de Key Vault.
  $vaults = Invoke-AzJson resource list --resource-group $cfg.ResourceGroup --resource-type Microsoft.KeyVault/vaults
  if ($allowNewSecret -and ($RotateSessionSecret -or @($vaults).Count -eq 0)) {
    $parameters.sessionSecret = [Convert]::ToBase64String([Security.Cryptography.RandomNumberGenerator]::GetBytes(48))
    Write-Host 'Nouvelle clé de session générée.'
  }

  $armParameters = [ordered]@{}
  foreach ($entry in $parameters.GetEnumerator()) { $armParameters[$entry.Key] = @{ value = $entry.Value } }

  # Fichier temporaire supprimé aussitôt : il peut contenir la clé de session.
  $file = New-TemporaryFile
  try {
    @{
      '$schema'      = 'https://schema.management.azure.com/schemas/2019-04-01/deploymentParameters.json#'
      contentVersion = '1.0.0.0'
      parameters     = $armParameters
    } | ConvertTo-Json -Depth 10 | Set-Content $file -Encoding utf8

    $outputs = Invoke-AzJson deployment group create `
      --resource-group $cfg.ResourceGroup `
      --name "roomportal-$(Get-Date -Format 'yyyyMMdd-HHmmss')" `
      --template-file (Join-Path $root 'infra/main.bicep') `
      --parameters "@$file" `
      --query properties.outputs
  } finally {
    Remove-Item $file -Force
  }

  $state.appName = $outputs.appName.value
  $state.appUrl = $outputs.appUrl.value
  $state.managedIdentityClientId = $outputs.managedIdentityClientId.value
  $state.managedIdentityPrincipalId = $outputs.managedIdentityPrincipalId.value
  $state.deployedEntraClientId = $parameters.entraClientId
  Save-State
  Write-Host "Application : $($state.appUrl)"
}

function Step-Entra {
  Write-Step "Entra ID ($($cfg.InstanceName))"
  if (-not $state.managedIdentityPrincipalId) { throw 'Lancez d''abord l''étape Infra.' }
  $result = & (Join-Path $PSScriptRoot '01-entra.ps1') `
    -TenantId $cfg.TenantId `
    -AppUrl $state.appUrl `
    -ManagedIdentityPrincipalId $state.managedIdentityPrincipalId `
    -PartnerTenantId $cfg.PartnerTenantId `
    -PartnerDomains $cfg.PartnerDomains `
    -InstanceName $cfg.InstanceName `
    -IncludeLocalhostRedirect:($cfg.AllowInternalUsers) | Select-Object -Last 1
  $state.entraClientId = $result.ClientId
  Save-State

  if ($state.deployedEntraClientId -ne $state.entraClientId) {
    Write-Host 'Client ID nouveau : second passage Infra pour le transmettre à l''application.'
    Step-Infra -allowNewSecret $false
  }
}

function Step-Exchange {
  Write-Step 'Exchange Online'
  & (Join-Path $PSScriptRoot '02-exchange.ps1') `
    -TenantId $cfg.TenantId `
    -OrganizerUpn $cfg.OrganizerUpn `
    -ManagedIdentityClientId $state.managedIdentityClientId `
    -ManagedIdentityPrincipalId $state.managedIdentityPrincipalId `
    -InstanceName $cfg.InstanceName `
    -OrganizerAttributeNumber $cfg.OrganizerAttributeNumber `
    -FixRoomProcessing:($cfg.FixRoomProcessing)
}

function Step-Teams {
  Write-Step 'Teams'
  & (Join-Path $PSScriptRoot '03-teams.ps1') -TenantId $cfg.TenantId -OrganizerUpn $cfg.OrganizerUpn -InstanceName $cfg.InstanceName
}

function Step-App {
  Write-Step 'Application'
  if (-not $state.appName) { throw 'Lancez d''abord l''étape Infra.' }
  if (-not $state.entraClientId) { Write-Warning 'Entra ID n''est pas encore configuré : l''application ne démarrera pas tant que l''étape Entra n''a pas été jouée.' }
  $package = if ($PackagePath) { (Resolve-Path $PackagePath).Path } else { & (Join-Path $PSScriptRoot 'build-package.ps1') }
  Invoke-Az webapp deploy --resource-group $cfg.ResourceGroup --name $state.appName --src-path $package --type zip | Out-Null

  if ($state.entraClientId) {
    for ($i = 0; $i -lt 18; $i++) {
      try {
        if ((Invoke-WebRequest "$($state.appUrl)/healthz" -TimeoutSec 10 -SkipHttpErrorCheck).StatusCode -eq 200) { Write-Host "En ligne : $($state.appUrl)"; return }
      } catch { }
      Start-Sleep -Seconds 10
    }
    Write-Warning 'L''application ne répond pas encore : consultez les journaux (az webapp log tail).'
  }
}

# ------------------------------------------------------------------------------- Exécution

Write-Host "Installation   : $($cfg.Name) ($($cfg.InstanceName))"
Write-Host "Tenant cible   : $($cfg.TenantId)"
Write-Host "Abonnement     : $($cfg.SubscriptionId) / $($cfg.ResourceGroup) ($($cfg.Location))"
Write-Host "Partenaire     : $($cfg.PartnerDisplayName) ($($cfg.PartnerTenantId)) — $($cfg.PartnerDomains -join ', ')"
Write-Host "Organisateur   : $($cfg.OrganizerUpn)"
Write-Host "Étapes         : $($Steps -join ', ')"
if ($cfg.AllowInternalUsers) { Write-Warning 'allowInternalUsers est activé : à réserver à la recette.' }

if (-not $Force -and -not $isCi) {
  $answer = Read-Host "Tapez le nom de l'installation ($($cfg.Name)) pour confirmer"
  if ($answer -cne $cfg.Name) { throw 'Abandon.' }
}

foreach ($step in 'Prerequisites', 'Infra', 'Entra', 'Exchange', 'Teams', 'App') {
  if ($step -in $Steps) { & "Step-$step" }
}

Write-Host "`nTerminé. État enregistré dans $statePath" -ForegroundColor Green
if ('Exchange' -in $Steps) { Write-Host 'Rappel : Exchange RBAC for Applications peut mettre jusqu''à 2 h à se propager.' }
