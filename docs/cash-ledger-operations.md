# 現金管理バックエンド運用・受入手順

## 受入シナリオ

1. `POST /api/v1/cash-sessions` で営業セッションを開く。
2. `checks/opening` に金種別実有高を登録する。
3. `movements` に売上・返品・入出金を、必ず一意な `idempotencyKey` 付きで登録する。
4. `checks/interim` で中間点検を行い、実査額と過不足を確認する。
5. 追加の現金移動後、`checks/closing` に実査額と `carryoverYen` を登録する。
6. 精算後の現金移動・点検が拒否されることを確認する。
7. 訂正が必要な場合は、理由・担当者・端末を指定して `reopen` を実行する。過去の精算記録は削除しない。

## SQLiteバックアップ

稼働中のDBファイルを直接コピーせず、サービス停止後にWALを含む3ファイルを保存する。

```sh
docker compose stop pos
docker run --rm -v event-pos_pos-data:/data -v "$PWD/backups:/backup" alpine \
  sh -c 'tar czf /backup/event-pos-$(date +%Y%m%d-%H%M%S).tgz -C /data .'
docker compose start pos
```

復旧時はサービスを停止し、バックアップをボリュームへ展開してから起動する。起動後に `/health/ready` と営業セッションの取得APIを確認し、取引・点検・監査ログが残っていることを確認する。

## 注意事項

- `idempotencyKey` は同じ操作の再送で再利用し、別内容に流用しない。
- `differenceYen` の候補検索結果は原因ではなく、調査候補として扱う。
- PIN、パスワード、セッショントークンを理由欄・監査詳細・ログへ記録しない。
- 現在のHTTP APIは認証機構をまだ提供していない。本番LAN公開前に認証・権限ミドルウェアを追加する。
