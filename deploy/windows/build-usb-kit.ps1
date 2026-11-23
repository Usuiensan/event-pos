[CmdletBinding()]
param([string]$OutputDirectory = 'E:\event-pos-usb-kit')

$ErrorActionPreference = 'Stop'
$repositoryRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).Path
$node = (Get-Command node.exe -ErrorAction Stop).Source
$nodeVersion = & $node --version
if ($LASTEXITCODE -ne 0 -or [int]([regex]::Match($nodeVersion, '^v(\d+)').Groups[1].Value) -lt 24) { throw "Node.js 24以降が必要です: $nodeVersion" }

Push-Location $repositoryRoot
try {
  & pnpm build
  if ($LASTEXITCODE -ne 0) { throw "pnpm build failed: $LASTEXITCODE" }
  & $node deploy/usb-kit/build.mjs windows $OutputDirectory $node
  if ($LASTEXITCODE -ne 0) { throw "USBキットの作成に失敗しました: $LASTEXITCODE" }
} finally { Pop-Location }
