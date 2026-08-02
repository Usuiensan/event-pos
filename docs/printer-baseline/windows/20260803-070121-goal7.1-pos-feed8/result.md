# Goal 7.1 Windows x64 POS統合受入（8行feed）

- run ID: `68999f95-c791-47ea-922c-2da7c9822536`
- platform: Windows x64 / Node.js v24.18.0 / PowerShell 7.6.4
- printer: EPSON TM-T70II Receipt / Winspool RAW
- 現在状態: `in_progress`。開局・現金会計初回は送信・紙面確認済み。再印刷承認待ち
- drawer: `DRAWER_ENABLED=false`。駆動していない

## 送信結果と紙面結果

transportの全bytes受理と紙面結果は別に判定する。

| 種別 | jobId | payload SHA-256 | acceptedBytes | spoolerJobId | 紙面 |
| --- | --- | --- | ---: | ---: | --- |
| 開局 | `ed593bb2-eef1-4e2b-b214-234d0090d600` | `baba1bdf391f39cdef15a57b88e52ec958e2a239ae0d39c935953d91ee6385e2` | 295 | 13 | printed。全文・配置・文字化け・partial cut OK |
| 現金会計・初回 | `019fc482-8f45-7960-a43f-a499dec98d8a` | `aa2097e569a72a4d963845333c4eff3a69e5dd0fd7523c55b7e76af5e288c011` | 553 | 14 | printed。全文・配置・文字化け・partial cut OK |

両jobはproduction末尾の8行feedを含む。写真では営業日`2026-08-03`、受付番号`1000-0012`、日本語全文、最終文字より下の余白、部分cutを確認できる。

## 紙面写真

- `paper-opening-original.jpg`: SHA-256 `7916eb51b3787c5652fa2e7d63d5380b26ee2d1f6903507a1db5fb8adf53d617`、653002 bytes
- `paper-opening-original-attachment.jpg`: SHA-256 `62035ad5d3dfad999bf2d9b39009ef0ca1df4646113c8744fd8c27dd0be166b3`、152862 bytes

2ファイルは同じ開局・初回レシートを別解像度で記録した証跡である。

## PrinterHost/POS再起動

開局・初回の2 operationsが`completed`、attempt count各1であることをSQLiteから確認した後、PrinterHostを停止してPowerShell 7の正式launcherから再起動した。`printer-host-restart.jsonl`には2026-08-02T22:07:36.530Zの`host_started`だけがあり、完了済みjobの`dispatch_started`はない。続いて同じSQLiteでPOS serverを再起動し、5秒後もjob 2件・operations 2件・attempts 2件のままで自動再送されなかった。

再起動後のPOS status中継では`reachable=true`。Winspool RAWで取得できないonline、cover、paper、device errorはすべて`unknown`のままである。

## 残件

初回紙面がprintedのため、再印刷には重複riskの明示承認`REPRINT`を要求している。承認前にrunnerは再印刷jobを作成しない。再印刷、中間計、精算の送信・紙面証跡が揃うまで、このrunをWindows Acceptedへ数えない。
