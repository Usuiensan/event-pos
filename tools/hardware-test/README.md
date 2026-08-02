# Windows/Linuxプリンター実機試験ツール

TM-T70IIへ固定fixtureを送信し、送信方式、状態取得、障害復旧を比較するCLIをここへ実装する。

初期比較対象:

- Windows RAW spooler、EPSON driver/API、OPOS
- Windows native printer-hostのportable/Service運用
- `/dev/usb/lp*`への直接送信
- 双方向statusが必要な場合のlibusb等
- Debian既存環境の出力bytes・紙面・systemd・USB設定
- Windows x64、Linux x86_64/ARM64

実機を接続するまで、送信方式や取得可能なstatusを確定扱いにしない。印刷成功とstatus取得失敗を別々に記録する。

## printer-host CLI

現在のCLIはLinux RAWデバイス用の雛形である。Goal 6でWindows/Linux共通fixtureとOS別probeへ拡張し、結果とbytes SHA-256を同じschemaのJSONへ保存する。

```sh
PRINTER_DEVICE=/dev/usb/lp0 PRINTER_EVIDENCE_DIR=./evidence/tm-t70ii \
  pnpm --filter @event-pos/printer-host hardware-test
```

`statusBefore=unknown`でも送信可否と印刷結果を分離して記録する。デバイスが未指定の場合はデバイスへ触れず終了コード2とする。送信途中のI/Oエラーは`unknown`として保存し、自動再送しない。

## Goal 6 実機試験手順

試験はWindows x64とLinux x86_64/ARM64の双方で行う。Linuxでは`/dev/usb/lp0`の番号を固定せず、まず実際のデバイス名と権限を記録する。Windowsではprinter名、driver/version、port、spooler/OPOS状態を記録する。

```sh
uname -a
uname -m
cat /etc/os-release
ls -l /dev/usb/lp* 2>/dev/null || true
systemctl status event-pos-printer-host --no-pager || true
```

### A. RAW送信と紙面

```sh
PRINTER_DEVICE=/dev/usb/lp0 \
PRINTER_EVIDENCE_DIR=./evidence/tm-t70ii/$(date +%Y%m%d-%H%M%S) \
pnpm --filter @event-pos/printer-host hardware-test
```

JSONの`result`、`statusBefore`、`statusAfter`、`bytesSha256`、`bytesLength`を保存し、紙面の文字・フィード・カットを目視して同じ試験番号へ記録する。送信成功だけでは紙面完了の証拠としない。status取得に失敗した場合の`statusAfter`は`unknown`として保存する。

### B. 切断・再接続

1. printer-hostを停止し、USBを抜いた状態でprobeを実行する。デバイス未存在またはI/Oエラーは`unknown`になり、自動再送されないことを確認する。
2. USBを再接続し、`ls -l`でデバイスノードを再確認する。
3. systemd運用では`systemctl restart event-pos-printer-host`後に`systemctl is-active`とjournalを保存する。
4. 同じ`jobId`を再送して二重印刷されないこと、紙面確認後の明示再印刷だけが新しい印刷になることを確認する。

### C. status能力表

紙切れ、カバー開放、USB切断を各1回実施し、取得できた値を`ready`、`paper_out`、`offline`、`unknown`のいずれかで記録する。取得できない機種・接続方式は`unknown`のままADR-P002へ記載し、正常扱いに補正しない。

証跡には、試験日時、機種、OS、CPUアーキテクチャ、device/spooler、Windows Serviceまたはsystemd unit、入力fixtureのhash、結果JSON、紙面写真、操作と判定者を紐付ける。Windows/Linuxのどちらか一方だけではGoal 6を完了扱いにしない。
