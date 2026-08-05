[CmdletBinding()]
param(
  [string]$ProjectDirectory = (Split-Path -Parent $PSScriptRoot),
  [switch]$ResetPosDatabase,
  [switch]$SkipBuild
)

$ErrorActionPreference = "Stop"
$project = (Resolve-Path -LiteralPath $ProjectDirectory).Path

function Ensure-LocalTlsCertificate {
  param([string]$Directory)

  $certificatePath = Join-Path $Directory "server.crt"
  $keyPath = Join-Path $Directory "server.key"
  $certificateExists = Test-Path -LiteralPath $certificatePath
  $keyExists = Test-Path -LiteralPath $keyPath
  if ($certificateExists -and $keyExists) { return }
  if ($certificateExists -or $keyExists) { throw "TLS証明書と秘密鍵は両方必要です。既存ファイルを上書きしません: $Directory" }
  if ($PSVersionTable.PSVersion.Major -lt 7) { throw "TLS証明書の自動生成にはPowerShell 7以降が必要です。" }

  New-Item -ItemType Directory -Path $Directory -Force | Out-Null
  $rsa = [System.Security.Cryptography.RSA]::Create(2048)
  $certificate = $null
  try {
    $request = [System.Security.Cryptography.X509Certificates.CertificateRequest]::new(
      "CN=localhost",
      $rsa,
      [System.Security.Cryptography.HashAlgorithmName]::SHA256,
      [System.Security.Cryptography.RSASignaturePadding]::Pkcs1
    )
    $san = [System.Security.Cryptography.X509Certificates.SubjectAlternativeNameBuilder]::new()
    $san.AddDnsName("localhost")
    $san.AddIpAddress([System.Net.IPAddress]::Parse("127.0.0.1"))
    $request.CertificateExtensions.Add($san.Build())
    $certificate = $request.CreateSelfSigned([DateTimeOffset]::Now.AddMinutes(-5), [DateTimeOffset]::Now.AddDays(30))
    [IO.File]::WriteAllText($certificatePath, $certificate.ExportCertificatePem(), [Text.UTF8Encoding]::new($false))
    [IO.File]::WriteAllText($keyPath, $rsa.ExportPkcs8PrivateKeyPem(), [Text.UTF8Encoding]::new($false))
  } catch {
    foreach ($path in @($certificatePath, $keyPath)) { Remove-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue }
    throw
  } finally {
    if ($certificate) { $certificate.Dispose() }
    $rsa.Dispose()
  }
  Write-Host "開発用自己署名TLS証明書を生成しました: $Directory"
}

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

  Ensure-LocalTlsCertificate (Join-Path $project ".secrets\tls")

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
    $reload = Invoke-RestMethod -Method Post -Uri "https://127.0.0.1:3443/api/v1/events/demo-event-large/catalog/reload" -ContentType "application/json" -Body "{}" -SkipCertificateCheck -TimeoutSec 10
    $catalog = $reload.catalog
    $catalog.staffMembers = @($catalog.staffMembers | Where-Object { $_.responsibleNumber -eq "001" } | ForEach-Object { $_.role = "admin"; $_.permissions = @("catalog_import", "refund", "reprint"); $_ })
    if ($catalog.staffMembers.Count -eq 0) { throw "Recovery catalog does not contain responsible number 001." }
    $body = $catalog | ConvertTo-Json -Depth 20
    $webSession = New-Object Microsoft.PowerShell.Commands.WebRequestSession
    $authBody = @{ eventId = "demo-event-large"; responsibleNumber = "001"; terminalId = "recovery-bootstrap" } | ConvertTo-Json
    Invoke-RestMethod -Method Post -Uri "https://127.0.0.1:3443/api/v1/auth/sessions" -ContentType "application/json" -Body $authBody -WebSession $webSession -SkipCertificateCheck -TimeoutSec 10 | Out-Null
    Invoke-RestMethod -Method Put -Uri "https://127.0.0.1:3443/api/v1/events/demo-event-large/catalog" -ContentType "application/json" -Body $body -WebSession $webSession -SkipCertificateCheck -TimeoutSec 10 | Out-Null
    Write-Host "Initialized demo-event-large with responsible 001 (admin) only."
  }

  if ($SkipBuild) { docker compose up -d --wait pos-training }
  else { docker compose up -d --wait pos-training }
  if ($LASTEXITCODE -ne 0) { throw "Training service startup failed." }

  $checks = @(
    @{ Uri = "https://127.0.0.1:3443/health/ready"; SkipCertificateCheck = $true },
    @{ Uri = "http://127.0.0.1:3002/health/ready"; SkipCertificateCheck = $false }
  )
  foreach ($check in $checks) {
    $request = @{ UseBasicParsing = $true; Uri = $check.Uri; TimeoutSec = 10 }
    if ($check.SkipCertificateCheck) { $request.SkipCertificateCheck = $true }
    $response = Invoke-WebRequest @request
    if ($response.StatusCode -ne 200 -or $response.Content -notmatch '"status"\s*:\s*"ok"') { throw "Health check failed: $($check.Uri)" }
    Write-Host "$($check.Uri) : ok"
  }
  docker compose ps
} catch {
  [System.Media.SystemSounds]::Hand.Play()
  throw
} finally { Pop-Location }

$tada = Join-Path $env:WINDIR "Media\tada.wav"
if (Test-Path -LiteralPath $tada) {
  (New-Object System.Media.SoundPlayer($tada)).PlaySync()
}
