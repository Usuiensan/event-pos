# TM-T70II実機証跡テンプレート

- 実施日・会場:
- 実施者:
- OS / kernel / architecture:
- printer model / serial / firmware:
- paper width:
- device path / Windows printer・port:
- `lsusb` / udev / Windows driver・spooler情報:
- printer-host commit:
- Windows Service / systemd unit状態:
- 入力jobId / transactionId:
- payload・ESC/POS bytes SHA-256:
- 結果: `completed` / `failed` / `unknown`
- 紙面写真または動画:

## 障害シナリオ

| シナリオ | 実施操作 | status/API結果 | 紙面結果 | ログ/証跡 |
| --- | --- | --- | --- | --- |
| 正常印刷 |  |  |  |  |
| 紙切れ |  |  |  |  |
| カバー開 |  |  |  |  |
| USB切断 |  |  |  |  |
| 再接続 |  |  |  |  |
| printer-host再起動 |  |  |  |  |
| OS再起動 |  |  |  |  |

送信途中で結果不明になったジョブは自動再送せず、紙面確認後に明示的な再印刷を行う。
