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
$PSDefaultParameterValues['*:ErrorAction'] = 'Stop'
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
  & $check ($attendeeDomains.Count -gt 0 -and -not ($attendeeDomains | Where-Object { $_ -ne '*' -and $_ -notmatch $domain })) 'allowedAttendeeDomains : liste de domaines, ou ["*"] pour tout domaine.'
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
    AutomationLocation       = $c.automationLocation ?? $c.location
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

# Microsoft.Graph, ExchangeOnlineManagement et MicrosoftTeams embarquent chacun leur version de
# MSAL (Microsoft.Identity.Client) ; .NET n'en charge qu'une par processus. Chaque script tourne
# donc dans un processus PowerShell neuf, quel que soit l'historique de la session courante.
function Invoke-IsolatedScript([string] $script, [string[]] $arguments) {
  & ([Environment]::ProcessPath) -NoProfile -File (Join-Path $PSScriptRoot $script) @arguments
  if ($LASTEXITCODE -ne 0) { throw "$script a échoué (code $LASTEXITCODE)." }
}

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
    automationLocation     = $cfg.AutomationLocation
    roomDirectory          = $state.roomDirectory ?? '[]'
    tenantInitialDomain    = $state.tenantInitialDomain ?? ''
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
  $state.automationAccountName = $outputs.automationAccountName.value
  $state.syncIdentityClientId = $outputs.syncIdentityClientId.value
  $state.syncIdentityPrincipalId = $outputs.syncIdentityPrincipalId.value
  $state.deployedEntraClientId = $parameters.entraClientId
  $state.deployedRoomDirectory = $parameters.roomDirectory
  $state.deployedTenantInitialDomain = $parameters.tenantInitialDomain
  Save-State
  Write-Host "Application : $($state.appUrl)"
  Publish-SyncRunbook
}

function Get-AutomationBase {
  "https://management.azure.com/subscriptions/$($cfg.SubscriptionId)/resourceGroups/$($cfg.ResourceGroup)/providers/Microsoft.Automation/automationAccounts/$($state.automationAccountName)"
}

function Invoke-AzRestPut([string] $url, [object] $body) {
  $file = New-TemporaryFile
  try {
    $body | ConvertTo-Json -Depth 6 | Set-Content $file -Encoding utf8
    Invoke-Az rest --method put --url $url --body "@$file" | Out-Null
  } finally {
    Remove-Item $file -Force
  }
}

# Runbook de synchronisation des salles : contenu, publication, et exécution toutes les 15 min.
# Une planification Azure Automation est au plus horaire : quatre planifications décalées de 15 min.
function Publish-SyncRunbook {
  if (-not $state.automationAccountName) { return }
  $base = Get-AutomationBase
  $api = 'api-version=2023-11-01'
  $runbook = 'Sync-RoomDirectory'

  Invoke-AzRestPut "$base/runbooks/$($runbook)?$api" @{
    location   = $cfg.AutomationLocation
    properties = @{ runbookType = 'PowerShell'; logProgress = $false; logVerbose = $false; description = 'Synchronise les salles Exchange avec le Meeting Room Portal.' }
  }
  Invoke-Az rest --method put --url "$base/runbooks/$runbook/draft/content?$api" --headers 'Content-Type=text/powershell' `
    --body "@$(Join-Path $PSScriptRoot 'runbooks/Sync-RoomDirectory.ps1')" | Out-Null
  for ($attempt = 1; ; $attempt++) {
    try {
      Invoke-Az rest --method post --url "$base/runbooks/$runbook/publish?$api" | Out-Null
      break
    } catch {
      if ($attempt -ge 4) { throw }
      Start-Sleep -Seconds 5
    }
  }

  $schedules = @((Invoke-AzJson rest --method get --url "$base/schedules?$api").value)
  $jobSchedules = @((Invoke-AzJson rest --method get --url "$base/jobSchedules?$api").value)
  for ($i = 0; $i -lt 4; $i++) {
    $name = "RoomSync-$($i * 15)"
    if (-not ($schedules | Where-Object name -eq $name)) {
      Invoke-AzRestPut "$base/schedules/$($name)?$api" @{
        properties = @{
          startTime   = (Get-Date).ToUniversalTime().AddMinutes(10 + $i * 15).ToString('yyyy-MM-ddTHH:mm:00Z')
          frequency   = 'Hour'
          interval    = 1
          timeZone    = 'UTC'
          description = "Synchronisation des salles (décalage $($i * 15) min)"
        }
      }
    }
    if (-not ($jobSchedules | Where-Object { $_.properties.schedule.name -eq $name -and $_.properties.runbook.name -eq $runbook })) {
      Invoke-AzRestPut "$base/jobSchedules/$([guid]::NewGuid())?$api" @{ properties = @{ schedule = @{ name = $name }; runbook = @{ name = $runbook } } }
    }
  }
  Write-Host 'Runbook de synchronisation des salles publié (exécution toutes les 15 min).'
}

# Première synchronisation sans attendre la planification (si le module Exchange est importé).
function Start-RoomSync {
  if (-not $state.automationAccountName) { return }
  $base = Get-AutomationBase
  $api = 'api-version=2023-11-01'
  $module = Invoke-AzJson rest --method get --url "$base/modules/ExchangeOnlineManagement?$api"
  if ($module.properties.provisioningState -ne 'Succeeded') {
    Write-Host "Module Exchange en cours d'import dans Azure Automation ($($module.properties.provisioningState)) : la synchronisation démarrera à la prochaine planification."
    return
  }
  Invoke-AzRestPut "$base/jobs/$([guid]::NewGuid())?$api" @{ properties = @{ runbook = @{ name = 'Sync-RoomDirectory' } } }
  Write-Host 'Synchronisation des salles lancée (résultat dans Azure Automation > Tâches).'
}

function Step-Entra {
  Write-Step "Entra ID ($($cfg.InstanceName))"
  if (-not $state.managedIdentityPrincipalId) { throw 'Lancez d''abord l''étape Infra.' }
  $resultPath = Join-Path ([IO.Path]::GetTempPath()) "roomportal-entra-$([guid]::NewGuid()).json"
  $arguments = @(
    '-TenantId', $cfg.TenantId,
    '-AppUrl', $state.appUrl,
    '-ManagedIdentityPrincipalId', $state.managedIdentityPrincipalId,
    '-PartnerTenantId', $cfg.PartnerTenantId,
    '-PartnerDomains', ($cfg.PartnerDomains -join ','),
    '-InstanceName', $cfg.InstanceName,
    '-ResultPath', $resultPath
  )
  if ($state.syncIdentityPrincipalId) { $arguments += @('-SyncPrincipalId', $state.syncIdentityPrincipalId) }
  if ($cfg.AllowInternalUsers) { $arguments += '-IncludeLocalhostRedirect' }
  try {
    Invoke-IsolatedScript '01-entra.ps1' $arguments
    $result = Get-Content $resultPath -Raw | ConvertFrom-Json
  } finally {
    Remove-Item $resultPath -Force -ErrorAction SilentlyContinue
  }
  if (-not $result.ClientId) { throw 'L''étape Entra n''a pas renvoyé de Client ID.' }
  $state.entraClientId = $result.ClientId
  if ($result.InitialDomain) { $state.tenantInitialDomain = $result.InitialDomain }
  Save-State

  if ($state.deployedEntraClientId -ne $state.entraClientId -or $state.deployedTenantInitialDomain -ne $state.tenantInitialDomain) {
    Write-Host 'Nouvelles valeurs Entra : second passage Infra pour les transmettre à l''application et au runbook.'
    Step-Infra -allowNewSecret $false
  }
}

function Step-Exchange {
  Write-Step 'Exchange Online'
  if (-not $state.managedIdentityPrincipalId) { throw 'Lancez d''abord l''étape Infra.' }
  $arguments = @(
    '-TenantId', $cfg.TenantId,
    '-OrganizerUpn', $cfg.OrganizerUpn,
    '-ManagedIdentityClientId', $state.managedIdentityClientId,
    '-ManagedIdentityPrincipalId', $state.managedIdentityPrincipalId,
    '-InstanceName', $cfg.InstanceName,
    '-OrganizerAttributeNumber', [string]$cfg.OrganizerAttributeNumber
  )
  if ($cfg.FixRoomProcessing) { $arguments += '-FixRoomProcessing' }
  if ($state.syncIdentityPrincipalId) { $arguments += @('-SyncClientId', $state.syncIdentityClientId, '-SyncPrincipalId', $state.syncIdentityPrincipalId) }
  $resultPath = Join-Path ([IO.Path]::GetTempPath()) "roomportal-exchange-$([guid]::NewGuid()).json"
  $arguments += @('-ResultPath', $resultPath)
  try {
    Invoke-IsolatedScript '02-exchange.ps1' $arguments
    $rooms = @((Get-Content $resultPath -Raw | ConvertFrom-Json).rooms)
  } finally {
    Remove-Item $resultPath -Force -ErrorAction SilentlyContinue
  }
  $state.roomDirectory = ConvertTo-Json -InputObject $rooms -Compress -Depth 4
  Save-State
  Write-Host "$($rooms.Count) salle(s) relevée(s) dans Exchange."

  if ($state.deployedRoomDirectory -ne $state.roomDirectory) {
    Write-Host 'Annuaire des salles modifié : passage Infra pour le transmettre à l''application.'
    Step-Infra -allowNewSecret $false
  }
  Start-RoomSync
}

function Step-Teams {
  Write-Step 'Teams'
  Invoke-IsolatedScript '03-teams.ps1' @('-TenantId', $cfg.TenantId, '-OrganizerUpn', $cfg.OrganizerUpn, '-InstanceName', $cfg.InstanceName)
}

# Publication OneDeploy sur le point SCM de l'App Service avec un jeton Entra ID (l'authentification
# de base est désactivée). L'envoi passe par .NET plutôt que par « az webapp deploy » : il utilise le
# magasin de certificats du système, ce qui fonctionne derrière un proxy d'inspection TLS d'entreprise.
function Publish-Package([string] $package) {
  $site = Invoke-AzJson webapp show --resource-group $cfg.ResourceGroup --name $state.appName
  $scmHost = ($site.hostNameSslStates | Where-Object hostType -eq 'Repository' | Select-Object -First 1).name
  if (-not $scmHost) { throw "Point de publication SCM introuvable pour $($state.appName)." }
  $headers = @{ Authorization = "Bearer $(Invoke-Az account get-access-token --resource https://management.azure.com/ --query accessToken -o tsv)" }

  Write-Host "Envoi du paquet ($([math]::Round((Get-Item $package).Length / 1MB, 1)) Mo) vers $scmHost…"
  $response = Invoke-WebRequest -Method Post -Uri "https://$scmHost/api/publish?type=zip&async=true" -InFile $package `
    -ContentType 'application/zip' -Headers $headers -TimeoutSec 900 -SkipHttpErrorCheck
  if ($response.StatusCode -ge 400) {
    if ($response.Headers['Cf-Team'] -or "$($response.Headers['Server-Timing'])" -match 'cfReqDur') {
      throw "Envoi bloqué par Cloudflare Gateway (HTTP $($response.StatusCode)) : le proxy d'entreprise coupe le téléversement du paquet vers $scmHost. Déployez depuis GitHub Actions, ou demandez une exclusion de l'inspection pour *.scm.azurewebsites.net."
    }
    throw "Échec de l'envoi du paquet : HTTP $($response.StatusCode) $($response.Content)"
  }

  # Statuts Kudu : 3 = échec, 4 = succès.
  for ($i = 0; $i -lt 60; $i++) {
    Start-Sleep -Seconds 5
    $deployment = Invoke-RestMethod -Uri "https://$scmHost/api/deployments/latest" -Headers $headers -TimeoutSec 30
    if ($deployment.status -eq 4) { Write-Host 'Paquet déployé.'; return }
    if ($deployment.status -eq 3) { throw "Échec du déploiement : $($deployment.status_text) — détail : https://$scmHost/api/deployments/$($deployment.id)/log" }
  }
  throw 'Le déploiement ne s''est pas terminé en 5 minutes.'
}

function Step-App {
  Write-Step 'Application'
  if (-not $state.appName) { throw 'Lancez d''abord l''étape Infra.' }
  if (-not $state.entraClientId) { Write-Warning 'Entra ID n''est pas encore configuré : l''application ne démarrera pas tant que l''étape Entra n''a pas été jouée.' }
  $package = if ($PackagePath) { (Resolve-Path $PackagePath).Path } else { & (Join-Path $PSScriptRoot 'build-package.ps1') | Select-Object -Last 1 }
  Publish-Package $package

  if ($state.entraClientId) {
    # L'ancien conteneur répond encore quelques secondes après la publication : on attend la version du paquet.
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $zip = [IO.Compression.ZipFile]::OpenRead($package)
    try {
      $entry = $zip.GetEntry('version.txt')
      $expected = if ($entry) { $reader = [IO.StreamReader]::new($entry.Open()); try { $reader.ReadToEnd().Trim() } finally { $reader.Dispose() } }
    } finally { $zip.Dispose() }

    for ($i = 0; $i -lt 24; $i++) {
      try {
        $health = Invoke-RestMethod "$($state.appUrl)/healthz" -TimeoutSec 10
        if ($health.status -eq 'ok' -and (-not $expected -or $health.version -eq $expected)) {
          Write-Host "En ligne : $($state.appUrl) (version $($health.version))"
          return
        }
      } catch { }
      Start-Sleep -Seconds 10
    }
    Write-Warning "La nouvelle version ($expected) n'est pas encore active : consultez les journaux de l'App Service."
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

Write-Host "`nTerminé." -ForegroundColor Green
if (Test-Path $statePath) { Write-Host "État de l'installation : $statePath" }
if ('Exchange' -in $Steps) { Write-Host 'Rappel : Exchange RBAC for Applications peut mettre jusqu''à 2 h à se propager.' }
