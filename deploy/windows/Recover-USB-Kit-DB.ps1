$ErrorActionPreference = 'Stop'
function Get-Sha256Hex {
  param([string]$Path)
  # Get-FileHash（Microsoft.PowerShell.Utility の自動読み込み）に依存しない。
  # pwsh 7 のプロンプトから起動すると環境変数が継承され、5.1 側でモジュールが
  # 読めず Get-FileHash が見つからないことがあるため、.NET で直接計算する。
  $stream = [System.IO.File]::OpenRead($Path)
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try {
    return ([System.BitConverter]::ToString($sha.ComputeHash($stream))).Replace('-', '')
  } finally {
    $sha.Dispose()
    $stream.Dispose()
  }
}

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

  if ((Get-Content -LiteralPath $marker -Raw).TrimStart().StartsWith('{')) {
    throw '新版の復旧情報があります。同じPC・USBで Start-USB-Kit.bat を起動すると自動復旧します。'
  }

  $kit = $PSScriptRoot
  if (-not (Test-Path -LiteralPath (Join-Path $kit 'data\event-pos.sqlite'))) {
    throw 'このUSBにDBがありません。前回使ったUSBから復旧を実行してください。'
  }
  Write-Host "旧版の復旧情報にはUSBの識別情報がありません。書き戻し先: $kit"
  if ((Read-Host '前回と同じUSBだと確認できた場合は RECOVER と入力') -cne 'RECOVER') {
    throw '復旧を中止しました。'
  }
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
      if ((Get-Sha256Hex -Path $l) -ne (Get-Sha256Hex -Path $u)) {
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
