$ErrorActionPreference = 'Stop'
$kit = $PSScriptRoot
if ($PSVersionTable.PSVersion -lt [version]'5.1') { throw 'Windows USBキットにはWindows PowerShell 5.1以降が必要です。Windows 10以降のWindows PowerShellを使用してください。' }
$localRoot = Join-Path $env:LOCALAPPDATA 'EventPos\UsbKit'
$syncMarker = Join-Path $localRoot 'usb-sync-in-progress'
if (Test-Path -LiteralPath $syncMarker) { throw "前回の終了時にUSBへのDB書き戻しを確認できませんでした。ローカルDBを保持しています: $(Join-Path $localRoot 'data\event-pos.sqlite')" }
$node = Join-Path $kit 'runtime\node.exe'
$usbData = Join-Path $kit 'data\event-pos.sqlite'
if (-not (Test-Path -LiteralPath $node)) { throw "Portable Nodeがありません: $node" }
if (-not (Test-Path -LiteralPath $usbData)) { & (Join-Path $kit 'initialize-usb-kit.ps1') }
if (-not (Test-Path -LiteralPath $usbData)) { throw "初期セットアップ後もUSB上にDBがありません: $usbData" }

$localData = Join-Path $localRoot 'data'
$localDb = Join-Path $localData 'event-pos.sqlite'
$logRoot = Join-Path $localRoot 'logs'
New-Item -ItemType Directory -Path $localData, $logRoot, (Join-Path $localRoot 'artifacts') -Force | Out-Null
foreach ($suffix in @('', '-wal', '-shm')) {
  $source = "$usbData$suffix"
  $destination = "$localDb$suffix"
  if (Test-Path -LiteralPath $source) { Copy-Item -LiteralPath $source -Destination $destination -Force }
  elseif (Test-Path -LiteralPath $destination) { Remove-Item -LiteralPath $destination -Force }
}

foreach ($line in Get-Content -LiteralPath (Join-Path $kit 'printer-host.env')) {
  $trimmed = $line.Trim()
  if (-not $trimmed -or $trimmed.StartsWith('#')) { continue }
  $separator = $trimmed.IndexOf('=')
  if ($separator -lt 1) { throw "printer-host.envの形式が不正です: $trimmed" }
  [Environment]::SetEnvironmentVariable($trimmed.Substring(0, $separator).Trim(), $trimmed.Substring($separator + 1).Trim(), 'Process')
}

$printer = $null
$server = $null
Set-Content -LiteralPath $syncMarker -Value "USB DB同期開始 $(Get-Date -Format o)" -NoNewline
try {
  $printerEntry = Join-Path $kit 'printer-host\dist\index.js'
  $serverEntry = Join-Path $kit 'server\dist\index.js'
  if (-not (Test-Path -LiteralPath $printerEntry) -or -not (Test-Path -LiteralPath $serverEntry)) { throw 'USBキットの実行ファイルが不足しています。' }
  New-Item -ItemType Directory -Path (Join-Path $localRoot 'logs') -Force | Out-Null
  $env:NODE_ENV = 'production'
  $printer = Start-Process -FilePath $node -ArgumentList "`"$printerEntry`"" -WorkingDirectory (Join-Path $kit 'printer-host') -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $logRoot 'printer-host.out.log') -RedirectStandardError (Join-Path $logRoot 'printer-host.err.log')
  $printerReady = $false
  for ($attempt = 0; $attempt -lt 30; $attempt++) {
    if ($printer.HasExited) { throw "PrinterHostが起動できません。ログを確認してください: $logRoot" }
    try { if ((Invoke-WebRequest -Uri 'http://127.0.0.1:4318/health/live' -TimeoutSec 2).StatusCode -eq 200) { $printerReady = $true; break } } catch { Start-Sleep -Seconds 1 }
  }
  if (-not $printerReady) { throw "PrinterHostの起動を確認できません。ログを確認してください: $logRoot" }

  $env:HOST = '127.0.0.1'
  $env:PORT = '3000'
  $env:POS_REQUIRE_HTTPS = '0'
  $env:POS_REQUIRE_AUTH = '1'
  $env:POS_DATABASE_PATH = $localDb
  $env:POS_ARTIFACT_ROOT = Join-Path $localRoot 'artifacts'
  $env:POS_EVENT_CONFIG_DIR = Join-Path $kit 'event-config\usb-kit-initial'
  $env:REGISTER_WEB_DIST = Join-Path $kit 'web'
  $env:PRINTER_HOST_URL = 'http://127.0.0.1:4318'
  $env:DRAWER_ENABLED = '0'
  $server = Start-Process -FilePath $node -ArgumentList "`"$serverEntry`"" -WorkingDirectory (Join-Path $kit 'server') -PassThru -RedirectStandardOutput (Join-Path $logRoot 'server.out.log') -RedirectStandardError (Join-Path $logRoot 'server.err.log')

  $ready = $false
  for ($attempt = 0; $attempt -lt 90; $attempt++) {
    if ($server.HasExited) { throw "POS serverが起動できません。ログを確認してください: $logRoot" }
    try { if ((Invoke-WebRequest -Uri 'http://127.0.0.1:3000/health/live' -TimeoutSec 2).StatusCode -eq 200) { $ready = $true; break } } catch { Start-Sleep -Seconds 1 }
  }
  if (-not $ready) { throw "POS serverの起動を確認できません。ログを確認してください: $logRoot" }
  Start-Process 'http://127.0.0.1:3000/?register=1&role=staff'
  Write-Host 'POSを起動しました。終了するにはこの画面で Ctrl+C を押してください。'
  while (-not $server.HasExited) { Start-Sleep -Milliseconds 500; $server.Refresh() }
  if ($server.ExitCode -ne 0) { throw "POS serverが異常終了しました。終了コード: $($server.ExitCode)" }
} finally {
  if ($server -and -not $server.HasExited) { Stop-Process -Id $server.Id -Force -ErrorAction SilentlyContinue; Wait-Process -Id $server.Id -ErrorAction SilentlyContinue }
  if ($printer -and -not $printer.HasExited) { Stop-Process -Id $printer.Id -Force -ErrorAction SilentlyContinue }
  foreach ($suffix in @('', '-wal', '-shm')) {
    $source = "$localDb$suffix"
    $destination = "$usbData$suffix"
    if (Test-Path -LiteralPath $source) { Copy-Item -LiteralPath $source -Destination $destination -Force }
    elseif (Test-Path -LiteralPath $destination) { Remove-Item -LiteralPath $destination -Force }
  }
  Remove-Item -LiteralPath $syncMarker -Force
  Write-Host "DBをUSBへ書き戻しました: $usbData"
}
