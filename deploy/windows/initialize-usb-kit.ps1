$ErrorActionPreference = 'Stop'
$kit = $PSScriptRoot
$database = Join-Path $kit 'data\event-pos.sqlite'
if (Test-Path -LiteralPath $database) { throw "DBは既に存在します。初期化を中止します: $database" }

Write-Host '初回セットアップ: 商品一覧は空で作成します。'
$eventId = Read-Host 'イベントID（英小文字・数字・ハイフン、2〜63文字）'
$eventName = Read-Host 'イベント名'
$businessDate = Read-Host '営業日（YYYY-MM-DD）'
$circleName = Read-Host 'サークル名'
$space = Read-Host 'スペース（未定なら空欄）'
$receiptIssuerName = Read-Host 'レシート発行者名（空欄ならサークル名を使用）'
if ([string]::IsNullOrWhiteSpace($receiptIssuerName)) { $receiptIssuerName = $circleName }
foreach ($pair in @(@('イベント名', $eventName), @('サークル名', $circleName), @('レシート発行者名', $receiptIssuerName))) {
  if ([string]::IsNullOrWhiteSpace($pair[1])) { throw "$($pair[0])は必須です。初期設定をやり直してください。" }
}
if ($eventId -notmatch '^[a-z0-9][a-z0-9-]{1,62}$') { throw 'イベントIDの形式が不正です。' }
try { $parsedDate = [DateTime]::ParseExact($businessDate, 'yyyy-MM-dd', [Globalization.CultureInfo]::InvariantCulture) } catch { throw '営業日は実在する日付をYYYY-MM-DDで入力してください。' }

$setupPath = Join-Path $env:TEMP "event-pos-usb-setup-$([guid]::NewGuid().ToString('N')).json"
$setup = [ordered]@{ eventId = $eventId; eventName = $eventName.Trim(); businessDate = $businessDate; circleName = $circleName.Trim(); space = $space.Trim(); receiptIssuerName = $receiptIssuerName.Trim() }
try {
  $setup | ConvertTo-Json -Compress | Set-Content -LiteralPath $setupPath -Encoding UTF8
  $config = Join-Path $kit 'event-config\usb-kit-initial'
  & (Join-Path $kit 'runtime\node.exe') (Join-Path $kit 'server\dist\initialize-usb-db.js') $database $config $setupPath
  if ($LASTEXITCODE -ne 0) { throw '初期DBの作成に失敗しました。' }
  Write-Host '初期DBを作成しました。管理者の責任者番号は001です。'
} finally { Remove-Item -LiteralPath $setupPath -Force -ErrorAction SilentlyContinue }
