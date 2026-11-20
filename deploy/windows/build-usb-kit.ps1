[CmdletBinding()]
param([string]$OutputDirectory = 'E:\event-pos-usb-kit')

$ErrorActionPreference = 'Stop'
$repositoryRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).Path
$target = if ([System.IO.Path]::IsPathRooted($OutputDirectory)) { [System.IO.Path]::GetFullPath($OutputDirectory) } else { [System.IO.Path]::GetFullPath((Join-Path $repositoryRoot $OutputDirectory)) }
$marker = Join-Path $target '.event-pos-usb-kit'
if (Test-Path -LiteralPath $target) {
  if (-not (Test-Path -LiteralPath $marker) -or (Get-Content -LiteralPath $marker -Raw).Trim() -notin @('INCOMPLETE generated USB kit; managed by build-usb-kit.ps1.', 'event-pos USB kit output; built by deploy/windows/build-usb-kit.ps1.')) { throw "既存フォルダーはUSBキットのビルド出力ではありません: $target" }
} else { New-Item -ItemType Directory -Path $target | Out-Null }
$stageRoot = Join-Path $env:TEMP "event-pos-usb-stage-$([guid]::NewGuid().ToString('N'))"
$stageServerDist = Join-Path $stageRoot 'server\dist'
$stagePrinterDist = Join-Path $stageRoot 'printer-host\dist'
$stageInitializer = Join-Path $stageRoot 'server\dist\initialize-usb-db.js'
$stagePrinterScripts = Join-Path $stageRoot 'printer-host\scripts'
$node = (Get-Command node.exe -ErrorAction Stop).Source
$nodeVersion = & $node --version
if ($LASTEXITCODE -ne 0 -or [int]([regex]::Match($nodeVersion, '^v(\d+)').Groups[1].Value) -lt 24) { throw "Node.js 24以降が必要です: $nodeVersion" }

Push-Location $repositoryRoot
try {
  & pnpm build
  if ($LASTEXITCODE -ne 0) { throw "pnpm build failed: $LASTEXITCODE" }
  $esbuildPackage = Get-ChildItem -LiteralPath (Join-Path $repositoryRoot 'node_modules\.pnpm') -Directory -Filter 'esbuild@*' | Select-Object -First 1
  if (-not $esbuildPackage) { throw 'esbuildがnode_modulesにありません。先にpnpm installを実行してください。' }
  $esbuildCli = Join-Path $esbuildPackage.FullName 'node_modules\esbuild\bin\esbuild'
  $serverBundle = "--outfile=$(Join-Path $stageServerDist 'index.js')"
  $printerBundle = "--outfile=$(Join-Path $stagePrinterDist 'index.js')"
  $requireBanner = "--banner:js=import{createRequire}from'node:module';const require=createRequire(import.meta.url);"
  New-Item -ItemType Directory -Path $stageServerDist, $stagePrinterDist -Force | Out-Null
  & $node $esbuildCli apps/server/src/index.ts --bundle --platform=node --format=esm --target=node24 $requireBanner $serverBundle
  if ($LASTEXITCODE -ne 0) { throw "POS serverのbundleに失敗しました: $LASTEXITCODE" }
  & $node $esbuildCli apps/printer-host/src/index.ts --bundle --platform=node --format=esm --target=node24 --external:usb $requireBanner $printerBundle
  if ($LASTEXITCODE -ne 0) { throw "PrinterHostのbundleに失敗しました: $LASTEXITCODE" }
  & $node $esbuildCli apps/server/src/initialize-usb-db.ts --bundle --platform=node --format=esm --target=node24 $requireBanner "--outfile=$stageInitializer"
  if ($LASTEXITCODE -ne 0) { throw "初期DBセットアップのbundleに失敗しました: $LASTEXITCODE" }
  Copy-Item -LiteralPath (Join-Path $repositoryRoot 'apps\printer-host\scripts') -Destination (Join-Path $stageRoot 'printer-host') -Recurse
  New-Item -ItemType Directory -Path (Join-Path $target 'server\dist'), (Join-Path $target 'printer-host\dist'), (Join-Path $target 'printer-host\scripts'), (Join-Path $target 'runtime'), (Join-Path $target 'web'), (Join-Path $target 'data') -Force | Out-Null
  Copy-Item -LiteralPath (Join-Path $stageServerDist 'index.js') -Destination (Join-Path $target 'server\dist\index.js') -Force
  Copy-Item -LiteralPath $stageInitializer -Destination (Join-Path $target 'server\dist\initialize-usb-db.js') -Force
  Copy-Item -LiteralPath (Join-Path $stagePrinterDist 'index.js') -Destination (Join-Path $target 'printer-host\dist\index.js') -Force
  Get-ChildItem -LiteralPath $stagePrinterScripts -Force | Copy-Item -Destination (Join-Path $target 'printer-host\scripts') -Recurse -Force
  Copy-Item -LiteralPath $node -Destination (Join-Path $target 'runtime\node.exe') -Force
  Get-ChildItem -LiteralPath (Join-Path $repositoryRoot 'apps\register-web\dist') -Force | Copy-Item -Destination (Join-Path $target 'web') -Recurse -Force
  $sourceEventConfig = Join-Path $repositoryRoot 'event-config'
  $targetEventConfig = Join-Path $target 'event-config'
  Get-ChildItem -LiteralPath $sourceEventConfig -Force | Where-Object Name -ne 'usb-kit-initial' | Copy-Item -Destination $targetEventConfig -Recurse -Force
  $targetInitialConfig = Join-Path $targetEventConfig 'usb-kit-initial'
  if (-not (Test-Path -LiteralPath $targetInitialConfig)) { Copy-Item -LiteralPath (Join-Path $sourceEventConfig 'usb-kit-initial') -Destination $targetEventConfig -Recurse -Force }
  Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'initialize-usb-kit.ps1') -Destination $target -Force
  Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'start-usb-kit.ps1') -Destination $target -Force
  Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'Start-USB-Kit.bat') -Destination $target -Force
  Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'update-usb-kit.ps1') -Destination $target -Force
  Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'Update-USB-Kit.bat') -Destination $target -Force
  Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'usb-kit-printer-host.env') -Destination (Join-Path $target 'printer-host.env') -Force
  Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'usb-kit-README.md') -Destination (Join-Path $target 'README.md') -Force
  Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'usb-kit-marker.txt') -Destination $marker -Force
  Write-Output "USBキットを作成しました: $target"
} finally {
  Pop-Location
  if (Test-Path -LiteralPath $stageRoot) {
    $resolvedStage = (Resolve-Path -LiteralPath $stageRoot).Path
    if ($resolvedStage.StartsWith([System.IO.Path]::GetFullPath($env:TEMP) + [System.IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { Remove-Item -LiteralPath $resolvedStage -Recurse -Force }
  }
}
