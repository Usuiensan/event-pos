[CmdletBinding()]
param(
  [string]$EnvironmentFile,
  [string]$NodeExe
)

$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($EnvironmentFile)) {
  $EnvironmentFile = Join-Path $PSScriptRoot 'printer-host.env'
}

if (Test-Path -LiteralPath $EnvironmentFile) {
  foreach ($line in Get-Content -LiteralPath $EnvironmentFile) {
    $trimmed = $line.Trim()
    if (-not $trimmed -or $trimmed.StartsWith('#')) { continue }
    $separator = $trimmed.IndexOf('=')
    if ($separator -lt 1) { throw "Invalid environment line (expected NAME=VALUE): $trimmed" }
    $name = $trimmed.Substring(0, $separator).Trim()
    $value = $trimmed.Substring($separator + 1).Trim()
    if ($name -notmatch '^[A-Z][A-Z0-9_]*$') { throw "Invalid environment variable name: $name" }
    [Environment]::SetEnvironmentVariable($name, $value, 'Process')
  }
}

$portableEntryPoint = Join-Path $PSScriptRoot 'dist\index.js'
if (Test-Path -LiteralPath $portableEntryPoint) {
  $applicationRoot = $PSScriptRoot
  $entryPoint = $portableEntryPoint
} else {
  $applicationRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).Path
  $entryPoint = Join-Path $applicationRoot 'apps\printer-host\dist\index.js'
}
if (-not (Test-Path -LiteralPath $entryPoint)) {
  throw "Built PrinterHost is missing. Run pnpm build at the repository root: $entryPoint"
}

$configuredNode = if ($NodeExe) { $NodeExe } elseif ($env:NODE_EXE) { $env:NODE_EXE } else { (Get-Command node.exe -ErrorAction Stop).Source }
if (-not (Test-Path -LiteralPath $configuredNode)) { throw "node.exe was not found: $configuredNode" }

Push-Location $applicationRoot
try {
  & $configuredNode $entryPoint
  exit $LASTEXITCODE
} finally {
  Pop-Location
}
