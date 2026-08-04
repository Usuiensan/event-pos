[CmdletBinding()]
param(
  [string]$ProjectDirectory = (Split-Path -Parent $PSScriptRoot),
  [switch]$ResetPosDatabase,
  [switch]$SkipBuild
)

$ErrorActionPreference = "Stop"
$project = (Resolve-Path -LiteralPath $ProjectDirectory).Path
Push-Location $project
try {
  if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { throw "docker コマンドが見つかりません。Docker Desktopを起動してください。" }

  if ($ResetPosDatabase) {
    Write-Host "削除対象: Docker volume event-pos_pos-data（POSの永続SQLiteとartifacts）"
    Write-Host "event-config、docs内のSQLite、Git履歴は削除しません。"
    $confirmation = Read-Host '本当に削除する場合は DELETE POS DATABASE と入力してください'
    if ($confirmation -cne "DELETE POS DATABASE") { throw "確認文字列が一致しないため、SQLite削除を中止しました。" }
  }

  Write-Host "既存のcomposeサービスを停止します。"
  docker compose down --remove-orphans
  if ($LASTEXITCODE -ne 0) { throw "Docker Composeの停止に失敗しました。" }

  if ($ResetPosDatabase) {
    $volume = docker volume ls --format "{{.Name}}" | Where-Object { $_ -eq "event-pos_pos-data" }
    if ($volume) {
      docker volume rm $volume
      if ($LASTEXITCODE -ne 0) { throw "POS用Docker volumeの削除に失敗しました。" }
    } else { Write-Host "POS用Docker volumeは存在しません。" }
  }

  if ($SkipBuild) { docker compose up -d --wait pos pos-training }
  else { docker compose up -d --build --wait pos pos-training }
  if ($LASTEXITCODE -ne 0) { throw "Docker Composeの再デプロイに失敗しました。" }

  $checks = @("http://127.0.0.1:3000/health/ready", "http://127.0.0.1:3002/health/ready")
  foreach ($uri in $checks) {
    $response = Invoke-WebRequest -UseBasicParsing -Uri $uri -TimeoutSec 10
    if ($response.StatusCode -ne 200 -or $response.Content -notmatch '"status"\s*:\s*"ok"') { throw "health確認に失敗しました: $uri" }
    Write-Host "$uri : ok"
  }
  docker compose ps
} finally { Pop-Location }
