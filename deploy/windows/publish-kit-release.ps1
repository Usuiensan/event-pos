[CmdletBinding()]
param(
  [string]$RepoRoot = '',
  [string]$Tag = '',
  [string]$Commit = '',
  [string]$Token = $env:GITHUB_TOKEN,
  [switch]$PrepareOnly,
  [switch]$SkipUpdaterCompatCheck
)

$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
if (-not $RepoRoot) { $RepoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).Path }
$repoSlug = 'Usuiensan/event-pos'
$assetName = 'event-pos-kit-payload.zip'

# ペイロードに含めないもの：
# - runtime\node.exe（Node本体。キットに同梱済みで通常の更新では変えない）
# - data（DBはキット側のもの）
# - event-config（実行時設定は usb-kit-initial のみで、配布対象にしない。初期設定はキット作成時に決まる）
$excludeTop = @('runtime', 'data', 'event-config')

function Test-UpdaterCompatibility {
  param([array]$PayloadFiles)
  # 前回リリースのアップデーターが弾くファイルが新しいペイロードに無いかを確認する。
  # 旧アップデーターは許可リスト外のルートファイル／先頭フォルダーを検証で即拒否し、
  # 自分自身を新版へ差し替える前に止まるため、新ファイルを足すリリースは現場で詰む
  # (kit-20261125 の Recover-USB-Kit-DB.bat で実際に発生)。
  # 前回アップデーターが KitUpdaterBootstrap 対応なら、先行自己更新で乗り越えられるので対象外。
  $headers = @{ 'User-Agent' = 'event-pos-publish-kit-release'; 'Accept' = 'application/vnd.github+json' }
  try {
    $prevRelease = Invoke-RestMethod -Uri "https://api.github.com/repos/$repoSlug/releases/latest" -Headers $headers -TimeoutSec 30
  } catch {
    Write-Warning "前回リリースを取得できないため、アップデーター互換チェックをスキップしました: $($_.Exception.Message)"
    return
  }
  $prevAsset = @($prevRelease.assets | Where-Object { $_.name -eq $assetName }) | Select-Object -First 1
  if (-not $prevAsset) { Write-Warning '前回リリースにペイロードが無いため、アップデーター互換チェックをスキップしました。'; return }
  $prevZip = Join-Path $work 'prev-payload.zip'
  try {
    Invoke-WebRequest -Uri $prevAsset.browser_download_url -Headers @{ 'User-Agent' = 'event-pos-publish-kit-release' } -OutFile $prevZip -TimeoutSec 600
  } catch {
    Write-Warning "前回ペイロードを取得できないため、アップデーター互換チェックをスキップしました: $($_.Exception.Message)"
    return
  }
  if ($prevAsset.digest) {
    $prevHash = (Get-FileHash -LiteralPath $prevZip -Algorithm SHA256).Hash.ToLower()
    if ($prevAsset.digest -ne "sha256:$prevHash") { throw "前回ペイロードの digest が一致しません: $($prevAsset.digest)" }
  }
  Add-Type -AssemblyName System.IO.Compression
  $prevUpdaterText = $null
  $zipStream = [System.IO.File]::OpenRead($prevZip)
  $archive = New-Object System.IO.Compression.ZipArchive($zipStream, [System.IO.Compression.ZipArchiveMode]::Read)
  try {
    $entry = @($archive.Entries | Where-Object { $_.FullName -eq 'update-usb-kit.ps1' }) | Select-Object -First 1
    if (-not $entry) { Write-Warning '前回ペイロードに update-usb-kit.ps1 が無いため、アップデーター互換チェックをスキップしました。'; return }
    $reader = New-Object System.IO.StreamReader($entry.Open(), [System.Text.Encoding]::UTF8)
    try { $prevUpdaterText = $reader.ReadToEnd() } finally { $reader.Dispose() }
  } finally { $archive.Dispose(); $zipStream.Dispose() }
  if ($prevUpdaterText -match 'KitUpdaterBootstrap: v1') {
    Write-Host '前回アップデーターは先行自己更新（KitUpdaterBootstrap）対応のため、互換チェックを省略します。'
    return
  }
  $prevRootAllow = @()
  $prevFolderAllow = @()
  foreach ($line in ($prevUpdaterText -split "`r?`n")) {
    if ($line -match '\$rootAllow\s*=') { $prevRootAllow = @([regex]::Matches($line, "'([^']+)'") | ForEach-Object { $_.Groups[1].Value }) }
    if ($line -match "-notin @\('server'") { $prevFolderAllow = @([regex]::Matches($line, "'([^']+)'") | ForEach-Object { $_.Groups[1].Value }) }
  }
  if ($prevRootAllow.Count -eq 0 -or $prevFolderAllow.Count -eq 0) { Write-Warning '前回アップデーターの許可リストを読めないため、アップデーター互換チェックをスキップしました。'; return }
  $blocked = @()
  foreach ($f in $PayloadFiles) {
    $seg = ([string]$f.path).Split('/')
    if ($seg.Count -gt 1) {
      if ($seg[0] -notin $prevFolderAllow) { $blocked += $f.path }
    } else {
      if ($seg[0] -notin $prevRootAllow) { $blocked += $f.path }
    }
  }
  if ($blocked.Count -gt 0) {
    throw "前回リリース ($($prevRelease.tag_name)) のアップデーターが許可していないファイルがペイロードに含まれています: $($blocked -join ', ')`nこのまま公開すると現場キットは更新できません。先に、弾かれるファイルを含まず新しいアップデーターだけを含む中間リリースを公開し、現場キットを一度更新してから、本リリースを公開してください。"
  }
  Write-Host "アップデーター互換チェック OK（前回リリース $($prevRelease.tag_name) のアップデーターで更新できます）。"
}

if (-not $Commit) {
  if (-not (Get-Command git -ErrorAction SilentlyContinue)) { throw 'git が見つかりません。-Commit で対象コミットを指定してください。' }
  $Commit = (& git -C $RepoRoot rev-parse HEAD)
  if ($LASTEXITCODE -ne 0 -or -not $Commit) { throw 'コミットの特定に失敗しました。' }
  $Commit = $Commit.Trim()
}
if (-not $Tag) { $Tag = "kit-$(Get-Date -Format 'yyyyMMdd')-$($Commit.Substring(0, 7))" }
Write-Host "リリース対象コミット: $Commit"
Write-Host "タグ: $Tag"

$buildScript = Join-Path $RepoRoot 'deploy\windows\build-usb-kit.ps1'
if (-not (Test-Path -LiteralPath $buildScript)) { throw "ビルドスクリプトが見つかりません: $buildScript" }

$work = Join-Path $env:TEMP "event-pos-release-$([guid]::NewGuid().ToString('N'))"
$stage = Join-Path $work 'kit'
$payloadDir = Join-Path $work 'payload'
# $stage は作らない（build-usb-kit.ps1 は既存フォルダーにマーカーが無いと拒否するため、作成はビルド側に任せる）
New-Item -ItemType Directory -Path $payloadDir -Force | Out-Null
try {
  if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) {
    if (-not (Get-Command corepack -ErrorAction SilentlyContinue)) { throw 'pnpm と corepack のどちらも見つかりません。Node.js 環境を確認してください。' }
    $shimDir = Join-Path $work 'pnpm-shim'
    New-Item -ItemType Directory -Path $shimDir -Force | Out-Null
    Set-Content -LiteralPath (Join-Path $shimDir 'pnpm.cmd') -Value "@echo off`r`ncorepack pnpm %*" -Encoding Ascii
    $env:PATH = "$shimDir;$env:PATH"
    Write-Host 'pnpm が PATH にないため、corepack 経由のシムを使います。'
  }
  # ビルドは別プロセス（PowerShell 5.1 の stderr 誤判定を避ける。update-usb-kit.ps1 と同じ理由）
  $buildOut = Join-Path $work 'build-out.log'
  $buildErr = Join-Path $work 'build-err.log'
  $proc = Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$buildScript`"", '-OutputDirectory', "`"$stage`"") -Wait -PassThru -WindowStyle Hidden -RedirectStandardOutput $buildOut -RedirectStandardError $buildErr
  if ($proc.ExitCode -ne 0) {
    if (Test-Path $buildOut) { Get-Content $buildOut -Tail 15 | ForEach-Object { Write-Host $_ } }
    if (Test-Path $buildErr) { Get-Content $buildErr -Tail 15 | ForEach-Object { Write-Host $_ } }
    throw "キットのビルドに失敗しました（終了コード: $($proc.ExitCode)）"
  }

  $files = @()
  $stageFiles = Get-ChildItem -LiteralPath $stage -Recurse -File
  foreach ($f in $stageFiles) {
    $rel = $f.FullName.Substring($stage.Length).TrimStart('\')
    $top = $rel.Split('\')[0]
    if ($top -in $excludeTop) { continue }
    if ($rel -ieq 'kit-version.json') { continue }
    $dst = Join-Path $payloadDir $rel
    New-Item -ItemType Directory -Path (Split-Path $dst -Parent) -Force | Out-Null
    Copy-Item -LiteralPath $f.FullName -Destination $dst -Force
    $files += @{
      path = $rel.Replace('\', '/')
      sha256 = (Get-FileHash -LiteralPath $f.FullName -Algorithm SHA256).Hash.ToLower()
      size = $f.Length
      class = $(if ($rel -ieq 'update-usb-kit.ps1') { 'self' } else { 'overwrite' })
    }
  }
  if ($SkipUpdaterCompatCheck) {
    Write-Warning 'アップデーター互換チェックをスキップしました（-SkipUpdaterCompatCheck）。前回アップデーターが弾くファイルが含まれていると、現場キットは更新できません。'
  } else {
    Test-UpdaterCompatibility -PayloadFiles $files
  }
  $manifest = @{
    format = 1
    commit = $Commit
    tag = $Tag
    createdAt = (Get-Date).ToString('o')
    files = $files
  }
  $manifest | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $payloadDir 'manifest.json') -Encoding UTF8

  Add-Type -AssemblyName System.IO.Compression
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $zipPath = Join-Path $work $assetName
  # CreateFromDirectory は Windows で区切り文字 '\' のエントリ名を作ってしまうため、
  # ZIP標準の '/' 区切りで1件ずつ作成する
  $zipStream = [System.IO.File]::Open($zipPath, [System.IO.FileMode]::Create)
  $archive = New-Object System.IO.Compression.ZipArchive($zipStream, [System.IO.Compression.ZipArchiveMode]::Create)
  try {
    foreach ($f in (Get-ChildItem -LiteralPath $payloadDir -Recurse -File)) {
      $rel = $f.FullName.Substring($payloadDir.Length).TrimStart('\').Replace('\', '/')
      $entry = $archive.CreateEntry($rel, [System.IO.Compression.CompressionLevel]::Optimal)
      $entryStream = $entry.Open()
      $fileStream = [System.IO.File]::OpenRead($f.FullName)
      try { $fileStream.CopyTo($entryStream) } finally { $fileStream.Dispose(); $entryStream.Dispose() }
    }
  } finally {
    $archive.Dispose()
    $zipStream.Dispose()
  }
  $zipHash = (Get-FileHash -LiteralPath $zipPath -Algorithm SHA256).Hash.ToLower()
  Write-Host "ペイロード: $($files.Count) ファイル / ZIP SHA256: $zipHash"

  if ($PrepareOnly) {
    $outZip = Join-Path $RepoRoot $assetName
    Copy-Item -LiteralPath $zipPath -Destination $outZip -Force
    Write-Host "PrepareOnly: ZIP を $outZip に置きました（アップロードはしていません）。"
    return
  }

  if (-not $Token) { throw 'GitHub トークンがありません。環境変数 GITHUB_TOKEN（対象リポジトリの Contents: Read and write）か -Token で指定してください。' }
  $headers = @{ 'User-Agent' = 'event-pos-publish-kit-release'; 'Accept' = 'application/vnd.github+json'; 'Authorization' = "Bearer $Token" }
  $apiBase = "https://api.github.com/repos/$repoSlug"

  $existing = $null
  try { $existing = Invoke-RestMethod -Uri "$apiBase/releases/tags/$Tag" -Headers $headers -TimeoutSec 30 } catch { $existing = $null }
  if ($existing) {
    $a = @($existing.assets | Where-Object { $_.name -eq $assetName }) | Select-Object -First 1
    if ($a -and $a.digest -eq "sha256:$zipHash") {
      Write-Host "同じ内容のリリースが既にあります: $($existing.html_url)"
      return
    }
    throw "タグ $Tag のリリースが既にあり、内容が異なります。別のタグを指定してください。"
  }

  $body = @{ tag_name = $Tag; target_commitish = $Commit; name = "USBキット配布 $Tag"; body = "event-pos USBキット更新用ペイロード。対象コミット: $Commit" } | ConvertTo-Json
  $release = Invoke-RestMethod -Uri "$apiBase/releases" -Method Post -Headers $headers -ContentType 'application/json' -Body $body -TimeoutSec 30
  $uploadUrl = "https://uploads.github.com/repos/$repoSlug/releases/$($release.id)/assets?name=$assetName"
  $asset = Invoke-RestMethod -Uri $uploadUrl -Method Post -Headers $headers -ContentType 'application/zip' -InFile $zipPath -TimeoutSec 600
  if ($asset.digest -ne "sha256:$zipHash") { throw "アップロード後の digest が一致しません: $($asset.digest)" }
  Write-Host "リリースを作成しました: $($release.html_url)"
  Write-Host "アセット digest 照合OK: $($asset.digest)"
} finally {
  if (Test-Path -LiteralPath $work) { Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue }
}
