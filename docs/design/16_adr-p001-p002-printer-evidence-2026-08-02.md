# ADR-P001/P002 プリンター方式・状態取得の実測決定

- 状態: `Research`（実機証跡待ち）
- 決定日: 未定
- 対象: Windows x64、Linux x86_64、Linux ARM64 の TM-T70II

## ADR-P001 通信方式

Windows候補は同梱のWinspool RAW `WritePrinter`、EPSON driver/API、OPOS。Linux候補は`/dev/usb/lp*`、必要時のみlibusbである。外部`discord-printer-bot`のscriptは実行時依存にしない。Winspool RAW adapterはリポジトリ同梱で、spooler job IDと`acceptedBytes`を記録できる。

採用は未決定。各候補で同じ`fixture.bin`を送り、partial write、別process占有、切断/再接続、service無人起動、OS再起動後復旧、紙面を比較する。`acceptedBytes`がbytes長と一致しても物理完了とは扱わない。送信可能性のある失敗は自動再送しない。

2026-08-02にWindows x64で同梱Winspool RAWを1回実測した。spooler job ID 3は313 bytesを受理し、fixture SHA-256は`cb0fd1c71fe171d075167d967b099d4a6c26eb71aabcbf2b1ae9ccf88f3dac0d`である。これは紙面を観測していないため、方式採用・紙面合格・障害復旧の根拠にはならない。raw JSONは`docs/printer-baseline/windows/20260802-2303/`に保存する。

## ADR-P002 状態取得

現時点の全方式は`unknown`である。Windows print queueの`Normal`、Linuxのwrite成功、DLE EOT応答なしを`ready`へ変換しない。各方式のreachable/online/cover/paper/recoverable/fatal errorは [能力表](../printer-baseline/capability-matrix.md) に `supported` / `unsupported` / `unknown` とraw値の両方を記録する。

## 未取得の必須証拠

- Windows x64実機: driver/API/OPOS比較、紙切れ・cover・offline・USB再接続、Service account/sleep/update後の復旧。
- Debian x86_64実機: bot service停止とdevice保持process不在の記録、DLE EOT raw応答、udev/systemd復旧。
- ARM64実機: 同じLinux一式と紙面比較。
- 両OS: 4レジFIFO、同一jobId、host/OS再起動、全紙面写真またはscan。

P003はdrawer型番・pin・pulseが未提供のため`Pending decision`を維持する。P006は両OSのBOMと運用証跡、P009は防災経路の別ADRが揃うまで`Accepted`にしない。
