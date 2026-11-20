[CmdletBinding()]
param(
  [string]$RepoRoot = '',
  [string]$Tag = '',
  [string]$Commit = '',
  [string]$Token = $env:GITHUB_TOKEN,
  [switch]$PrepareOnly
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
  $manifest = @{
    format = 1
    commit = $Commit
    tag = $Tag
    createdAt = (Get-Date).ToString('o')
    files = $files
  }
  $manifest | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $payloadDir 'manifest.json') -Encoding UTF8

  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $zipPath = Join-Path $work $assetName
  [System.IO.Compression.ZipFile]::CreateFromDirectory($payloadDir, $zipPath)
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
