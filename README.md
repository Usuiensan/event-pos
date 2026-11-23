# ぽすりん

同人誌・グッズ等の即売会向けWeb POSです。単一のPOSサーバーとSQLiteを正本とし、レジ端末・顧客画面・管理画面をブラウザーから利用します。

## 文書の扱い

現行仕様の正本は [`docs/CURRENT_SPEC.md`](docs/CURRENT_SPEC.md) です。

本番投入前に最低限確認する内容は [`docs/PRODUCTION_MINIMUM.md`](docs/PRODUCTION_MINIMUM.md) にまとめています。過去のGoal、ADR、受入台帳、AI向け継続プロンプトは正本にしません。

実装と文書が食い違う場合は、現在のコードと自動テストを確認し、文書を実装へ合わせて更新します。新しい要件は、ユーザーが明示したものか、会計整合性・データ損失防止・セキュリティ上必要なものに限って追加します。

## 現在の主な実装

- 永続sale draft、サーバー側金額再計算、draft version、Idempotency-Key
- 売上・明細・支払・在庫・現金台帳・監査・初回印刷jobの原子的確定
- 現金、クレジット記録、売掛、無配、預り金・釣銭
- 在庫移動、マイナス在庫、取り置き
- 18歳/20歳の年齢確認
- 全部返品、レシートなし返品
- 顧客画面、heartbeat、WebSocket/REST復元
- EPSON TM-T70II向けESC/POS、永続印刷キュー、再印刷
- 開局、入出金、中間点検、精算
- SQLite backup、xlsx、manifest成果物
- 分割YAMLの商品・イベント設定と、互換用JSONインポート

詳細と既知の制限は [`docs/CURRENT_SPEC.md`](docs/CURRENT_SPEC.md) を参照してください。

## 開発環境

Node.js 24以上、pnpm 11を使用します。

```powershell
pnpm install
pnpm check
pnpm --filter @event-pos/server dev
pnpm --filter @event-pos/register-web dev
```

`pnpm check` はbuild、typecheck、workspace test、PrinterHost smoke testを実行します。

## Docker

現在のDocker本番プロファイルはHTTPS `3443`、トレーニングPOSはHTTP `3002`です。

```powershell
docker compose up -d --build --wait
docker compose ps
Invoke-WebRequest -SkipCertificateCheck https://127.0.0.1:3443/health/ready
Invoke-WebRequest http://127.0.0.1:3002/health/ready
```

本番画面例:

```text
https://127.0.0.1:3443/?register=1&role=staff
```

トレーニング画面例:

```text
http://127.0.0.1:3002/?register=1&role=staff&mode=training
```

WindowsでTM-T70IIへ印刷する場合はPrinterHostを起動します。

```powershell
.\deploy\windows\start-printer-host.ps1
Invoke-WebRequest http://127.0.0.1:4318/health/live
```

## USB起動セット

WindowsとmacOSのUSB起動セットでは、POSとPrinterHostを1つのコンソールから起動できます。稼働中は変更のあったSQLite DBをUSBへ自動保存します。異常終了後は、同じPC・ユーザー・USBで起動するとDBを自動復旧します。作成手順は [Windows版](deploy/windows/README.md) と [macOS版](deploy/macos/README.md) を参照してください。

## 設定・運用資料

- [`docs/CURRENT_SPEC.md`](docs/CURRENT_SPEC.md): 現行仕様
- [`docs/PRODUCTION_MINIMUM.md`](docs/PRODUCTION_MINIMUM.md): 本番までの最低限
- [`docs/operations/取扱説明書.md`](docs/operations/取扱説明書.md): 当日運用
- [`docs/event-config-yaml.md`](docs/event-config-yaml.md): 分割YAML設定
- [`docs/register-catalog-json.md`](docs/register-catalog-json.md): 互換用JSON設定
- [`docs/UI_POLICY.md`](docs/UI_POLICY.md): UI変更時の方針
- `docs/printer-baseline/`: 実機で取得したプリンター証跡。要件ではなく技術資料
- `docs/意匠チェック/`: UIの意匠確認資料

## 秘密情報

`.env`、token、PIN、秘密鍵、本番DB、身分証情報、個人情報を含むログはGitへcommitしません。
