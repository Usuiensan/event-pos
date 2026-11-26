param([switch]$Lan)

$ErrorActionPreference = 'Stop'
if ($Lan) { $env:EVENT_POS_LAN = '1' }
& (Join-Path $PSScriptRoot 'runtime\node.exe') (Join-Path $PSScriptRoot 'server\dist\start.mjs')
exit $LASTEXITCODE
