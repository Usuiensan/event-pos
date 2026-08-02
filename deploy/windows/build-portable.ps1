[CmdletBinding()]
param([Parameter(Mandatory = $true)][string]$OutputDirectory)

$ErrorActionPreference = 'Stop'
$repositoryRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).Path
$target = [System.IO.Path]::GetFullPath($OutputDirectory, $repositoryRoot)
if (Test-Path -LiteralPath $target) { throw "OutputDirectory already exists: $target" }

Push-Location $repositoryRoot
try {
  & pnpm build
  if ($LASTEXITCODE -ne 0) { throw "pnpm build failed: $LASTEXITCODE" }
  & pnpm --filter '@event-pos/printer-host' deploy $target --prod
  if ($LASTEXITCODE -ne 0) { throw "pnpm deploy failed: $LASTEXITCODE" }
  Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'start-printer-host.ps1') -Destination $target
  Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'event-pos-printer-host.xml') -Destination $target
  Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'printer-host.env.example') -Destination $target
  Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'README.md') -Destination (Join-Path $target 'WINDOWS-README.md')
  Write-Output "Portable PrinterHost created: $target"
} finally {
  Pop-Location
}
