# 18. 即売会運用画面・全部返品・本番バックアップ設計

## 1. 目的と完了境界

次回即売会で責任者がAPIを直接操作せず、業務メニューから開局、現金移動、中間点検、精算、再開、返品、障害確認を完結できるようにする。確定取引、現金台帳、在庫移動、点検、印刷operation、監査はSQLiteを正本とし、画面状態やExcelを正本にしない。

本機能は、次の4領域を独立したtransaction境界と受入証拠で実装する。

1. 現金管理UI
2. 責任者向け運用ダッシュボード
3. 元取引に対する全部返品
4. 本番artifact保存ポリシー

TM-T70IIの紙面、USB、status、service復旧はWindows/Linux双方の実機証拠が揃うまで完了扱いにしない。

## 2. 現金管理UI

### 2.1 状態とAPI

同じevent、営業日、cashboxのcash sessionは一つを使用する。画面再読込時はDBから復元し、localStorageだけで開局済み・精算済みを判断しない。

| API | 用途 |
| --- | --- |
| `GET /api/v1/cash-sessions/current` | event、営業日、cashboxから現在のsession、理論現金、直近点検を取得 |
| `GET /api/v1/cash-sessions/{id}` | session、台帳、点検、理論現金を取得 |
| `POST /api/v1/cash-sessions` | sessionを作成。既存scopeがあればそのsessionを返す冪等動作 |
| `POST /api/v1/cash-sessions/{id}/movements` | 入金・出金を理由付きで追記 |
| `POST /api/v1/cash-sessions/{id}/checks/{kind}` | 開局、中間点検、精算を確定 |
| `POST /api/v1/cash-sessions/{id}/reopen` | 精算済みsessionを責任者・理由付きで再開 |

金種は1、5、10、50、100、500、1,000、5,000、10,000円を表示し、数量から実在高を計算する。金額は非負の安全整数円、数量は非負整数とする。開局は準備金実査、中間点検・精算は理論現金、実在高、過不足を確定前に表示する。精算だけ翌日残しを必須にし、実在高以下とする。

### 2.2 操作確認

DB変更前に、操作名、event、営業日、cashbox、実行者、理論現金、実在高、過不足、入出金額または翌日残しを確認画面へ表示する。利用者が明示的に「確定」を押した場合だけAPIを呼ぶ。二重tapは同じIdempotency-Keyで再送し、送信中は操作を無効にする。

精算成功とartifact生成成功を混同しない。精算API成功後は「精算確定済み／成果物生成待ち」を表示し、artifact APIをpollしてcompletedまたはfailedを別表示する。

## 3. 運用ダッシュボード

責任者権限の`GET /api/v1/operations/dashboard`を追加し、次を一つのsnapshotとして返す。

- DB readiness、schema version、DB path
- PrinterHost reachableと正規化status。取得不能値は`unknown`
- print jobのpending、retry_wait、sending、failed/not_sent、failed/unknown件数
- 最終transport accepted/completed日時
- DB保存先、artifact root、mirror rootの総容量・空き容量・警告状態
- 最終completed artifact、failed artifact件数
- cashboxごとの開局、中間点検、精算日時と過不足
- register別のstaff WebSocket接続数・最終通信、customer heartbeat状態・最終通信

ファイルシステム状態やPrinterHost取得に失敗した場合はdashboard全体を成功扱いにせず、項目単位で`ok`、`warning`、`error`、`unknown`を返す。画面は色だけでなく日本語ラベルを表示し、2秒間隔で更新する。

## 4. 全部返品

### 4.1 不変条件

- 元取引、元明細、元支払、元税、元在庫移動、元現金移動、元print jobを更新・削除しない。
- 返品は元取引を参照する新しい`transactions.type=return`とし、明細・支払・税は相殺値を追記する。
- 元取引がsaleでない場合、既に全部返品済みの場合、別eventの場合、cash sessionが精算済みの場合は拒否する。
- 初期版は全部返品だけとし、部分返品を実装しない。
- 現金支払は`cash_movements.type=return`を正の返金額で追記し、理論現金計算では減算する。
- 在庫は元販売数量を正の`inventory_movements.type=return`として戻す。
- credit・売掛は責任者が外部返金済みを明示してから`payments.external_result=refunded`を保存する。外部決済を成功と推測しない。
- 同じIdempotency-Keyは同じ結果を返し、異なるpayloadでの再利用を拒否する。

### 4.2 APIとUI

| API | 用途 |
| --- | --- |
| `GET /api/v1/transactions/search?q=` | 受付番号またはtransaction ID完全一致で元取引を検索 |
| `POST /api/v1/transactions/{id}/returns` | 責任者、理由、外部返金確認、Idempotency-Keyを受けて全部返品を原子的に確定 |

確認画面には元受付番号、日時、担当者、商品・数量、支払方法、返金額、在庫戻し数量、理由、責任者番号を表示する。確定後は新しい返品受付番号と返品レシートjob状態を表示する。

返品transaction、相殺明細、相殺支払、相殺税、在庫戻し、現金返金、audit、返品print job/operationは同一DB transactionで確定する。印刷失敗は返品をrollbackせず、print jobだけを失敗またはunknownとして表示する。

## 5. 本番artifact保存ポリシー

| 設定 | 意味 |
| --- | --- |
| `POS_ARTIFACT_ROOT` | primary成果物の絶対パス。本番では稼働DBとは別の永続diskを推奨 |
| `POS_ARTIFACT_MIRROR_ROOT` | 任意の二次保存先。primary公開後に同一artifact IDで検証コピー |
| `POS_ARTIFACT_MIN_FREE_BYTES` | 生成開始前に必要な空き容量。既定2 GiB |

relative path、DBファイル自身、root directory、既存artifact directoryへの上書きを拒否する。生成前と公開前に空き容量を確認し、閾値未満は`STORAGE_LOW`、容量不足は`STORAGE_FULL`としてfailedへ保存する。primary成功後のmirror失敗はprimaryを削除せず、mirror状態と理由をDB・manifest・dashboardへ明示する。

POS service accountだけにprimary/mirrorの読書きを許可する。POSはPOSIX modeを設定するが、Windows ACLの適用成功を推測しない。導入scriptでACLを設定・照合し、結果をログへ保存する。

日計後はprimary、mirrorの3ファイルをhash照合し、別DB restore smokeを実行するrunbookを用意する。保持期限削除は自動化せずADR-D018の責任者承認手順に従う。

## 6. 自動試験・実画面受入

- 開局、入金、出金、中間点検、精算、artifact成功／失敗、再開をAPIとUI state testで照合する。
- 二重tap、再読込、API timeout後再送、精算後操作拒否を照合する。
- dashboardのDB、printer状態、queue集計、容量、artifact、cash check、staff/customer接続をfixtureで照合する。
- 現金、credit、売掛、無配の全部返品について、元取引不変、新transaction、相殺支払・税、在庫戻し、現金返金、audit、返品receiptを照合する。
- 二重返品、部分返品要求、精算後返品、外部返金未確認、Idempotency-Key不一致を拒否する。
- primary低容量、mirror失敗、再起動、既存directory衝突を注入し、確定済みcash checkとprimary成功成果物を失わない。
- iPad横・PC横で業務メニュー、現金管理、dashboard、返品確認を実ブラウザーで操作し、状態を色と文言で判別できることを確認する。

