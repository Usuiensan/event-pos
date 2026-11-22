$ErrorActionPreference = 'Stop'
try {
  $localRoot = Join-Path $env:LOCALAPPDATA 'EventPos\UsbKit'
  $localData = Join-Path $localRoot 'data'
  $localDb = Join-Path $localData 'event-pos.sqlite'
  $marker = Join-Path $localRoot 'usb-sync-in-progress'

  if (-not (Test-Path -LiteralPath $marker)) {
    Write-Host '同期マーカーがありません。前回の終了は正常だったようです（復旧は不要です）。'
    exit 0
  }
  if (-not (Test-Path -LiteralPath $localDb)) {
    throw "ローカルDBが見つかりません: $localDb（このPCには復旧できるDBがありません）"
  }

  $kit = $null
  foreach ($drive in [System.IO.DriveInfo]::GetDrives()) {
    if (-not $drive.IsReady) { continue }
    $candidate = Join-Path $drive.RootDirectory.FullName 'event-pos-usb-kit'
    if ((Test-Path -LiteralPath (Join-Path $candidate 'data\event-pos.sqlite')) -and (Test-Path -LiteralPath (Join-Path $candidate 'start-usb-kit.ps1'))) { $kit = $candidate; break }
  }
  if (-not $kit) { throw 'USBキットが見つかりません。USBを挿してから実行してください。' }
  $usbDb = Join-Path $kit 'data\event-pos.sqlite'

  $runtimePrefix = Join-Path $kit 'runtime'
  $running = @()
  foreach ($proc in (Get-Process -Name node -ErrorAction SilentlyContinue)) {
    $procPath = $null
    try { $procPath = $proc.Path } catch { }
    if ($procPath -and $procPath.StartsWith($runtimePrefix, [System.StringComparison]::OrdinalIgnoreCase)) { $running += $proc }
  }
  if ($running.Count -gt 0) { throw 'キットのPOSが起動中です。先にPOSを終了してから実行してください。' }

  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  $desktop = [Environment]::GetFolderPath('Desktop')
  $bak = Join-Path $desktop "eventpos-backup-$stamp"
  New-Item -ItemType Directory -Force (Join-Path $bak 'local'), (Join-Path $bak 'usb') | Out-Null
  foreach ($s in @('', '-wal', '-shm')) {
    $l = "$localDb$s"; $u = "$usbDb$s"
    if (Test-Path -LiteralPath $l) { Copy-Item -LiteralPath $l -Destination (Join-Path $bak "local\event-pos.sqlite$s") -Force }
    if (Test-Path -LiteralPath $u) { Copy-Item -LiteralPath $u -Destination (Join-Path $bak "usb\event-pos.sqlite$s") -Force }
  }
  Write-Host "バックアップを作成しました: $bak"

  foreach ($s in @('', '-wal', '-shm')) {
    $l = "$localDb$s"; $u = "$usbDb$s"
    if (Test-Path -LiteralPath $l) { Copy-Item -LiteralPath $l -Destination $u -Force }
    elseif (Test-Path -LiteralPath $u) { Remove-Item -LiteralPath $u -Force }
  }

  foreach ($s in @('', '-wal', '-shm')) {
    $l = "$localDb$s"; $u = "$usbDb$s"
    if ((Test-Path -LiteralPath $l) -and (Test-Path -LiteralPath $u)) {
      if ((Get-FileHash -LiteralPath $l -Algorithm SHA256).Hash -ne (Get-FileHash -LiteralPath $u -Algorithm SHA256).Hash) {
        throw "書き戻し後の照合に失敗しました: event-pos.sqlite$s（マーカーは残してあります。バックアップ: $bak）"
      }
    }
  }

  Remove-Item -LiteralPath $marker -Force
  Write-Host "復旧が完了しました: ローカルDBをUSBへ書き戻しました: $usbDb"
  Write-Host '次は通常どおりキットを起動できます。'
  exit 0
} catch {
  Write-Host "復旧できませんでした: $($_.Exception.Message)"
  exit 1
}
