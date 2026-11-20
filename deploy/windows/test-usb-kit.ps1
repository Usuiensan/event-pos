[CmdletBinding()]
param([string]$KitPath = 'E:\event-pos-usb-kit')

$ErrorActionPreference = 'Stop'
$node = Join-Path $KitPath 'runtime\node.exe'
$temp = Join-Path $env:TEMP "event-pos-usb-smoke-$([guid]::NewGuid().ToString('N'))"
New-Item -ItemType Directory -Path $temp | Out-Null

try {
  $testLocalRoot = Join-Path $temp 'recovery-local'
  $recoveryMarker = Join-Path $testLocalRoot 'EventPos\UsbKit\usb-sync-in-progress'
  New-Item -ItemType Directory -Path (Split-Path $recoveryMarker) -Force | Out-Null
  Set-Content -LiteralPath $recoveryMarker -Value 'previous run did not sync' -NoNewline
  $originalLocalAppData = $env:LOCALAPPDATA
  try {
    $env:LOCALAPPDATA = $testLocalRoot
    $recovery = & pwsh -NoProfile -ExecutionPolicy Bypass -File (Join-Path $KitPath 'start-usb-kit.ps1') 2>&1 | Out-String
    if ($LASTEXITCODE -eq 0 -or $recovery -notmatch '前回の終了時にUSBへのDB書き戻しを確認できませんでした') { throw 'USB sync recovery marker smoke failed' }
    Write-Output 'USB sync recovery marker: OK'
  } finally { $env:LOCALAPPDATA = $originalLocalAppData }

  $env:NODE_ENV = 'production'; $env:HOST = '127.0.0.1'; $env:PORT = '3047'; $env:POS_REQUIRE_HTTPS = '0'; $env:POS_REQUIRE_AUTH = '1'
  $env:POS_DATABASE_PATH = Join-Path $temp 'event.sqlite'; $env:POS_ARTIFACT_ROOT = Join-Path $temp 'artifacts'; $env:POS_ARTIFACT_MIN_FREE_BYTES = '0'
  $env:POS_EVENT_CONFIG_DIR = Join-Path $KitPath 'event-config\demo'; $env:REGISTER_WEB_DIST = Join-Path $KitPath 'web'; $env:DRAWER_ENABLED = '0'
  $server = Start-Process -FilePath $node -ArgumentList "`"$(Join-Path $KitPath 'server\dist\index.js')`"" -WorkingDirectory (Join-Path $KitPath 'server') -PassThru -WindowStyle Hidden -RedirectStandardOutput (Join-Path $temp 'server.out') -RedirectStandardError (Join-Path $temp 'server.err')
  $ready = $false
  for ($i = 0; $i -lt 30; $i++) {
    $server.Refresh(); if ($server.HasExited) { break }
    try { if ((Invoke-WebRequest -Uri 'http://127.0.0.1:3047/health/live' -TimeoutSec 2).StatusCode -eq 200) { $ready = $true; break } } catch { Start-Sleep -Seconds 1 }
  }
  if (-not $ready) { Get-Content (Join-Path $temp 'server.err') -ErrorAction SilentlyContinue; throw 'Portable POS server smoke failed' }
  $page = Invoke-WebRequest -Uri 'http://127.0.0.1:3047/?register=1&role=staff'
  if ($page.StatusCode -ne 200 -or $page.Content -notmatch 'assets/index-') { throw 'Portable web asset smoke failed' }
  Write-Output 'Portable POS server and web assets: OK'
  Stop-Process -Id $server.Id -Force; Wait-Process -Id $server.Id -ErrorAction SilentlyContinue

  $env:PORT = '4319'; $env:PRINTER_BACKEND = 'windows-spooler'; $env:PRINTER_NAME = 'Generic / Text Only'; $env:PRINTER_STATUS_BACKEND = 'dle-eot'
  $printer = Start-Process -FilePath $node -ArgumentList "`"$(Join-Path $KitPath 'printer-host\dist\index.js')`"" -WorkingDirectory (Join-Path $KitPath 'printer-host') -PassThru -WindowStyle Hidden -RedirectStandardOutput (Join-Path $temp 'printer.out') -RedirectStandardError (Join-Path $temp 'printer.err')
  $ready = $false
  for ($i = 0; $i -lt 20; $i++) {
    $printer.Refresh(); if ($printer.HasExited) { break }
    try { if ((Invoke-WebRequest -Uri 'http://127.0.0.1:4319/health/live' -TimeoutSec 2).StatusCode -eq 200) { $ready = $true; break } } catch { Start-Sleep -Seconds 1 }
  }
  if (-not $ready) { Get-Content (Join-Path $temp 'printer.err') -ErrorAction SilentlyContinue; throw 'Portable PrinterHost smoke failed' }
  Write-Output 'Portable PrinterHost: OK'
} finally {
  if ($server -and -not $server.HasExited) { Stop-Process -Id $server.Id -Force -ErrorAction SilentlyContinue; Wait-Process -Id $server.Id -ErrorAction SilentlyContinue }
  if ($printer -and -not $printer.HasExited) { Stop-Process -Id $printer.Id -Force -ErrorAction SilentlyContinue; Wait-Process -Id $printer.Id -ErrorAction SilentlyContinue }
  Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction SilentlyContinue
}
