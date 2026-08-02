# 現金管理バックエンド受入チェックリスト

## 自動確認

```powershell
pnpm check
docker compose up -d --build
Invoke-WebRequest http://127.0.0.1:3000/health/ready
docker compose restart pos
Invoke-WebRequest http://127.0.0.1:3000/health/ready
docker compose down
```

server統合テストでは、開局、金種別実査、売上、返品、中間点検、精算、翌日残し額、再開、冪等性、同時二重開局、権限拒否、SQLite再オープン復元を確認する。

## API受入順序

1. `POST /api/v1/cash-sessions`（`cashboxId`を指定）
2. `POST /api/v1/cash-sessions/:id/checks/opening`
3. `POST /api/v1/cash-sessions/:id/transactions/sale`
4. `POST /api/v1/cash-sessions/:id/checks/interim`
5. 追加売上・返品・入出金
6. `POST /api/v1/cash-sessions/:id/checks/closing`（`carryoverYen`を指定）
7. 閉局後操作が拒否されることを確認
8. 必要時のみ manager 権限で `reopen`

## 本番投入前の確認

- `POS_REQUIRE_CASH_AUTH=true` を設定する
- `x-pos-role` と `x-pos-actor-id` は実際の認証ミドルウェアから付与する
- PIN、パスワード、トークンを理由・メモ・監査詳細へ入れない
- SQLiteボリュームの定期バックアップを設定する
- 返品・取消・再開は責任者手順と照合する
- ジャーナル候補は原因と断定せず、紙レシート・在庫・現金実査と突合する

## 既知の制約

現在の権限境界はHTTPヘッダーを信頼する最小実装であり、インターネット公開用の認証ではない。POS専用LANでの利用を前提に、実運用では認証プロキシまたは端末認証を前段へ追加する。
