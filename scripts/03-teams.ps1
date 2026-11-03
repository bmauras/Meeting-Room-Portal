<#
.SYNOPSIS
  Stratégie de réunion Teams pour la boîte organisatrice d'une installation du Meeting Room Portal (idempotent).

.DESCRIPTION
  L'organisateur des réunions est un compte de service qui ne rejoint jamais les réunions :
  personne ne pourrait admettre les participants depuis la salle d'attente. Cette stratégie
  laisse entrer directement les personnes invitées et leur donne le rôle de présentateur.
  Normalement appelé par deploy.ps1.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory)] [string] $TenantId,
  [Parameter(Mandatory)] [string] $OrganizerUpn,
  [string] $InstanceName = 'MeetingRoomPortal'
)

$ErrorActionPreference = 'Stop'
#Requires -Modules MicrosoftTeams

$policyName = "$InstanceName-Organizer"

Connect-MicrosoftTeams -TenantId $TenantId | Out-Null
if ((Get-CsTenant).TenantId -ne $TenantId) { throw "Session Teams ouverte sur un autre tenant que $TenantId." }

$settings = @{
  AutoAdmittedUsers                 = 'InvitedUsers'
  DesignatedPresenterRoleMode       = 'EveryoneUserOverride'
  AllowPSTNUsersToBypassLobby       = $false
  AllowCloudRecording               = $false
  AllowTranscription                = $false
  AllowAnonymousUsersToStartMeeting = $false
}

if (Get-CsTeamsMeetingPolicy -Identity $policyName -ErrorAction SilentlyContinue) {
  Set-CsTeamsMeetingPolicy -Identity $policyName @settings
} else {
  New-CsTeamsMeetingPolicy -Identity $policyName @settings | Out-Null
}
Grant-CsTeamsMeetingPolicy -Identity $OrganizerUpn -PolicyName $policyName
Write-Host "Stratégie $policyName attribuée à $OrganizerUpn (prise en compte sous quelques heures)."
