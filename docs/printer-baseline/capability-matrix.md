# TM-T70II 接続方式別能力表

この表の空欄を推測で埋めない。`supported` はraw responseと紙面/障害証跡、`unsupported` は方式または公式資料で不可能と確認した証跡、`unknown` は未測定または応答不能を表す。

| OS / architecture | 方式 | reachable | online | cover | paper | recoverable error | fatal error | 証跡 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Windows x64 | Winspool RAW `WritePrinter` | unknown | unknown | unknown | unknown | unknown | unknown | spooler job 3が313 bytesを受理、device-level status/紙面は未確認 |
| Windows x64 | EPSON driver/API | unknown | unknown | unknown | unknown | unknown | unknown | 未測定 |
| Windows x64 | OPOS | unknown | unknown | unknown | unknown | unknown | unknown | 未測定 |
| Linux x86_64 | `/dev/usb/lp*` | unknown | unknown | unknown | unknown | unknown | unknown | `linux-x86_64/manifest.json` を作成後に更新 |
| Linux ARM64 | `/dev/usb/lp*` | unknown | unknown | unknown | unknown | unknown | unknown | `linux-arm64/manifest.json` を作成後に更新 |
| Linux x86_64/ARM64 | libusb | unknown | unknown | unknown | unknown | unknown | unknown | RAW経路で不足時のみ測定 |

`acceptedBytes` はOSまたはspoolerが受け取ったbytesであり、紙面排出・バーコード実読取り・部分cut完了を保証しない。
