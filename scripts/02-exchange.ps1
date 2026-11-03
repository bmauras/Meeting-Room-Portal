<#
.SYNOPSIS
  Configure Exchange Online pour une installation du Meeting Room Portal (idempotent).

.DESCRIPTION
  1. Marque la boîte organisatrice (attribut personnalisé) pour l'inclure dans le périmètre.
  2. Contrôle (et corrige avec -FixRoomProcessing) le traitement automatique des salles.
  3. Exchange RBAC for Applications : la Managed Identity reçoit « Application Calendars.ReadWrite »
     UNIQUEMENT sur les boîtes de salle et la boîte organisatrice.

  La propagation des droits RBAC for Applications peut prendre de 30 minutes à 2 heures.
  Normalement appelé par deploy.ps1.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory)] [string] $TenantId,
  [Parameter(Mandatory)] [string] $OrganizerUpn,
  [Parameter(Mandatory)] [string] $ManagedIdentityClientId,
  [Parameter(Mandatory)] [string] $ManagedIdentityPrincipalId,
  [string] $InstanceName = 'MeetingRoomPortal',
  [ValidateRange(1, 15)] [int] $OrganizerAttributeNumber = 15,
  [switch] $FixRoomProcessing
)

$ErrorActionPreference = 'Stop'
#Requires -Modules ExchangeOnlineManagement

$scopeName = "$InstanceName-Scope"
$assignmentName = "$InstanceName-Calendars"
$attribute = "CustomAttribute$OrganizerAttributeNumber"

Connect-ExchangeOnline -ShowBanner:$false

# --- 0. Bon tenant ? -----------------------------------------------------------------------
$connection = Get-ConnectionInformation | Where-Object State -eq 'Connected' | Select-Object -First 1
if ($connection.TenantID -and $connection.TenantID -ne $TenantId) {
  throw "Session Exchange ouverte sur le tenant $($connection.TenantID) au lieu de $TenantId."
}
$organizerDomain = $OrganizerUpn.Split('@')[-1]
if (-not (Get-AcceptedDomain | Where-Object DomainName -eq $organizerDomain)) {
  throw "Le domaine $organizerDomain n'est pas un domaine accepté de ce tenant Exchange."
}

# --- 1. Boîte organisatrice ----------------------------------------------------------------
$organizer = Get-Mailbox -Identity $OrganizerUpn
if ($organizer.RecipientTypeDetails -ne 'UserMailbox') {
  throw "$OrganizerUpn doit être une boîte UTILISATEUR licenciée (Exchange + Teams) pour générer des réunions Teams. Type actuel : $($organizer.RecipientTypeDetails)"
}
$current = $organizer.$attribute
if ($current -and $current -ne $InstanceName) {
  throw "$attribute de $OrganizerUpn contient déjà « $current ». Choisissez un autre attribut avec -OrganizerAttributeNumber."
}
$setParams = @{ Identity = $OrganizerUpn; $attribute = $InstanceName }
Set-Mailbox @setParams

# --- 2. Traitement automatique des salles ----------------------------------------------------
$rooms = @(Get-Mailbox -RecipientTypeDetails RoomMailbox -ResultSize Unlimited)
if ($rooms.Count -eq 0) { Write-Warning 'Aucune boîte de salle dans ce tenant.' }
$report = foreach ($room in $rooms) {
  $cp = Get-CalendarProcessing -Identity $room.Identity
  $organizerAllowed = $cp.AllBookInPolicy -or ($cp.BookInPolicy -contains $organizer.LegacyExchangeDN) -or ($cp.BookInPolicy -match [regex]::Escape($OrganizerUpn))
  $ok = $cp.AutomateProcessing -eq 'AutoAccept' -and -not $cp.AllowConflicts -and $organizerAllowed

  if (-not $ok -and $FixRoomProcessing) {
    $params = @{ Identity = $room.Identity; AutomateProcessing = 'AutoAccept'; AllowConflicts = $false }
    if (-not $organizerAllowed) { $params.BookInPolicy = @($cp.BookInPolicy) + $OrganizerUpn }
    Set-CalendarProcessing @params
    $ok = $true
  }

  [pscustomobject]@{
    Salle           = $room.DisplayName
    Email           = $room.PrimarySmtpAddress
    AutoAccept      = $cp.AutomateProcessing
    Conflits        = $cp.AllowConflicts
    OrganisateurOK  = $organizerAllowed
    FenetreJours    = $cp.BookingWindowInDays
    DureeMaxMinutes = $cp.MaximumDurationInMinutes
    Pret            = $ok
  }
}
$report | Format-Table -AutoSize | Out-Host
$notReady = @($report | Where-Object { -not $_.Pret })
if ($notReady.Count -gt 0) {
  Write-Warning "$($notReady.Count) salle(s) ne confirmeront pas automatiquement les réservations du portail. Relancez avec -FixRoomProcessing ou corrigez-les manuellement."
}

# --- 3. RBAC for Applications -------------------------------------------------------------
if (-not (Get-ServicePrincipal -Identity $ManagedIdentityPrincipalId -ErrorAction SilentlyContinue)) {
  New-ServicePrincipal -AppId $ManagedIdentityClientId -ObjectId $ManagedIdentityPrincipalId -DisplayName "$InstanceName (Managed Identity)" | Out-Null
}

$filter = "(RecipientTypeDetails -eq 'RoomMailbox') -or ($attribute -eq '$InstanceName')"
if (Get-ManagementScope -Identity $scopeName -ErrorAction SilentlyContinue) {
  Set-ManagementScope -Identity $scopeName -RecipientRestrictionFilter $filter
} else {
  New-ManagementScope -Name $scopeName -RecipientRestrictionFilter $filter | Out-Null
}

# Le nom de l'attribution porte l'identité : si l'infrastructure est recréée (nouvelle Managed
# Identity), les attributions de l'ancienne sont retirées.
$currentAssignment = "$assignmentName-$($ManagedIdentityPrincipalId.Substring(0, 8))"
Get-ManagementRoleAssignment -Role 'Application Calendars.ReadWrite' |
  Where-Object { $_.Name -like "$assignmentName-*" -and $_.Name -ne $currentAssignment } |
  ForEach-Object {
    Write-Host "Retrait de l'attribution obsolète $($_.Name)"
    Remove-ManagementRoleAssignment -Identity $_.Name -Confirm:$false
  }
if (-not (Get-ManagementRoleAssignment -Identity $currentAssignment -ErrorAction SilentlyContinue)) {
  New-ManagementRoleAssignment -Name $currentAssignment -App $ManagedIdentityPrincipalId -Role 'Application Calendars.ReadWrite' -CustomResourceScope $scopeName | Out-Null
}

Write-Host ''
Write-Host 'Vérification (peut indiquer « false » tant que la propagation n''est pas terminée) :'
Test-ServicePrincipalAuthorization -Identity $ManagedIdentityPrincipalId -Resource $OrganizerUpn | Format-Table RoleName, InScope -AutoSize | Out-Host
if ($rooms.Count -gt 0) {
  Test-ServicePrincipalAuthorization -Identity $ManagedIdentityPrincipalId -Resource $rooms[0].PrimarySmtpAddress | Format-Table RoleName, InScope -AutoSize | Out-Host
}
