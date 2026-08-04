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
  Write-Host ".env を .env.example から作成しました。"
}

$secret = Read-Host "Brave Search APIキーを入力してください（画面には表示されません）" -AsSecureString
$ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secret)
try { $apiKey = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr) }
finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
if ([string]::IsNullOrWhiteSpace($apiKey)) { throw "APIキーが空です。処理を中止しました。" }

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

Write-Host ".env にBrave Search API設定を保存しました。キーは表示・出力していません。"
if ($SkipDeploy) { Write-Host "-SkipDeploy が指定されたため、Docker再起動を省略しました。"; exit 0 }

Push-Location $project
try {
  if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { throw "docker コマンドが見つかりません。Docker Desktopを起動してください。" }
  docker compose up -d --build pos
  if ($LASTEXITCODE -ne 0) { throw "Docker Composeの起動に失敗しました。" }
  $ready = $false
  for ($i = 0; $i -lt 30; $i++) {
    try {
      $response = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:3000/health/ready" -TimeoutSec 3
      if ($response.StatusCode -eq 200 -and $response.Content -match '"status"\s*:\s*"ok"') { $ready = $true; break }
    } catch { }
    Start-Sleep -Seconds 2
  }
  if (-not $ready) { throw "再起動後の /health/ready が確認できません。docker compose ps pos を確認してください。" }
  Write-Host "Brave Search API設定とPOS再起動が完了しました。/health/ready: ok"
} finally { Pop-Location }
