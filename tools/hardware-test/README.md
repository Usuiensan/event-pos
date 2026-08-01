# Linuxプリンター実機試験ツール

TM-T70IIへ固定fixtureを送信し、送信方式、状態取得、障害復旧を比較するCLIをここへ実装する。

初期比較対象:

- `/dev/usb/lp*`への直接送信
- 双方向statusが必要な場合のlibusb等
- Debian既存環境の出力bytes・紙面・systemd・USB設定
- x86_64 LinuxとARM64 Linux

実機を接続するまで、送信方式や取得可能なstatusを確定扱いにしない。印刷成功とstatus取得失敗を別々に記録する。

## printer-host CLI

Linux実機で次を実行すると、固定fixtureをRAWデバイスへ1回送信し、結果とbytes SHA-256をJSONへ保存する。

```sh
PRINTER_DEVICE=/dev/usb/lp0 PRINTER_EVIDENCE_DIR=./evidence/tm-t70ii \
  pnpm --filter @event-pos/printer-host hardware-test
```

`statusBefore=unknown`でも送信可否と印刷結果を分離して記録する。デバイスが未指定の場合はデバイスへ触れず終了コード2とする。送信途中のI/Oエラーは`unknown`として保存し、自動再送しない。
