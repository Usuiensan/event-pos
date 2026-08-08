[CmdletBinding()]
param(
  [string]$ProjectDirectory = (Split-Path -Parent $PSScriptRoot),
  [switch]$SkipDeploy
)

$ErrorActionPreference = "Stop"
$project = (Resolve-Path -LiteralPath $ProjectDirectory).Path
$envPath = Join-Path $project ".env"
$examplePath = Join-Path $project ".env.example"

if (-not (Test-Path -LiteralPath $envPath)) {
  if (-not (Test-Path -LiteralPath $examplePath)) { throw ".env.example が見つかりません: $examplePath" }
  Copy-Item -LiteralPath $examplePath -Destination $envPath
  Write-Host "Created .env from .env.example."
}

$secret = Read-Host "Enter Brave Search API key (input is hidden)" -AsSecureString
$ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secret)
try { $apiKey = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr) }
finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
if ([string]::IsNullOrWhiteSpace($apiKey)) { throw "API key is empty. Aborted." }

$content = Get-Content -LiteralPath $envPath -Raw
function Set-EnvValue([string]$text, [string]$name, [string]$value) {
  $escaped = [Regex]::Escape($value)
  $line = "$name=$value"
  if ($text -match "(?m)^$([Regex]::Escape($name))=.*$") {
    return [Regex]::Replace($text, "(?m)^$([Regex]::Escape($name))=.*$", [System.Text.RegularExpressions.MatchEvaluator]{ param($m) $line })
  }
  return ($text.TrimEnd("`r", "`n") + "`r`n" + $line + "`r`n")
}

$content = Set-EnvValue $content "BRAVE_SEARCH_API_KEY" $apiKey
$content = Set-EnvValue $content "BRAVE_SEARCH_MONTHLY_LIMIT" "900"
$content = Set-EnvValue $content "BRAVE_SEARCH_ALERT_AT" "800"
$content = Set-EnvValue $content "BRAVE_SEARCH_DAILY_LIMIT" "100"
$content = Set-EnvValue $content "BRAVE_SEARCH_PER_MINUTE_LIMIT" "10"
$content = Set-EnvValue $content "BRAVE_SEARCH_MIN_INTERVAL_MS" "1000"
[IO.File]::WriteAllText($envPath, $content, [Text.UTF8Encoding]::new($false))
$apiKey = $null

Write-Host "Saved Brave Search API settings to .env. The key was not displayed or logged."
if ($SkipDeploy) { Write-Host "-SkipDeploy specified. Docker restart skipped."; exit 0 }

Push-Location $project
try {
  if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { throw "docker command was not found. Start Docker Desktop." }
  docker compose up -d --build pos
  if ($LASTEXITCODE -ne 0) { throw "Docker Compose start failed." }
  $ready = $false
  for ($i = 0; $i -lt 30; $i++) {
    try {
      $response = Invoke-WebRequest -UseBasicParsing -Uri "https://127.0.0.1:3443/health/ready" -SkipCertificateCheck -TimeoutSec 3
      if ($response.StatusCode -eq 200 -and $response.Content -match '"status"\s*:\s*"ok"') { $ready = $true; break }
    } catch { }
    Start-Sleep -Seconds 2
  }
  if (-not $ready) { throw "Could not verify https://127.0.0.1:3443/health/ready after restart. Check docker compose ps pos." }
  Write-Host "Brave Search API setup and POS restart completed. https://127.0.0.1:3443/health/ready: ok"
} finally { Pop-Location }
