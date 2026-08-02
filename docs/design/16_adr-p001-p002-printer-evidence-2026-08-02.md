# ADR-P001/P002 プリンター方式・状態取得の実測決定

- 状態: `Research`（実機証跡待ち）
- 決定日: 未定
- 対象: Windows x64、Linux x86_64 の TM-T70II

Linux ARM64は実機未保有のため、2026-08-03にGoal 6の正式サポート・受入対象から除外した。将来ARM64を採用する場合、P001/P002を再度`Research`として同じfixture・障害・紙面受入を実測する。

## ADR-P001 通信方式

Windows候補は同梱のWinspool RAW `WritePrinter`、EPSON driver/API、OPOS。Linux候補は`/dev/usb/lp*`、必要時のみlibusbである。外部`discord-printer-bot`のscriptは実行時依存にしない。Winspool RAW adapterはリポジトリ同梱で、spooler job IDと`acceptedBytes`を記録できる。

採用は未決定。各候補で同じ`fixture.bin`を送り、partial write、別process占有、切断/再接続、service無人起動、OS再起動後復旧、紙面を比較する。`acceptedBytes`がbytes長と一致しても物理完了とは扱わない。送信可能性のある失敗は自動再送しない。

2026-08-02にWindows x64で同梱Winspool RAWを1回実測した。spooler job ID 3は313 bytesを受理し、fixture SHA-256は`cb0fd1c71fe171d075167d967b099d4a6c26eb71aabcbf2b1ae9ccf88f3dac0d`である。これは紙面を観測していないため、方式採用・紙面合格・障害復旧の根拠にはならない。raw JSONは`docs/printer-baseline/windows/20260802-2303/`に保存する。

2026-08-03にDebian 13 x86_64 LXCの`/dev/usb/lp0`へ同じ313 bytesを一回送信した。既存`discord-printer-bot` serviceを停止し、device holder不在を確認してから実行し、終了後にserviceが`active/running`へ復帰した。DLE EOT `10 04 01`〜`04`のraw responseは送信前後とも`16/12/12/12`で、Epson公式のbit定義に照らして正常時のonline/paper-present状態と一致する。ただしcover/paper-out/error/切断時の値は未測定のため`unknown`である。[DLE EOT公式仕様](https://download4.epson.biz/sec_pubs/pos/reference_en/escpos/dle_eot.html) と [TM-T70II対応command一覧](https://download4.epson.biz/sec_pubs/pos/reference_en/escpos/tmt70ii.html)を参照。

同じDebian LXCでcover open、紙切れ、USB切断・再接続を実測した。cover openと紙切れではDLE EOTがtimeout/EAGAINとなり、個別状態へ推測せず`unknown`とした。USB切断後は`/dev/usb/lp0` nodeが残ってもopenが`ENODEV`になり、再接続後はDLE EOT `16/12/12/12`と`ready`へ復帰した。各status-only probeはfixture bytesを送らず、bot停止・device holder不在・service復帰を記録している。

LXC OS再起動後も`/dev/usb/lp0`、DLE EOT正常値、bot service `active/running`、同一fixture v2の316 bytes送信が復帰した。短いロール紙でnear-endも測定し、DLE EOT n=4のraw responseが通常`12`から`1e`へ変化した時点で印刷loopを停止した。これはnear-endの実測であり、紙切れ状態の個別検出を意味しない。

## ADR-P002 状態取得

現時点の全方式は`unknown`である。Windows print queueの`Normal`、Linuxのwrite成功、DLE EOT応答なしを`ready`へ変換しない。各方式のreachable/online/cover/paper/recoverable/fatal errorは [能力表](../printer-baseline/capability-matrix.md) に `supported` / `unsupported` / `unknown` とraw値の両方を記録する。

Windows x64ではprinterをDebianへ接続した状態でstatus-only probeを実行した。EPSON TM-T70II Receipt5 queueのraw `PrinterStatus` は`4096`だったが、queueの値だけではdevice-level errorを区別できないためnormalized statusは`unknown`とした。EPSON OPOS for .NETとTM-T70II service componentは導入済みだが、OPOS logical deviceの登録は検出されず、Open/Claimを推測実行していない。raw JSONは`docs/printer-baseline/windows/20260803-printer-connected-to-linux/`に保存する。

同じWindows x64へUSBを再接続した直後、EPSON USB ControllerのPnP statusは`OK`、queue raw `PrinterStatus` は`0`だった。これも紙/cover/errorを区別するdevice-level statusではないため`unknown`のままとし、`docs/printer-baseline/windows/20260803-reconnected/`へ保存した。

カバー開状態でも同じWindows x64のUSB PnP statusは`OK`、queue raw `PrinterStatus` は`0`で通常時と差がなかった。Winspool queue/PnP observation単独ではcoverを検出できないため、cover capabilityは`unknown`を維持する。raw JSONは`docs/printer-baseline/windows/20260803-cover-open/`に保存した。

カバーを閉じた後も同じraw `PrinterStatus=0`/USB PnP `OK`を観測した。これはcover openとの区別を提供しないため`ready`への変換根拠にはしない。raw JSONは`docs/printer-baseline/windows/20260803-cover-closed/`に保存した。

紙切れでも同じWindows queue raw `PrinterStatus=0`/USB PnP `OK`を観測した。Winspool queue/PnP observation単独ではpaper outを検出できないため、paper capabilityは`unknown`を維持する。raw JSONは`docs/printer-baseline/windows/20260803-paper-out/`に保存した。

紙を戻してカバーを閉じた後も同じraw `PrinterStatus=0`/USB PnP `OK`を観測した。紙切れとの差を識別できないため`ready`への変換根拠にはしない。raw JSONは`docs/printer-baseline/windows/20260803-recovered/`に保存した。

意図的USB切断ではEPSON USB Controllerのphysical PnP entryが消失し、queue raw `PrinterStatus` は`4096`になった。再接続時のPnp `OK`/queue raw `0`との比較で、Windows native hostはUSBのreachable/unreachableを観測できる。一方、queue値単独はdevice-readyでも紙/cover/errorでもないためnormalized statusは`unknown`を維持する。raw JSONは`docs/printer-baseline/windows/20260803-usb-disconnected/`に保存した。

USB再接続後にEPSON USB ControllerのPnP `OK`/queue raw `PrinterStatus=0`へ復帰したことを再確認した。これは到達可能性の復帰観測であり、device-readyの証明ではない。raw JSONは`docs/printer-baseline/windows/20260803-usb-reconnected/`に保存した。

## 未取得の必須証拠

- Windows x64実機: driver/API/OPOS比較、紙切れ・cover・offline・USB再接続、Service account/sleep/update後の復旧。
- Debian x86_64実機: bot service停止とdevice保持process不在の記録、DLE EOT raw応答、udev/systemd復旧。
- 両OS: 4レジFIFO、同一jobId、host/OS再起動、全紙面写真またはscan。

P003はdrawer型番・pin・pulseが未提供のため`Pending decision`を維持する。P006は両OSのBOMと運用証跡、P009は防災経路の別ADRが揃うまで`Accepted`にしない。
