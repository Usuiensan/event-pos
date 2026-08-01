# TM-T70II実機証跡テンプレート

- 実施日・会場:
- 実施者:
- OS / kernel / architecture:
- printer model / serial / firmware:
- paper width:
- device path (`ls -l`):
- `lsusb` / udev情報:
- printer-host commit:
- systemd unit状態:
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

送信途中で結果不明になったジョブは自動再送せず、紙面確認後に明示的な再印刷を行う。
