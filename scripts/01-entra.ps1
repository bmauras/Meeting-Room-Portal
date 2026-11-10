<#
.SYNOPSIS
  Configure Entra ID pour une installation du Meeting Room Portal (idempotent).

.DESCRIPTION
  1. App registration de connexion (tenant unique, rôle d'app Room.Booker, claims email/acct).
  2. Enterprise app avec « assignment required ».
  3. Consentement administrateur pour openid/profile/email.
  4. Credential fédéré : la Managed Identity de l'App Service remplace tout secret client.
  5. Groupe de sécurité des invités du partenaire (comptes existants) → rôle Room.Booker.
  6. Permission Graph Place.Read.All pour la Managed Identity (liste des salles).
     Calendars.ReadWrite n'est PAS accordée ici : elle est accordée par Exchange RBAC for
     Applications, limitée aux salles et à la boîte organisatrice (voir 02-exchange.ps1).
  7. Paramètres d'accès inter-tenant : MFA du tenant partenaire reconnue.
  8. Accès conditionnel : MFA + fréquence de connexion, créé en mode « rapport seulement ».

  Retourne un objet { ClientId, GroupId } ; normalement appelé par deploy.ps1.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory)] [string] $TenantId,
  [Parameter(Mandatory)] [string] $AppUrl,
  # URL azurewebsites.net, conservée comme redirection quand AppUrl est un domaine personnalisé.
  [string] $DefaultAppUrl,
  [Parameter(Mandatory)] [string] $ManagedIdentityPrincipalId,
  [Parameter(Mandatory)] [string] $PartnerTenantId,
  [Parameter(Mandatory)] [string[]] $PartnerDomains,
  # Identité managée du runbook de synchronisation des salles (sortie Bicep syncIdentityPrincipalId).
  [string] $SyncPrincipalId,
  [string] $InstanceName = 'MeetingRoomPortal',
  [switch] $IncludeLocalhostRedirect,
  # Fichier JSON où écrire le résultat (utilisé quand le script tourne dans un processus séparé).
  [string] $ResultPath
)

$ErrorActionPreference = 'Stop'
# Les cmdlets Microsoft.Graph sont des fonctions de module : elles ignorent $ErrorActionPreference
# du script appelant. Sans ceci, une erreur Graph n'interrompt pas le script.
$PSDefaultParameterValues['*:ErrorAction'] = 'Stop'
#Requires -Modules Microsoft.Graph.Authentication, Microsoft.Graph.Applications, Microsoft.Graph.Groups, Microsoft.Graph.Users, Microsoft.Graph.Identity.SignIns

# Un objet Entra tout juste créé peut ne pas être encore visible par les appels suivants.
function Invoke-WithRetry([string] $What, [scriptblock] $Action, [int] $Attempts = 6) {
  for ($i = 1; ; $i++) {
    try { return & $Action }
    catch {
      if ($i -ge $Attempts) { throw }
      Write-Host "  $What : réplication Entra en cours, nouvel essai dans $($i * 5) s ($($_.Exception.Message.Split("`n")[0]))"
      Start-Sleep -Seconds ($i * 5)
    }
  }
}

# Avec pwsh -File, une liste arrive sous forme d'une seule chaîne « a,b ».
$PartnerDomains = @($PartnerDomains | ForEach-Object { $_ -split ',' } | ForEach-Object { $_.Trim() } | Where-Object { $_ })

$displayName = $InstanceName
$groupName = "SG-$InstanceName-PartnerGuests"
$caName = "CA-$InstanceName-Partner-MFA"

Connect-MgGraph -TenantId $TenantId -NoWelcome -Scopes @(
  'Application.ReadWrite.All',
  'AppRoleAssignment.ReadWrite.All',
  'DelegatedPermissionGrant.ReadWrite.All',
  'Group.ReadWrite.All',
  'User.Read.All',
  'Organization.Read.All',
  'Policy.Read.All',
  'Policy.ReadWrite.CrossTenantAccess',
  'Policy.ReadWrite.ConditionalAccess'
)
if ((Get-MgContext).TenantId -ne $TenantId) {
  throw "Session Graph ouverte sur le tenant $((Get-MgContext).TenantId) au lieu de $TenantId."
}
if ($PartnerTenantId -eq $TenantId) { throw 'Le tenant partenaire doit être différent du tenant cible.' }

$AppUrl = $AppUrl.TrimEnd('/')
$graphAppId = '00000003-0000-0000-c000-000000000000'
$graphSp = Get-MgServicePrincipal -Filter "appId eq '$graphAppId'"

# --- 1. App registration -------------------------------------------------------------------
$redirectUris = @("$AppUrl/auth/callback")
if ($DefaultAppUrl -and $DefaultAppUrl.TrimEnd('/') -ne $AppUrl) { $redirectUris += "$($DefaultAppUrl.TrimEnd('/'))/auth/callback" }
if ($IncludeLocalhostRedirect) { $redirectUris += 'http://localhost:5173/auth/callback' }

$oidcScopes = @('openid', 'profile', 'email') | ForEach-Object {
  $scopeName = $_
  @{ Id = ($graphSp.Oauth2PermissionScopes | Where-Object Value -eq $scopeName).Id; Type = 'Scope' }
}

$appParams = @{
  DisplayName            = $displayName
  SignInAudience         = 'AzureADMyOrg'
  Web                    = @{
    RedirectUris          = $redirectUris
    ImplicitGrantSettings = @{ EnableIdTokenIssuance = $false; EnableAccessTokenIssuance = $false }
  }
  OptionalClaims         = @{ IdToken = @(@{ Name = 'email' }, @{ Name = 'acct' }) }
  RequiredResourceAccess = @(@{ ResourceAppId = $graphAppId; ResourceAccess = $oidcScopes })
  Api                    = @{ RequestedAccessTokenVersion = 2 }
}

$app = Get-MgApplication -Filter "displayName eq '$displayName'" | Select-Object -First 1
if (-not $app) {
  $app = New-MgApplication @appParams
  Write-Host "App registration créée : $($app.AppId)"
} else {
  Update-MgApplication -ApplicationId $app.Id @appParams
  Write-Host "App registration mise à jour : $($app.AppId)"
}

# Rôles d'application (identifiants existants conservés) et adresse d'API api://<appId>, cible du
# jeton que le runbook de synchronisation présente au portail.
$roleDefinitions = @(
  @{ Value = 'Room.Booker'; DisplayName = 'Room Booker'; Description = 'Peut réserver des salles de réunion via le portail.'; AllowedMemberTypes = @('User') },
  @{ Value = 'RoomDirectory.Write'; DisplayName = 'Room Directory Writer'; Description = 'Peut mettre à jour l''annuaire des salles du portail (runbook de synchronisation).'; AllowedMemberTypes = @('Application') }
)
$roles = @(foreach ($definition in $roleDefinitions) {
    $existing = $app.AppRoles | Where-Object Value -eq $definition.Value | Select-Object -First 1
    $definition + @{ Id = if ($existing) { $existing.Id } else { [guid]::NewGuid().ToString() }; IsEnabled = $true }
  })
Update-MgApplication -ApplicationId $app.Id -AppRoles $roles -IdentifierUris @("api://$($app.AppId)")
$app = Get-MgApplication -ApplicationId $app.Id
$roleId = ($app.AppRoles | Where-Object Value -eq 'Room.Booker').Id
$syncRoleId = ($app.AppRoles | Where-Object Value -eq 'RoomDirectory.Write').Id

# --- 2. Enterprise app ---------------------------------------------------------------------
if (-not $app.AppId -or -not $roleId) { throw "App registration $displayName introuvable après création." }
$sp = Get-MgServicePrincipal -Filter "appId eq '$($app.AppId)'"
if (-not $sp) { $sp = Invoke-WithRetry 'Enterprise app' { New-MgServicePrincipal -AppId $app.AppId } }
Invoke-WithRetry 'Enterprise app' {
  Update-MgServicePrincipal -ServicePrincipalId $sp.Id -AppRoleAssignmentRequired:$true -Tags @('WindowsAzureActiveDirectoryIntegratedApp', 'HideApp')
}

# --- 3. Consentement administrateur openid/profile/email ----------------------------------
$grant = Get-MgOauth2PermissionGrant -Filter "clientId eq '$($sp.Id)'" -All |
  Where-Object { $_.ResourceId -eq $graphSp.Id -and $_.ConsentType -eq 'AllPrincipals' }
if (-not $grant) {
  Invoke-WithRetry 'Consentement' {
    New-MgOauth2PermissionGrant -ClientId $sp.Id -ResourceId $graphSp.Id -ConsentType 'AllPrincipals' -Scope 'openid profile email' | Out-Null
  }
}

# --- 4. Credential fédéré (Managed Identity → app registration) ---------------------------
$ficName = 'app-service-managed-identity'
$fic = Get-MgApplicationFederatedIdentityCredential -ApplicationId $app.Id | Where-Object Name -eq $ficName
if ($fic -and $fic.Subject -ne $ManagedIdentityPrincipalId) {
  # Infrastructure recréée : nouvelle Managed Identity.
  Remove-MgApplicationFederatedIdentityCredential -ApplicationId $app.Id -FederatedIdentityCredentialId $fic.Id
  $fic = $null
}
if (-not $fic) {
  New-MgApplicationFederatedIdentityCredential -ApplicationId $app.Id -BodyParameter @{
    Name      = $ficName
    Issuer    = "https://login.microsoftonline.com/$TenantId/v2.0"
    Subject   = $ManagedIdentityPrincipalId
    Audiences = @('api://AzureADTokenExchange')
  } | Out-Null
}

# --- 5. Groupe des invités du partenaire → rôle Room.Booker -------------------------------
$group = Get-MgGroup -Filter "displayName eq '$groupName'" | Select-Object -First 1
if (-not $group) {
  $group = New-MgGroup -DisplayName $groupName -SecurityEnabled -MailEnabled:$false `
    -MailNickname ($groupName -replace '[^a-zA-Z0-9]', '') `
    -Description "Invités du tenant partenaire autorisés à réserver des salles via $InstanceName."
}

$domains = $PartnerDomains | ForEach-Object { $_.ToLowerInvariant() }
$guests = @(Get-MgUser -Filter "userType eq 'Guest'" -All -Property Id, Mail, DisplayName, AccountEnabled |
    Where-Object { $_.Mail -and $_.AccountEnabled -and ($domains -contains $_.Mail.Split('@')[-1].ToLowerInvariant()) })
$members = @((Get-MgGroupMember -GroupId $group.Id -All).Id)
foreach ($guest in $guests) {
  if ($members -notcontains $guest.Id) {
    New-MgGroupMember -GroupId $group.Id -DirectoryObjectId $guest.Id
    Write-Host "  + $($guest.Mail)"
  }
}
Write-Host "$($guests.Count) invité(s) du partenaire dans $groupName."
if ($guests.Count -eq 0) { Write-Warning "Aucun invité trouvé pour les domaines : $($domains -join ', ')." }

$assigned = Get-MgServicePrincipalAppRoleAssignedTo -ServicePrincipalId $sp.Id -All | Where-Object PrincipalId -eq $group.Id
if (-not $assigned) {
  Invoke-WithRetry 'Attribution du rôle' {
    New-MgServicePrincipalAppRoleAssignedTo -ServicePrincipalId $sp.Id -PrincipalId $group.Id -ResourceId $sp.Id -AppRoleId $roleId | Out-Null
  }
}

# --- 5 bis. Identité du runbook de synchronisation des salles -----------------------------
if ($SyncPrincipalId) {
  # Droit de mettre à jour l'annuaire du portail, et seulement cela.
  $assignedSync = Get-MgServicePrincipalAppRoleAssignedTo -ServicePrincipalId $sp.Id -All | Where-Object { $_.PrincipalId -eq $SyncPrincipalId -and $_.AppRoleId -eq $syncRoleId }
  if (-not $assignedSync) {
    Invoke-WithRetry 'Rôle RoomDirectory.Write' {
      New-MgServicePrincipalAppRoleAssignedTo -ServicePrincipalId $sp.Id -PrincipalId $SyncPrincipalId -ResourceId $sp.Id -AppRoleId $syncRoleId | Out-Null
    }
  }
  # Connexion Exchange Online en mode application. Les droits effectifs viennent du groupe de rôles
  # Exchange en lecture seule créé par 02-exchange.ps1, pas de cette permission.
  $exchangeSp = Get-MgServicePrincipal -Filter "appId eq '00000002-0000-0ff1-ce00-000000000000'"
  $manageAsApp = $exchangeSp.AppRoles | Where-Object Value -eq 'Exchange.ManageAsApp'
  $syncAssignments = Get-MgServicePrincipalAppRoleAssignment -ServicePrincipalId $SyncPrincipalId -All
  if (-not ($syncAssignments | Where-Object AppRoleId -eq $manageAsApp.Id)) {
    New-MgServicePrincipalAppRoleAssignment -ServicePrincipalId $SyncPrincipalId -PrincipalId $SyncPrincipalId -ResourceId $exchangeSp.Id -AppRoleId $manageAsApp.Id | Out-Null
  }
}

# --- 6. Place.Read.All pour la Managed Identity -------------------------------------------
$placeRole = $graphSp.AppRoles | Where-Object Value -eq 'Place.Read.All'
$miAssignments = Get-MgServicePrincipalAppRoleAssignment -ServicePrincipalId $ManagedIdentityPrincipalId -All
if (-not ($miAssignments | Where-Object AppRoleId -eq $placeRole.Id)) {
  New-MgServicePrincipalAppRoleAssignment -ServicePrincipalId $ManagedIdentityPrincipalId -PrincipalId $ManagedIdentityPrincipalId `
    -ResourceId $graphSp.Id -AppRoleId $placeRole.Id | Out-Null
}
$tooBroad = $miAssignments | Where-Object { $_.ResourceId -eq $graphSp.Id -and $_.AppRoleId -ne $placeRole.Id }
if ($tooBroad) {
  Write-Warning 'La Managed Identity a d''autres permissions Graph applicatives. Calendars.* accordé dans Entra s''applique à TOUTES les boîtes : retirez-le, Exchange RBAC for Applications s''en charge.'
}

# --- 7. Accès inter-tenant : reconnaître la MFA du partenaire -----------------------------
$partner = Get-MgPolicyCrossTenantAccessPolicyPartner -CrossTenantAccessPolicyConfigurationPartnerTenantId $PartnerTenantId -ErrorAction SilentlyContinue
$inboundTrust = @{ IsMfaAccepted = $true; IsCompliantDeviceAccepted = $false; IsHybridAzureAdJoinedDeviceAccepted = $false }
if (-not $partner) {
  New-MgPolicyCrossTenantAccessPolicyPartner -TenantId $PartnerTenantId -InboundTrust $inboundTrust | Out-Null
} else {
  Update-MgPolicyCrossTenantAccessPolicyPartner -CrossTenantAccessPolicyConfigurationPartnerTenantId $PartnerTenantId -InboundTrust $inboundTrust
}

# --- 8. Accès conditionnel (rapport seulement) ---------------------------------------------
if (-not (Get-MgIdentityConditionalAccessPolicy -Filter "displayName eq '$caName'")) {
  Invoke-WithRetry 'Accès conditionnel' { New-MgIdentityConditionalAccessPolicy -BodyParameter @{
    displayName     = $caName
    state           = 'enabledForReportingButNotEnforced'
    conditions      = @{
      applications   = @{ includeApplications = @($app.AppId) }
      users          = @{ includeGroups = @($group.Id) }
      clientAppTypes = @('all')
    }
    grantControls   = @{ operator = 'OR'; builtInControls = @('mfa') }
    sessionControls = @{
      signInFrequency = @{ isEnabled = $true; type = 'hours'; value = 12; frequencyInterval = 'timeBased'; authenticationType = 'primaryAndSecondaryAuthentication' }
    }
  } | Out-Null }
  Write-Host "Stratégie $caName créée en mode rapport seulement : passez-la à « Activé » après vérification des sign-in logs."
}

# Domaine initial (*.onmicrosoft.com) : requis par Connect-ExchangeOnline -ManagedIdentity.
$organization = Invoke-MgGraphRequest -Method GET -Uri 'https://graph.microsoft.com/v1.0/organization?$select=verifiedDomains'
$initialDomain = ($organization.value[0].verifiedDomains | Where-Object { $_.isInitial } | Select-Object -First 1).name

$result = [pscustomobject]@{ ClientId = $app.AppId; GroupId = $group.Id; InitialDomain = $initialDomain }
if ($ResultPath) { $result | ConvertTo-Json | Set-Content $ResultPath -Encoding utf8 }
$result
