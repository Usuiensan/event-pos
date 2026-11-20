[CmdletBinding()]
param(
  [ValidateSet('Auto', 'GitHub', 'Local')][string]$Mode = 'Auto',
  [string]$RepoRoot = $(if ($env:EVENT_POS_REPO) { $env:EVENT_POS_REPO } else { 'C:\private\event-pos' })
)

$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$kit = $PSScriptRoot
$localRoot = Join-Path $env:LOCALAPPDATA 'EventPos\UsbKit'
$backup = Join-Path $localRoot 'update-backup'
$statePath = Join-Path $localRoot 'update-state.json'
$repoSlug = 'Usuiensan/event-pos'
$assetName = 'event-pos-kit-payload.zip'
$dbPath = Join-Path $kit 'data\event-pos.sqlite'
$initialPath = Join-Path $kit 'event-config\usb-kit-initial'

function Get-FileDigest {
  param([string]$Path)
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
  return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash
}

function Get-TreeDigest {
  param([string]$Path)
  if (-not (Test-Path -LiteralPath $Path -PathType Container)) { return $null }
  $files = Get-ChildItem -LiteralPath $Path -Recurse -File | Sort-Object FullName
  $lines = foreach ($f in $files) {
    $rel = $f.FullName.Substring($Path.Length).TrimStart('\')
    "$rel=$((Get-FileHash -LiteralPath $f.FullName -Algorithm SHA256).Hash)"
  }
  $joined = [string]::Join("`n", @($lines))
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try {
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($joined)
    return ([System.BitConverter]::ToString($sha.ComputeHash($bytes))).Replace('-', '')
  } finally { $sha.Dispose() }
}

function Test-HttpOk {
  param([string]$Url)
  try {
    $r = Invoke-WebRequest -Uri $Url -TimeoutSec 2 -UseBasicParsing
    return $r.StatusCode -eq 200
  } catch { return $false }
}

# ビルド／ペイロードが上書きする範囲だけを退避・復旧の対象にする
$scopedDirs = @('server\dist', 'printer-host\dist', 'printer-host\scripts', 'web', 'runtime', 'data', 'event-config\usb-kit-initial')
$rootFiles = @('initialize-usb-kit.ps1', 'start-usb-kit.ps1', 'Start-USB-Kit.bat', 'Update-USB-Kit.bat', 'update-usb-kit.ps1', 'README.md', '.event-pos-usb-kit', 'printer-host.env')

function Backup-Scoped {
  foreach ($rel in $scopedDirs) {
    $src = Join-Path $kit $rel
    if (Test-Path -LiteralPath $src) {
      $dst = Join-Path $backup $rel
      New-Item -ItemType Directory -Path (Split-Path $dst -Parent) -Force | Out-Null
      Copy-Item -LiteralPath $src -Destination $dst -Recurse -Force
    }
  }
  foreach ($name in $rootFiles) {
    $src = Join-Path $kit $name
    if (Test-Path -LiteralPath $src) { Copy-Item -LiteralPath $src -Destination (Join-Path $backup $name) -Force }
  }
}

function Restore-Scoped {
  foreach ($rel in $scopedDirs) {
    $dst = Join-Path $kit $rel
    $src = Join-Path $backup $rel
    if (Test-Path -LiteralPath $dst) { Remove-Item -LiteralPath $dst -Recurse -Force }
    if (Test-Path -LiteralPath $src) {
      New-Item -ItemType Directory -Path (Split-Path $dst -Parent) -Force | Out-Null
      Copy-Item -LiteralPath $src -Destination $dst -Recurse -Force
    }
  }
  foreach ($name in $rootFiles) {
    $dst = Join-Path $kit $name
    $src = Join-Path $backup $name
    if (Test-Path -LiteralPath $src) { Copy-Item -LiteralPath $src -Destination $dst -Force }
    elseif (Test-Path -LiteralPath $dst) { Remove-Item -LiteralPath $dst -Force }
  }
  $newFile = Join-Path $kit 'update-usb-kit.ps1.new'
  if (Test-Path -LiteralPath $newFile) { Remove-Item -LiteralPath $newFile -Force }
}

function Get-ProtectedDigests {
  return @{
    db = Get-FileDigest $dbPath
    dbWal = Get-FileDigest "$dbPath-wal"
    dbShm = Get-FileDigest "$dbPath-shm"
    initialConfig = Get-TreeDigest $initialPath
    printerEnv = Get-FileDigest (Join-Path $kit 'printer-host.env')
  }
}

function Compare-Protected {
  param([hashtable]$Before)
  $problems = @()
  if ((Get-FileDigest $dbPath) -ne $Before.db) { $problems += 'DBが変化しています' }
  if ((Get-FileDigest "$dbPath-wal") -ne $Before.dbWal) { $problems += 'DB(WAL)が変化しています' }
  if ((Get-FileDigest "$dbPath-shm") -ne $Before.dbShm) { $problems += 'DB(SHM)が変化しています' }
  if ((Get-TreeDigest $initialPath) -ne $Before.initialConfig) { $problems += '初期設定（usb-kit-initial）が変化しています' }
  $envChanged = (Get-FileDigest (Join-Path $kit 'printer-host.env')) -ne $Before.printerEnv
  return @{ Problems = $problems; EnvChanged = $envChanged }
}

function Write-State {
  param([string]$Status)
  New-Item -ItemType Directory -Path $localRoot -Force | Out-Null
  @{ status = $Status; at = (Get-Date).ToString('o'); kit = $kit } | ConvertTo-Json | Set-Content -LiteralPath $statePath -Encoding UTF8
}

function Clear-State {
  if (Test-Path -LiteralPath $statePath) { Remove-Item -LiteralPath $statePath -Force }
}

function Invoke-SmokeTest {
  $smokeDir = Join-Path $env:TEMP "event-pos-smoke-$([guid]::NewGuid().ToString('N'))"
  New-Item -ItemType Directory -Path $smokeDir -Force | Out-Null
  $smokeProc = $null
  try {
    $env:HOST = '127.0.0.1'
    $env:PORT = '3199'
    $env:POS_REQUIRE_AUTH = '0'
    $env:POS_REQUIRE_HTTPS = '0'
    $env:POS_DATABASE_PATH = Join-Path $smokeDir 'smoke.sqlite'
    $env:POS_ARTIFACT_ROOT = Join-Path $smokeDir 'artifacts'
    $env:POS_EVENT_CONFIG_DIR = $initialPath
    $env:REGISTER_WEB_DIST = Join-Path $kit 'web'
    $env:PRINTER_HOST_URL = 'http://127.0.0.1:4318'
    $env:DRAWER_ENABLED = '0'
    $env:NODE_ENV = 'production'
    $node = Join-Path $kit 'runtime\node.exe'
    $smokeProc = Start-Process -FilePath $node -ArgumentList "`"$(Join-Path $kit 'server\dist\index.js')`"" -WorkingDirectory (Join-Path $kit 'server') -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $smokeDir 'out.log') -RedirectStandardError (Join-Path $smokeDir 'err.log')
    for ($i = 0; $i -lt 30; $i++) {
      if ($smokeProc.HasExited) { return $false }
      if (Test-HttpOk 'http://127.0.0.1:3199/api/v1/info') { return $true }
      Start-Sleep -Seconds 1
    }
    return $false
  } finally {
    if ($smokeProc -and -not $smokeProc.HasExited) { Stop-Process -Id $smokeProc.Id -Force -ErrorAction SilentlyContinue }
    Remove-Item -LiteralPath $smokeDir -Recurse -Force -ErrorAction SilentlyContinue
  }
}

function Invoke-LocalUpdate {
  $buildScript = Join-Path $RepoRoot 'deploy\windows\build-usb-kit.ps1'
  if (-not (Test-Path -LiteralPath $buildScript)) {
    throw "ビルド元が見つかりません: $buildScript`nこのPCにビルド元（event-pos リポジトリ）がないためローカルビルドはできません。EVENT_POS_REPO 環境変数で場所を指定するか、GitHub モードを使ってください。"
  }
  $kitFull = [System.IO.Path]::GetFullPath($kit).TrimEnd('\')
  $repoFull = [System.IO.Path]::GetFullPath($RepoRoot).TrimEnd('\')
  if ($kitFull -eq $repoFull -or $kitFull.StartsWith($repoFull + '\') -or $repoFull.StartsWith($kitFull + '\')) {
    throw "ビルド元とキットの場所が重なっています: repo=$repoFull kit=$kitFull"
  }
  Write-Host "ビルド元: $RepoRoot"
  Write-Host "更新先: $kit"

  $protectedBefore = Get-ProtectedDigests
  if (Test-Path -LiteralPath $backup) { Remove-Item -LiteralPath $backup -Recurse -Force }
  New-Item -ItemType Directory -Path $backup -Force | Out-Null
  Backup-Scoped
  Write-State 'applying'

  $runStarted = Get-Date
  $problems = @()
  if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) {
    if (-not (Get-Command corepack -ErrorAction SilentlyContinue)) { throw 'pnpm と corepack のどちらも見つかりません。ビルド元PCの Node.js 環境を確認してください。' }
    $shimDir = Join-Path $env:TEMP "event-pos-pnpm-shim-$([guid]::NewGuid().ToString('N'))"
    New-Item -ItemType Directory -Path $shimDir -Force | Out-Null
    Set-Content -LiteralPath (Join-Path $shimDir 'pnpm.cmd') -Value "@echo off`r`ncorepack pnpm %*" -Encoding Ascii
    $env:PATH = "$shimDir;$env:PATH"
    Write-Host 'pnpm が PATH にないため、corepack 経由のシムを使います。'
  }
  # ビルドは別プロセスで実行する。同一セッションで呼ぶと PowerShell 5.1 が
  # pnpm の標準エラー出力をエラー扱いし、終了コード 0 でも失敗と誤判定するため。
  $buildLogDir = Join-Path $env:TEMP "event-pos-build-$([guid]::NewGuid().ToString('N'))"
  New-Item -ItemType Directory -Path $buildLogDir -Force | Out-Null
  $buildOut = Join-Path $buildLogDir 'out.log'
  $buildErr = Join-Path $buildLogDir 'err.log'
  $buildProc = Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$buildScript`"", '-OutputDirectory', "`"$kit`"") -Wait -PassThru -WindowStyle Hidden -RedirectStandardOutput $buildOut -RedirectStandardError $buildErr
  if ($buildProc.ExitCode -ne 0) {
    Write-Host "ビルドに失敗しました（終了コード: $($buildProc.ExitCode)）。ビルドログの末尾:"
    if (Test-Path $buildOut) { Get-Content $buildOut -Tail 15 | ForEach-Object { Write-Host $_ } }
    if (Test-Path $buildErr) { Get-Content $buildErr -Tail 15 | ForEach-Object { Write-Host $_ } }
    $problems += 'ビルド失敗'
  } else {
    if (Test-Path $buildOut) { Get-Content $buildOut -Tail 1 | ForEach-Object { Write-Host $_ } }
  }

  if ($problems.Count -eq 0) {
    $bundle = Join-Path $kit 'server\dist\index.js'
    if (-not (Test-Path -LiteralPath $bundle) -or (Get-Item -LiteralPath $bundle).LastWriteTime -lt $runStarted) { $problems += 'サーバーバンドルが更新されていません' }
    $cmp = Compare-Protected $protectedBefore
    $problems += $cmp.Problems
    if ($cmp.EnvChanged) {
      Write-Host '注意: printer-host.env がビルド元の内容で上書きされました（更新前の内容はこのPCの update-backup に退避されています）。'
    }
  }
  if ($problems.Count -eq 0) {
    if (-not (Invoke-SmokeTest)) { $problems += 'smoke test で新しいサーバーが起動しませんでした' }
  }
  if ($problems.Count -gt 0) {
    Write-Host "問題があったため、更新前の状態へ戻します: $($problems -join ' / ')"
    Restore-Scoped
    Clear-State
    throw "更新に失敗したため、更新前の状態へ戻しました。問題: $($problems -join ' / ')"
  }
  $commit = $null
  if (Get-Command git -ErrorAction SilentlyContinue) {
    try { $commit = (& git -C $RepoRoot rev-parse HEAD 2>$null) } catch { $commit = $null }
  }
  @{ source = 'local'; commit = $commit; appliedAt = (Get-Date).ToString('o') } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $kit 'kit-version.json') -Encoding UTF8
  Clear-State
  Write-Host 'アップデートが完了しました。Start-USB-Kit.bat から起動できます。'
  Write-Host "更新前のプログラム一式はこのPCの $backup に残しています（不要なら削除して構いません）。"
}

function Invoke-GitHubUpdate {
  $feedBase = if ($env:EVENT_POS_KIT_FEED) { $env:EVENT_POS_KIT_FEED.TrimEnd('/') } else { "https://api.github.com/repos/$repoSlug" }
  $headers = @{ 'User-Agent' = 'event-pos-usb-kit-updater'; 'Accept' = 'application/vnd.github+json' }
  try {
    $release = Invoke-RestMethod -Uri "$feedBase/releases/latest" -Headers $headers -TimeoutSec 30
  } catch {
    $code = $null
    if ($_.Exception.Response) { try { $code = [int]$_.Exception.Response.StatusCode } catch { $code = $null } }
    if ($code -eq 404) { throw '配布リリースがまだありません。先に publish-kit-release.ps1 でリリースを作成してください。' }
    throw "リリース情報の取得に失敗しました（HTTP $code）。ネットワーク接続を確認してください。"
  }
  $asset = @($release.assets | Where-Object { $_.name -eq $assetName }) | Select-Object -First 1
  if (-not $asset) { throw "リリース $($release.tag_name) に $assetName がありません。" }
  $assetDigest = $asset.digest
  $versionPath = Join-Path $kit 'kit-version.json'
  if ($assetDigest -and (Test-Path -LiteralPath $versionPath)) {
    try {
      $v = Get-Content -LiteralPath $versionPath -Raw | ConvertFrom-Json
      if ($v.assetDigest -eq $assetDigest) {
        Write-Host "既に最新です（$($release.tag_name)）。"
        return
      }
    } catch { }
  }
  Write-Host "配布リリース $($release.tag_name) を取得します。"

  $work = Join-Path $env:TEMP "event-pos-ghupdate-$([guid]::NewGuid().ToString('N'))"
  New-Item -ItemType Directory -Path $work -Force | Out-Null
  try {
    $zipPath = Join-Path $work 'payload.zip'
    $dlUrl = if ($asset.browser_download_url) { $asset.browser_download_url } else { $asset.url }
    try {
      Invoke-WebRequest -Uri $dlUrl -Headers @{ 'User-Agent' = 'event-pos-usb-kit-updater' } -OutFile $zipPath -TimeoutSec 600
    } catch {
      throw "ペイロードのダウンロードに失敗しました。ネットワーク接続を確認してください: $($_.Exception.Message)"
    }
    $zipHash = (Get-FileHash -LiteralPath $zipPath -Algorithm SHA256).Hash.ToLower()
    if ($assetDigest) {
      if ($assetDigest -ne "sha256:$zipHash") { throw 'ダウンロードしたZIPのハッシュがリリース情報と一致しません。中断します。' }
    } else {
      Write-Host '注意: リリースに digest 情報がないため、ZIP全体の照合は省略し、manifest で個別に検証します。'
    }
    $stage = Join-Path $work 'stage'
    Expand-Archive -LiteralPath $zipPath -DestinationPath $stage -Force
    $manifestPath = Join-Path $stage 'manifest.json'
    if (-not (Test-Path -LiteralPath $manifestPath)) { throw 'ペイロードに manifest.json がありません。' }
    $manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($manifest.format -ne 1) { throw "未対応のペイロード形式です: $($manifest.format)" }
    $entries = @($manifest.files)
    if ($entries.Count -gt 5000) { throw 'ペイロードのファイル数が上限を超えています。' }
    $totalSize = ($entries | Measure-Object -Property size -Sum).Sum
    if ($totalSize -gt 314572800) { throw 'ペイロードの合計サイズが上限を超えています。' }
    $rootAllow = @('initialize-usb-kit.ps1', 'start-usb-kit.ps1', 'Start-USB-Kit.bat', 'update-usb-kit.ps1', 'README.md', 'printer-host.env', '.event-pos-usb-kit')
    $seen = @{}
    foreach ($e in $entries) {
      $rel = ([string]$e.path).Replace('/', '\')
      if ([System.IO.Path]::IsPathRooted($rel) -or $rel -match '(^|\\)\.\.(\\|$)' -or $rel -match '^[a-zA-Z]:') { throw "ペイロードに不正なパスがあります: $($e.path)" }
      $key = $rel.ToLower()
      if ($seen.ContainsKey($key)) { throw "ペイロードに重複したパスがあります: $($e.path)" }
      $seen[$key] = $true
      $seg = $rel.Split('\')
      if ($seg.Count -gt 1) {
        if ($seg[0] -notin @('server', 'printer-host', 'web')) { throw "ペイロードに許可されていないフォルダーがあります: $($e.path)" }
      } else {
        if ($seg[0] -notin $rootAllow) { throw "ペイロードに許可されていないファイルがあります: $($e.path)" }
      }
      if ($e.class -notin @('overwrite', 'self')) { throw "ペイロードの分類が不正です: $($e.path)" }
      if ($e.class -eq 'self' -and $rel -ne 'update-usb-kit.ps1') { throw "self 分類は update-usb-kit.ps1 だけに使えます: $($e.path)" }
      if ([long]$e.size -gt 134217728) { throw "ペイロードのファイルが大きすぎます: $($e.path)" }
      $f = Join-Path $stage $rel
      if (-not (Test-Path -LiteralPath $f -PathType Leaf)) { throw "ペイロードにファイルが不足しています: $($e.path)" }
      if ((Get-Item -LiteralPath $f).Length -ne [long]$e.size) { throw "ペイロードのサイズが manifest と一致しません: $($e.path)" }
      if ((Get-FileDigest $f).ToLower() -ne ([string]$e.sha256).ToLower()) { throw "ペイロードのハッシュが manifest と一致しません: $($e.path)" }
    }
    $stageFiles = Get-ChildItem -LiteralPath $stage -Recurse -File | ForEach-Object { $_.FullName.Substring($stage.Length).TrimStart('\') }
    foreach ($sf in $stageFiles) {
      if ($sf -ieq 'manifest.json') { continue }
      if (-not $seen.ContainsKey($sf.ToLower())) { throw "ペイロードに manifest へ記載のないファイルがあります: $sf" }
    }
    Write-Host "ペイロードの検証が終わりました（$($entries.Count) ファイル / コミット $($manifest.commit)）。"

    $protectedBefore = Get-ProtectedDigests
    if (Test-Path -LiteralPath $backup) { Remove-Item -LiteralPath $backup -Recurse -Force }
    New-Item -ItemType Directory -Path $backup -Force | Out-Null
    Backup-Scoped
    Write-State 'applying'
    $problems = @()
    try {
      foreach ($e in $entries) {
        $rel = ([string]$e.path).Replace('/', '\')
        $src = Join-Path $stage $rel
        if ($e.class -eq 'self') {
          Copy-Item -LiteralPath $src -Destination (Join-Path $kit 'update-usb-kit.ps1.new') -Force
        } else {
          $dst = Join-Path $kit $rel
          New-Item -ItemType Directory -Path (Split-Path $dst -Parent) -Force | Out-Null
          Copy-Item -LiteralPath $src -Destination $dst -Force
        }
      }
    } catch {
      $problems += "適用に失敗しました: $($_.Exception.Message)"
    }
    if ($problems.Count -eq 0) {
      foreach ($e in $entries) {
        if ($e.class -eq 'self') { continue }
        $rel = ([string]$e.path).Replace('/', '\')
        $dst = Join-Path $kit $rel
        if ((Get-FileDigest $dst).ToLower() -ne ([string]$e.sha256).ToLower()) { $problems += "適用後のハッシュが一致しません: $rel" }
      }
      $cmp = Compare-Protected $protectedBefore
      $problems += $cmp.Problems
      if ($cmp.EnvChanged) {
        Write-Host '注意: printer-host.env がリリースの内容で上書きされました（更新前の内容はこのPCの update-backup に退避されています）。'
      }
    }
    if ($problems.Count -eq 0) {
      if (-not (Invoke-SmokeTest)) { $problems += 'smoke test で新しいサーバーが起動しませんでした' }
    }
    if ($problems.Count -gt 0) {
      Write-Host "問題があったため、更新前の状態へ戻します: $($problems -join ' / ')"
      Restore-Scoped
      Clear-State
      throw "更新に失敗したため、更新前の状態へ戻しました。問題: $($problems -join ' / ')"
    }
    @{ source = 'github'; commit = $manifest.commit; tag = $release.tag_name; releaseId = $release.id; assetId = $asset.id; assetDigest = $assetDigest; zipSha256 = $zipHash; appliedAt = (Get-Date).ToString('o') } | ConvertTo-Json | Set-Content -LiteralPath $versionPath -Encoding UTF8
    Clear-State
    Write-Host "アップデートが完了しました（$($release.tag_name)）。Start-USB-Kit.bat から起動できます。"
    Write-Host 'アップデーター自体に新版がある場合は、次回 Update-USB-Kit.bat の起動時に自動で差し替わります。'
    Write-Host "更新前のプログラム一式はこのPCの $backup に残しています（不要なら削除して構いません）。"
  } finally {
    if (Test-Path -LiteralPath $work) { Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue }
  }
}

$mutex = $null
$acquired = $false
try {
  $mutex = New-Object System.Threading.Mutex($false, 'Local\EventPosUsbKitUpdate')
  try { $acquired = $mutex.WaitOne(0) } catch [System.Threading.AbandonedMutexException] { $acquired = $true }
} catch {
  Write-Host "注意: 二重起動防止の初期化に失敗したため、そのまま続行します: $($_.Exception.Message)"
  $mutex = $null
}
if ($mutex -and -not $acquired) {
  Write-Host 'アップデートは既に実行中です。同時に2つは実行できません。'
  exit 1
}

try {
  $marker = Join-Path $kit '.event-pos-usb-kit'
  if (-not (Test-Path -LiteralPath $marker)) { throw "このフォルダーはUSBキットではありません: $kit" }

  # 前回の更新が適用途中で止まっていたら、退避から復旧してから始める
  if (Test-Path -LiteralPath $statePath) {
    try {
      $st = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
      if ($st.status -eq 'applying' -and (Test-Path -LiteralPath $backup)) {
        Write-Host '前回の更新が途中で止まっていたため、更新前の状態へ復旧します。'
        Restore-Scoped
      }
    } catch { }
    Clear-State
  }

  $syncMarker = Join-Path $localRoot 'usb-sync-in-progress'
  if (Test-Path -LiteralPath $syncMarker) {
    throw '前回の終了時にUSBへのDB書き戻しを確認できていません（同期マーカーが残っています）。READMEの手順でローカルDBとUSB DBを確認して復旧してから、更新を実行してください。'
  }

  $running = @()
  if (Test-HttpOk 'http://127.0.0.1:3000/health/live') { $running += 'POS server (3000)' }
  if (Test-HttpOk 'http://127.0.0.1:4318/health/live') { $running += 'PrinterHost (4318)' }
  $kitProcesses = Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine.IndexOf($kit, [System.StringComparison]::OrdinalIgnoreCase) -ge 0 }
  if ($kitProcesses) { $running += "キットの node プロセス ($($kitProcesses.Count)件)" }
  if ($running.Count -gt 0) {
    throw "キットが稼働中です: $($running -join ', ')`nPOSの画面を閉じ、キットのコンソールで Ctrl+C を押して完全に終了してから、もう一度実行してください。"
  }

  $effectiveMode = $Mode
  if ($effectiveMode -eq 'Auto') {
    if ($env:EVENT_POS_UPDATE_MODE -eq 'local') { $effectiveMode = 'Local' }
    elseif ($env:EVENT_POS_UPDATE_MODE -eq 'github') { $effectiveMode = 'GitHub' }
    else { $effectiveMode = 'GitHub' }
  }
  Write-Host "更新方式: $(if ($effectiveMode -eq 'GitHub') { 'GitHub から取得' } else { 'ローカルビルド' })"
  if ($effectiveMode -eq 'GitHub') { Invoke-GitHubUpdate } else { Invoke-LocalUpdate }
} finally {
  if ($mutex) {
    if ($acquired) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
  }
}
