[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$DatabasePath,
  [string]$PrinterHostUrl = 'http://127.0.0.1:4318',
  [string]$ArtifactRoot,
  [string]$PosHost = '127.0.0.1',
  [int]$Port = 3000,
  [string]$NodeExe
)

$ErrorActionPreference = 'Stop'
$repositoryRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).Path
$entryPoint = Join-Path $repositoryRoot 'apps\server\dist\index.js'
if (-not (Test-Path -LiteralPath $entryPoint)) {
  throw "build済みPOS serverがありません。repository rootでpnpm buildを実行してください: $entryPoint"
}

$databaseFile = [System.IO.Path]::GetFullPath($DatabasePath, $repositoryRoot)
$databaseDirectory = Split-Path -Parent $databaseFile
if (-not (Test-Path -LiteralPath $databaseDirectory)) {
  throw "DB保存先directoryがありません: $databaseDirectory"
}
$artifactDirectory = if ($ArtifactRoot) { [System.IO.Path]::GetFullPath($ArtifactRoot, $repositoryRoot) } else { Join-Path $databaseDirectory 'artifacts' }
if (-not (Test-Path -LiteralPath $artifactDirectory)) {
  New-Item -ItemType Directory -Path $artifactDirectory | Out-Null
}

$configuredNode = if ($NodeExe) { $NodeExe } else { (Get-Command node.exe -ErrorAction Stop).Source }
if (-not (Test-Path -LiteralPath $configuredNode)) { throw "node.exeがありません: $configuredNode" }

$env:NODE_ENV = 'production'
$env:HOST = $PosHost
$env:PORT = [string]$Port
$env:POS_DATABASE_PATH = $databaseFile
$env:POS_ARTIFACT_ROOT = $artifactDirectory
$env:PRINTER_HOST_URL = $PrinterHostUrl
$env:DRAWER_ENABLED = 'false'
$env:REGISTER_WEB_DIST = Join-Path $repositoryRoot 'apps\register-web\dist'

Push-Location $repositoryRoot
try {
  & $configuredNode $entryPoint
  exit $LASTEXITCODE
} finally {
  Pop-Location
}
