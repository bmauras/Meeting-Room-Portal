<#
.SYNOPSIS
  Relève les boîtes de salle dans Exchange Online et transmet l'annuaire au portail.

.DESCRIPTION
  Exécuté par Azure Automation toutes les 15 minutes (publié par scripts/deploy.ps1).
  - Connexion à Exchange avec l'identité managée dédiée, limitée au rôle « View-Only Recipients ».
  - Envoi au portail avec un jeton Entra ID émis pour cette identité (rôle RoomDirectory.Write).
  Une salle ajoutée ou supprimée dans Exchange est ainsi visible dans le portail en 15 minutes au plus.
#>
$ErrorActionPreference = 'Stop'
$PSDefaultParameterValues['*:ErrorAction'] = 'Stop'

$portalUrl = (Get-AutomationVariable -Name 'PortalUrl').TrimEnd('/')
$audience = Get-AutomationVariable -Name 'PortalAudience'
$organization = Get-AutomationVariable -Name 'ExchangeOrganization'
$clientId = Get-AutomationVariable -Name 'IdentityClientId'
if (-not $audience -or -not $organization) { throw 'Variables PortalAudience / ExchangeOrganization non renseignées : relancez scripts/deploy.ps1.' }

function Get-Text($value) { if ($null -ne $value -and "$value".Trim()) { "$value".Trim() } else { $null } }

Connect-ExchangeOnline -ManagedIdentity -ManagedIdentityAccountId $clientId -Organization $organization -ShowBanner:$false
try {
  # Détails des salles (bâtiment, étage, équipements) : un seul appel pour toutes les salles.
  # Facultatif : sans ce droit, seuls le nom et la capacité sont transmis.
  $places = @{}
  try {
    foreach ($place in Get-Place -Type Room -ResultSize Unlimited) {
      $places["$($place.Identity)".ToLowerInvariant()] = $place
    }
  } catch {
    Write-Warning "Détails des salles indisponibles (Get-Place) : $($_.Exception.Message)"
  }

  $rooms = @(Get-Mailbox -RecipientTypeDetails RoomMailbox -ResultSize Unlimited | ForEach-Object {
      $email = $_.PrimarySmtpAddress.ToString().ToLowerInvariant()
      $place = $places[$email]
      if (-not $place) { $place = $places["$($_.Identity)".ToLowerInvariant()] }
      if (-not $place) { $place = $places["$($_.Alias)".ToLowerInvariant()] }
      $capacity = [int]"0$($_.ResourceCapacity)"
      $room = [ordered]@{
        email    = $email
        name     = $_.DisplayName
        capacity = if ($capacity -gt 0) { $capacity } else { $null }
      }
      if ($place) {
        $room.building = Get-Text $place.Building
        $floor = Get-Text $place.FloorLabel
        if (-not $floor) { $floor = Get-Text $place.Floor }
        $room.floor = $floor
        $room.accessible = [bool]$place.IsWheelChairAccessible
        $room.hasVideo = [bool](Get-Text $place.VideoDeviceName)
        $room.hasDisplay = [bool](Get-Text $place.DisplayDeviceName)
      }
      $room
    })
} finally {
  Disconnect-ExchangeOnline -Confirm:$false
}

$identity = Invoke-RestMethod -Headers @{ 'X-IDENTITY-HEADER' = $env:IDENTITY_HEADER } `
  -Uri "$($env:IDENTITY_ENDPOINT)?resource=$([uri]::EscapeDataString($audience))&client_id=$clientId&api-version=2019-08-01"

$body = @{ rooms = $rooms } | ConvertTo-Json -Depth 4 -Compress
$result = Invoke-RestMethod -Method Post -Uri "$portalUrl/api/internal/room-directory" `
  -Headers @{ Authorization = "Bearer $($identity.access_token)" } `
  -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes($body))

Write-Output "$($result.count) salle(s) transmise(s) au portail : $($result.added) ajoutée(s), $($result.updated) modifiée(s), $($result.removed) retirée(s)."
