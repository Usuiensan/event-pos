# 17. Goal 8 自動バックアップ・単一Excel帳票設計

## 1. 決定と境界

中間計 `interim` または精算 `closing` のcash checkを確定した直後に、同じevent、営業日、cashbox、cash sessionへ紐づく次の3ファイルを一つの成果物IDで自動生成する。

- SQLite snapshot: 復旧用の一貫したDBバックアップ
- Excel `.xlsx`: 閲覧、集計、外部変換の入力に使うcanonical帳票
- `manifest.json`: 抽出条件、schema version、件数、金額、各ファイルのSHA-256を照合する検証情報

稼働SQLiteだけを業務データの正本とする。SQLite snapshotは復旧用、Excelは可読な交換・突合用、manifestは完全性検証用であり、Excelから正本DBへ書き戻さない。特定会計ソフトの勘定科目や取込形式は実装しない。

cash checkと成果物生成のtransaction境界を分離する。cash check確定transactionには監査、点検記録、印刷operationと `backup_artifacts.state=pending` の登録までを含める。snapshot、Excel、manifestのファイルI/Oはcommit後に行う。生成に失敗してもcash checkやclosingをrollbackせず、成果物だけを `failed` として保存する。

## 2. migration

`backup_artifacts` は次の状態と識別情報を持つ。

| 列 | 意味 |
| --- | --- |
| `artifact_id` | UUIDv7。3ファイルと保存ディレクトリに共通の識別子 |
| `event_id`, `business_date`, `cashbox_id`, `cash_session_id` | 抽出範囲 |
| `source_cash_check_id` | 自動生成元のcash check |
| `trigger_kind` | `interim`、`closing`、`manual_regeneration` |
| `retry_of_artifact_id` | 手動再生成元。旧成果物は変更しない |
| `request_key` | 自動生成または手動再生成要求の冪等キー。全体で一意 |
| `state` | `pending`、`generating`、`completed`、`failed` |
| `requested_by`, `requested_at`, `started_at`, `completed_at` | 実行者と時刻 |
| `output_directory`, `backup_path`, `workbook_path`, `manifest_path` | 保存先 |
| `backup_sha256`, `workbook_sha256`, `manifest_sha256` | ファイルhash |
| `snapshot_logical_sha256` | 対象主要表をcanonical JSON化した論理hash |
| `row_counts_json`, `totals_json` | 読戻し・復元照合用の件数と金額 |
| `error_code`, `error_message`, `attempt_count` | 失敗・試行情報 |

`source_cash_check_id` と自動生成契機を一意にし、同じcash checkの二重登録を防ぐ。手動再生成は新しい成果物IDを割り当て、`request_key` の再送だけ同じ結果を返す。

## 3. 一貫snapshotと公開手順

1. 最終保存先とは別の同一filesystem上に、成果物IDとnonceを含む一時ディレクトリを作る。
2. SQLiteの `VACUUM INTO` を使い、WALファイルの途中コピーではない一貫した単一DB snapshotを作る。
3. snapshot DBをread-onlyの入力として各Excelシート、件数、金額、論理hashを生成する。
4. Excelを実際に読戻し、必須シート、件数、売上・支払・税・現金合計を検証する。
5. snapshot DBへ `PRAGMA integrity_check` を行い、manifestにbackupとExcelのSHA-256、件数、金額、論理hashを記録する。
6. 3ファイルをcloseしhashを再計算した後、一時ディレクトリを成果物IDの最終ディレクトリへrenameする。
7. 最終パスとhashをDBへ保存して `completed` にする。全条件を確認できない場合は `failed` とし、成功を推測しない。

一時停止や容量不足で一時ファイルが残っても最終ディレクトリを成功扱いにしない。起動時に残った `generating` は `INTERRUPTED` で `failed` へ遷移させ、責任者が新しい成果物IDで再生成する。複数workerのclaimは `BEGIN IMMEDIATE` 内の条件付きUPDATEで1件に限定する。

## 4. 保存先、ファイル名、権限、保持

既定rootは稼働DBと同じdata領域の `artifacts` とし、`POS_ARTIFACT_ROOT` で絶対パスを指定できる。

```text
<root>/<event-id>/<business-date>/<cashbox-id>/<artifact-id>/
  <event>_<business-date>_<cashbox>_<artifact-id>.sqlite
  <event>_<business-date>_<cashbox>_<artifact-id>.xlsx
  <event>_<business-date>_<cashbox>_<artifact-id>.manifest.json
```

パス要素はASCII英数字、`-`、`_`以外を `_` に置換し、長さを制限する。ディレクトリはPOS service accountだけが読める `0700`、ファイルは `0600` 相当を指定する。WindowsではACLの正本を導入runbookに置き、mode bitだけで保護済みと推測しない。

最終ディレクトリとファイルは上書き禁止とする。保持期限に基づく自動削除は実装せず、ADR-D018の停止、直前backup、対象一覧、責任者承認、削除証跡、必要時の鍵破棄を伴う保守runbookへ委ねる。

## 5. Excel列定義

ブック形式はOffice Open XML `.xlsx`。文字列はUnicode、金額は整数円、税率はbasis points、日時はUTCのExcel日時として保存し、表示形式を `yyyy-mm-dd hh:mm:ss` とする。識別子、商品コード、受付番号は文字列のまま保存する。全シートで1行目をfreezeし、auto filterを有効にし、ヘッダー色、列幅、折返しを固定する。

| シート | 主な列 |
| --- | --- |
| `概要` | 成果物ID、event、営業日、cashbox、cash session、契機、生成日時、schema version、各件数・合計 |
| `売上` | transaction ID、受付番号、register、staff、種別、小計、値引、税、合計、支払種別、確定日時 |
| `売上明細` | transaction/line ID、行番号、商品ID/コード/名称、税込単価、税率、数量、gross、値引、税、net、日時 |
| `支払` | payment/transaction ID、順序、支払種別・名称、金額、預り、釣銭、外部結果、参照、日時 |
| `税` | tax summary/transaction ID、税率、税込対象、値引配賦、課税対象、税額、丸め |
| `在庫移動` | movement ID、event、商品ID/コード、種別、数量差、transaction line、実行者、日時 |
| `現金台帳` | movement ID、cash session、種別、金額、transaction、理由、実行者、端末、日時 |
| `点検締め` | check ID、cash session、種別、理論現金、実在高、過不足、翌日残し、実行者、端末、日時 |
| `印刷Operation` | operation/job ID、sequence、種別、printer、文書種別、状態、certainty、hash、試行数、error、日時 |
| `監査` | audit ID、event、action、entity種別/ID、detail JSON、日時 |

抽出対象は同じeventと営業日のデータで、cashbox固有データはcash sessionで絞る。event共通の売上・在庫・印刷・監査はbusiness day境界と生成元cash checkの確定時刻以前に限定し、中間計後の取引を混入させない。

## 6. APIと画面

| method/path | 用途 |
| --- | --- |
| `GET /api/v1/backup-artifacts` | event、営業日、cashboxで成果物一覧を取得 |
| `GET /api/v1/backup-artifacts/{artifactId}` | 保存先、hash、件数、金額、失敗理由を取得 |
| `POST /api/v1/backup-artifacts/{artifactId}/regenerate` | 責任者が新成果物IDで再生成。`Idempotency-Key`必須 |

業務メニューは `pending=生成待ち`、`generating=生成中`、`completed=成功`、`failed=失敗` を色と文言の両方で区別する。成功時は保存先と3 hashを表示し、失敗時は失敗理由と再生成buttonを表示する。生成待ち・生成中・成功は再生成不可、失敗だけ再生成可とする。

## 7. 自動試験と完了境界

- 中間計と精算の双方で自動成果物が作られる。
- 実xlsxを別readerで開き、10シート、行数、売上・支払・税・現金の合計をSQLite snapshotと照合する。
- backupを別パスへ復元して開き、売上、支払、在庫、現金、監査、印刷job/operationの件数・金額・論理hashと `integrity_check=ok` を照合する。
- 同じcheckの二重実行、同じ再生成Idempotency-Keyの再送、二重worker claimで成果物を重複公開しない。
- snapshot後、Excel後、manifest前、公開前、容量不足相当のfailure injectionでcheck確定を保持し、成果物だけfailedにする。
- 起動時に生成中断をfailedへ確定し、新しい成果物IDで安全に再生成できる。
- UIの4状態、保存先、hash、失敗理由、再生成可否をunit testと実ブラウザーで確認する。

暗号化event archive、保持期限後削除、未実装の返品・取り置き・締めissue全体は本機能だけで完了扱いにしない。Goal 8の残件として別証拠を必要とする。
