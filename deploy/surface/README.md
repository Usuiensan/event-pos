# Surface一時運用ランブック

対象はDocker Desktopが動くWindows Surfaceと、WindowsへUSB接続した`EPSON TM-T70II Receipt`です。

## 初回準備

```powershell
Copy-Item .env.example .env
docker compose config
docker compose build
```

Windows printer-hostは別ターミナルで起動します。

```powershell
$env:PRINTER_BACKEND = "windows-spooler"
$env:PRINTER_NAME = "EPSON TM-T70II Receipt"
$env:POS_BASE_URL = "http://127.0.0.1:3000"
$env:PORT = "4318"
pnpm --filter @event-pos/printer-host dev
```

## 開局

```powershell
docker compose up -d --build
docker compose ps
Invoke-WebRequest http://127.0.0.1:3000/health/ready
Invoke-WebRequest http://127.0.0.1:4318/health/live
```

ブラウザーで`http://127.0.0.1:3000`を開き、テストレシートを1枚印刷する。Windowsのプリンター状態がNormalで、印刷キューが0件へ戻ることを確認する。

## 営業中の障害対応

- プリンター切断: 会計データは保持される。printer-hostを再起動し、ジョブ状態が`unknown`のものは紙面確認後に明示再印刷する。
- Docker停止: `docker compose ps`、`docker compose logs pos`、`docker compose restart pos`の順で確認する。
- Surfaceスリープ: 電源接続、スリープ無効化、Docker Desktop自動起動を確認する。

## 閉局とバックアップ

```powershell
docker compose exec pos node -e "const {DatabaseSync}=require('node:sqlite'); const db=new DatabaseSync(process.env.POS_DATABASE_PATH); db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); db.close()"
docker compose cp pos:/var/lib/event-pos/event-pos.sqlite .\backup\event-pos-$(Get-Date -Format yyyyMMdd-HHmmss).sqlite
docker compose down
```

バックアップファイルはSurface本体以外の媒体へコピーする。`docker compose down -v`はvolumeを削除するため、復旧確認なしには実行しない。

## 復旧

1. 既存の`pos-data` volumeを削除せず、バックアップを別名で保存する。
2. 必要なら一時Composeを停止し、SQLite integrity checkを行う。
3. 復旧対象DBをvolumeへ戻し、`docker compose up -d`する。
4. `/health/ready`、プリンター状態、テストレシート、取引検索を確認する。
5. 復旧操作と使用したcommit・DB hashを記録する。
