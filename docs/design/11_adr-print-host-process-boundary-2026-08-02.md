# ADR-P008 POS本体とプリンターホストのプロセス境界

- Status: Accepted
- Date: 2026-08-02

## 決定

POS本体とプリンターホストを別プロセス・別責務として設計する。最初は同一Surfaceまたは同一Linux機に配置してよいが、通信境界を維持し、後から別のWindows PC、Debian/Ubuntu機、Raspberry Piへ移せるようにする。

POS本体は商品・価格、会計、在庫、取引、権限、監査、印刷ジョブ正本を担当する。プリンターホストは印刷キュー受信、ESC/POS変換、Epson USB送信、紙切れ・切断等の状態観測、結果返却を担当する。

## ジョブ契約

印刷要求には `jobId`、`transactionId`、`printerId`、`documentType`、不変payload、`createdAt` を含める。`jobId` は重複防止キーとし、同一ジョブの再送を二重印刷しない。

状態は `queued` → `accepted` → `printing` → `completed` / `failed` / `unknown` とする。データ送信成功は物理的な紙面完了を意味しない。送信途中の終了やUSB切断で判定不能な場合は `unknown` とし、自動再送せず、紙面確認後の明示的再印刷で扱う。

## 採用理由

- プリンター切断やドライバー障害でPOS会計を停止させない。
- Surface、N100、Raspberry Pi間でプリンターホストだけ交換できる。
- 実機なしでPOS本体とジョブ状態をテストできる。
- 将来の複数プリンター・複数端末に拡張しやすい。

初期通信は同一LAN内のHTTP APIとし、認証・Origin検査・タイムアウト・再接続を実装する。WebSocketは状態通知の追加用途とし、ジョブ正本や冪等性を接続状態へ依存させない。
