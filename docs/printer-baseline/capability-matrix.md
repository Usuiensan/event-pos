# TM-T70II 接続方式別能力表

この表の空欄を推測で埋めない。`supported` はraw responseと紙面/障害証跡、`unsupported` は方式または公式資料で不可能と確認した証跡、`unknown` は未測定または応答不能を表す。

| OS / architecture | 方式 | reachable | online | cover | paper | recoverable error | fatal error | 証跡 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Windows x64 | Winspool RAW `WritePrinter` | supported（USB PnPのpresent/absent観測のみ） | unknown | unknown（cover openでもqueue raw `0`/USB PnP `OK`） | unknown（紙切れでもqueue raw `0`/USB PnP `OK`） | unknown | unknown | USB切断でPnPが消失しqueue raw `4096`、再接続後はPnP `OK`/queue raw `0`。紙面完了やdevice-readyは別証跡 |
| Windows x64 | EPSON driver/API | unknown | unknown | unknown | unknown | unknown | unknown | 未測定 |
| Windows x64 | OPOS | unknown | unknown | unknown | unknown | unknown | unknown | OPOS for .NET/T70II componentは導入済み、logical device未設定のためOpen/Claim未実施 |
| Linux x86_64 | `/dev/usb/lp*` | supported | supported（正常時） | unknown（開時はDLE EOT応答不能） | unknown（紙切れ時はDLE EOT応答不能、near-endは`1e`で観測） | unknown | unknown | 正常DLE EOT `16/12/12/12`、切断時`ENODEV`、再接続後ready復帰 |
| Linux ARM64 | `/dev/usb/lp*` | 対象外 | 対象外 | 対象外 | 対象外 | 対象外 | 対象外 | 2026-08-03に実機未保有のためGoal 6の正式サポート対象から除外 |
| Linux x86_64 | libusb | unknown | unknown | unknown | unknown | unknown | unknown | RAW経路で不足時のみ測定 |

`acceptedBytes` はOSまたはspoolerが受け取ったbytesであり、紙面排出・バーコード実読取り・部分cut完了を保証しない。
