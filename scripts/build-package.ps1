<#
.SYNOPSIS
  Construit le paquet de déploiement (app.zip) : front compilé + serveur compilé + dépendances de production.
  Utilisé par deploy.ps1 et par le pipeline CI. Retourne le chemin du paquet.
#>
[CmdletBinding()]
param(
  [string] $OutputPath,
  [switch] $SkipTests
)

$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
if (-not $OutputPath) { $OutputPath = Join-Path $root 'app.zip' }
$OutputPath = [IO.Path]::GetFullPath($OutputPath)

function Invoke-Npm([string] $directory, [string[]] $NpmArgs) {
  Push-Location $directory
  try {
    & npm @NpmArgs --no-audit --no-fund | Out-Host
    if ($LASTEXITCODE -ne 0) { throw "npm $($NpmArgs -join ' ') a échoué dans $directory" }
  } finally {
    Pop-Location
  }
}

$web = Join-Path $root 'web'
$server = Join-Path $root 'server'

Invoke-Npm $web @('ci')
Invoke-Npm $web @('run', 'build')
Invoke-Npm $server @('ci')
if (-not $SkipTests) { Invoke-Npm $server @('test') }
Invoke-Npm $server @('run', 'build')

$staging = Join-Path ([IO.Path]::GetTempPath()) "roomportal-$([guid]::NewGuid())"
New-Item -ItemType Directory $staging | Out-Null
try {
  Copy-Item (Join-Path $server 'dist') (Join-Path $staging 'dist') -Recurse
  Copy-Item (Join-Path $server 'package.json'), (Join-Path $server 'package-lock.json') $staging
  Copy-Item (Join-Path $web 'dist') (Join-Path $staging 'public') -Recurse
  # Sans liens symboliques (.bin) pour une archive portable Windows → Linux.
  Invoke-Npm $staging @('ci', '--omit=dev', '--ignore-scripts', '--no-bin-links')

  if (Test-Path $OutputPath) { Remove-Item $OutputPath -Force }
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  [IO.Compression.ZipFile]::CreateFromDirectory($staging, $OutputPath)
} finally {
  Remove-Item $staging -Recurse -Force
}

Write-Host "Paquet : $OutputPath ($([math]::Round((Get-Item $OutputPath).Length / 1MB, 1)) Mo)"
$OutputPath
