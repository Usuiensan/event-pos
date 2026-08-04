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
  if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { throw "docker command was not found. Start Docker Desktop." }

  if ($ResetPosDatabase) {
    Write-Host "Delete target: Docker volume event-pos_pos-data (persistent POS SQLite and artifacts)"
    Write-Host "event-config, SQLite files under docs, and Git history are not deleted."
    $confirmation = Read-Host 'Type "delete all pos database" to confirm deletion (case-insensitive; Enter cancels)'
    if (-not [string]::Equals($confirmation, "delete all pos database", [StringComparison]::OrdinalIgnoreCase)) {
      Write-Host "SQLite deletion cancelled. No data was deleted."
      exit 0
    }
  }

  Write-Host "Stopping existing compose services."
  docker compose down --remove-orphans
  if ($LASTEXITCODE -ne 0) { throw "Docker Compose stop failed." }

  if ($ResetPosDatabase) {
    $volume = docker volume ls --format "{{.Name}}" | Where-Object { $_ -eq "event-pos_pos-data" }
    if ($volume) {
      docker volume rm $volume
      if ($LASTEXITCODE -ne 0) { throw "POS用Docker volumeの削除に失敗しました。" }
    } else { Write-Host "POS Docker volume does not exist." }
  }

  if ($SkipBuild) { docker compose up -d --wait pos }
  else { docker compose up -d --build --wait pos }
  if ($LASTEXITCODE -ne 0) { throw "Docker Compose redeploy failed." }

  if ($ResetPosDatabase) {
    $reload = Invoke-WebRequest -UseBasicParsing -Method Post -Uri "http://127.0.0.1:3000/api/v1/events/demo-event-large/catalog/reload" -ContentType "application/json" -Body "{}" -TimeoutSec 10
    if ($reload.StatusCode -ne 200) { throw "Catalog reload failed after database reset." }
    Write-Host "Reloaded demo-event-large catalog from YAML."
  }

  if ($SkipBuild) { docker compose up -d --wait pos-training }
  else { docker compose up -d --wait pos-training }
  if ($LASTEXITCODE -ne 0) { throw "Training service startup failed." }

  $checks = @("http://127.0.0.1:3000/health/ready", "http://127.0.0.1:3002/health/ready")
  foreach ($uri in $checks) {
    $response = Invoke-WebRequest -UseBasicParsing -Uri $uri -TimeoutSec 10
    if ($response.StatusCode -ne 200 -or $response.Content -notmatch '"status"\s*:\s*"ok"') { throw "Health check failed: $uri" }
    Write-Host "$uri : ok"
  }
  docker compose ps
} finally { Pop-Location }
