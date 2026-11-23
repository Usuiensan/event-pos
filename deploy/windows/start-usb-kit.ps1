$ErrorActionPreference = 'Stop'
& (Join-Path $PSScriptRoot 'runtime\node.exe') (Join-Path $PSScriptRoot 'server\dist\start.mjs')
exit $LASTEXITCODE
