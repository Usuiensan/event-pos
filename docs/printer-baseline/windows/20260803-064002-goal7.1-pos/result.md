# Windows Goal 7.1 POS実機run（失敗証跡）

- run ID: `766bce19-525c-4200-931d-2bf84a785f01`
- 判定: **不合格・再実施必須**
- 実行環境: Windows x64 / EPSON TM-T70II Receipt / Winspool RAW
- 安全条件: `DRAWER_ENABLED=false`、PrinterHost `reachable=true`。online、paper、cover、device errorはWinspool RAWで取得不能のため`unknown`

## 取得できた結果

| 種別 | jobId | payload SHA-256 | acceptedBytes | spoolerJobId | 紙面 |
| --- | --- | --- | ---: | ---: | --- |
| 開局 | `2efe5f7d-57ca-427d-b6fb-c654a887f40f` | `4861a83a98695f9a374f638a88792a90aeb4373fbc0dc356a3091cece85c1b0e` | 290 | 9 | 操作者はprinted、全文/配置/cut OK、文字化けなしと判定。写真あり |
| 現金会計・初回 | `019fc471-9c47-7dd2-8448-7373182009e3` | `0bed798800b2f2e75919cdcad1bfbc474d96723674f3e7ee455c4790c687c3cb` | 548 | 10 | 操作者はprinted、全文/配置/cut OK、文字化けなしと判定。ただし写真IDへ`ok`が入力され、写真証跡なし |

`paper-opening.png`のSHA-256は`64a624cd34e7ca524ad1138158dc6b3a866d0a8d8cbb3718bf2cc5a41c646ab5`。

## 不合格理由

1. 初回紙面を`printed`と確認した後、重複risk承認の`REPRINT`完全一致が得られず、安全停止した。再印刷、中間計、精算は送信していない。
2. 紙面写真から営業日が`2026-08-02`と判明した。JST 2026-08-03早朝にrunnerがUTC日付を使用した不具合であり、`bfa4363`でローカル日付へ修正した。
3. 初回レシートの写真証跡がない。

## runner外の送信

安全停止後、ユーザーが同じPOS DBでregister UIの入力を試し、saleが2件確定された。PrinterHostは次の2 jobも受理した。runnerの`jobs`/紙面レビューには含まれず、紙面結果も未確認なのでGoal 7.1の証跡へ数えない。runner外送信と判明するまで追加生成を凍結するためPOS serverを停止した。

| jobId | payment | payload SHA-256 | acceptedBytes | spoolerJobId |
| --- | --- | --- | ---: | ---: |
| `019fc473-a6e8-72c9-91d9-c7bdb724614a` | credit | `4dbc1b07f5a42e81f3fce406abdd10798edf66d4200de5b03bff20f3f01cc4f3` | 685 | 11 |
| `019fc475-6858-78fa-91a5-6bd88be61789` | cash | `a8319abea5fc28f28554a46251bcd5dbb9fa1f4eb5afeaa6fa78d7b93cb06923` | 813 | 12 |

このrunをWindows Goal 7.1のAccepted証跡へ数えない。正しい営業日で5帳票を再実施し、各紙面写真を保存する。
