# Goal 7.1 PrinterHost本番統合の実装・受入状況

- 評価日: 2026-08-03
- branch: `codex/goal-7-1-printerhost-production`
- 原則: transport受理と紙面結果を分離し、未接続・未実施・取得不能は成功へ読み替えない。

## 実装済み・自動確認済み

| 項目 | 結果 | 根拠 |
| --- | --- | --- |
| build済み単独起動 | 合格（A） | workspace packageの開発条件は`src`、本番Nodeのdefault exportは`dist`へ分離。非bundleで全packageを同一releaseとして配置する。`node apps/printer-host/dist/index.js`を起動する`smoke:built`がhealthを確認 |
| POS→HTTP→Host→Transport | 合格（A） | 初回レシート、再印刷、開局、中間計、精算の5jobを実HTTP経路へ投入し、永続`printer_operations.sequence`順、同時write最大1、全attemptのcompiler/adapter/write hash一致、`acceptedBytes=payloadLength`を確認 |
| FIFO先頭block | 合格（A） | 0 byte再試行、device fault、future retry、後続追越し禁止、4件同時投入を既存queue試験で確認 |
| 結果不明 | 合格（A） | short write、timeout、Host応答消失、`dispatch_started`後再起動を`failed/unknown`にし、自動再送しない試験を確認 |
| Windows portable/Service | 定義・構文確認済み（A）、無人実行未確認（H/R不足） | `deploy/windows/start-printer-host.ps1`、WinSW XML、env例、停止・再起動・ログrunbook |
| Linux systemd | 定義済み（A）、対象機未適用（H/R不足） | unit、udev安定名、env例、journal・停止・復旧runbook。現在のWindows端末からLinux hostnameを解決できず未配置 |
| drawer安全ゲート | 合格（A） | `DRAWER_ENABLED`既定false。現金会計と手動APIの双方でdrawer jobを作らない。P003受入前は実機駆動しない |

## 現在の実機preflight

Windows x64ではbuild済みPrinterHostを`windows-spooler`で起動できたが、TM-T70IIは現在この端末へUSB接続されていない。2026-08-03 06:17 JSTのqueue rawは`PrinterStatus=4096`、physical EPSON USB controllerは不在で、Hostは`reachable=false`、online/cover/paper/errorを`unknown`とした。証跡は`windows/20260803-goal7.1-offline/windows-status-result.json`に保存した。印刷jobは送っていない。

Linux x86_64の既存証跡機は、この作業端末のSSH/DNS設定から`services`を解決できず、release配置、systemd起動、POS統合印刷を実行していない。

## 必須実機run

POS serverとPrinterHostを起動し、statusと`DRAWER_ENABLED=false`を確認後、次のrunnerを使える。Windowsの実機受入用POS serverはPowerShell 7から次のように起動し、DBをrun directoryへ分離する。このlauncherはドロアーを常に無効化する。

```powershell
pwsh -NoProfile -File tools/hardware-test/start-goal7-pos-server.ps1 -DatabasePath docs/printer-baseline/windows/<run-id>/event-pos.sqlite
```

別のPowerShell 7 terminalでrunnerを実行する。これは実機へ5枚送るため`--run`を必須とする。

```powershell
node tools/hardware-test/run-goal7-pos-acceptance.mjs --run --operator <操作者ID> --manager <責任者ID> --pos-url http://127.0.0.1:3000 --output docs/printer-baseline/windows/<run-id>
```

Linuxでは同じcommandのoutput先を`linux-x86_64/<run-id>`にする。runnerは各jobの終端後に紙面結果を対話入力し、入力ごとに`operator-paper-review.json`とtransport証跡を逐次保存する。初回レシートを`printed`または`indeterminate`と判定した場合は、重複riskを理解した責任者が`REPRINT`と入力するまで再印刷jobを作らない。`not_printed`もtransport結果から推測せず、紙面を見た操作者が判定する。

各OSで別run directoryを作り、次の5枚を同じ順で実POS APIから送る。

1. 開局レシート
2. 現金会計の初回レシート
3. 同取引の明示再印刷
4. 中間計レシート
5. 精算レシート

各jobについて`jobId`、IR hash、payload hash、payload length、`acceptedBytes`、transport evidence（Windowsはspooler job ID）、status observation、Hostログ、POS attempt、紙面写真ID、全文・配置・文字化け・部分cutの操作者判定を保存する。送信順は実際の業務順に変更してよいが、DB sequenceとHostログ順が一致することを確認する。

続いて、PrinterHost再起動、POS再起動、USB切断→再接続、送信応答消失を実施する。`dispatch_started`後の結果不明jobは自動再送せず、紙面確認後の新しい再印刷jobだけを許可する。紙切れ、カバー開、ドロアー物理開放は今回未実施のまま残す。

## ADR判断

| ADR | 現在の判定 | 理由 |
| --- | --- | --- |
| P001 | 方式実装は決定可能、Acceptedは証拠不足 | Windows Winspool RAWとLinux `/dev/usb/lp*`の候補・契約・既存単体紙面はあるが、正式Host/service/POS経由の両OS実機runがない |
| P002 | capabilityのunknown境界は決定可能、Acceptedは証拠不足 | Windows RAWはreachableだけ、Linux DLE EOTは正常時onlineまで。Windows OPOS fault値、正式Hostでの両OS障害runが不足 |
| P003 | 証拠不足 | BC-415M-B(6C)到着・接続図確認・Windows/Linux各1回の物理開放が未完了。既定無効を維持 |
| P006 | 証拠不足 | 両OS本番候補のBOM、storage/router/UPS/予備機、復旧時間訓練が未取得 |
