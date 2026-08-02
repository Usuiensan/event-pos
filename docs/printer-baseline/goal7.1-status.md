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

Windows x64は2026-08-03 06:17 JST時点ではUSB未接続で、Hostが`reachable=false`とした証跡を`windows/20260803-goal7.1-offline/windows-status-result.json`へ保存した。その後TM-T70IIを再接続し、06:41 JSTにbuild済みPrinterHostをWindows launcherから実backendで起動、`reachable=true`を確認した。online/cover/paper/errorはWinspool RAWで取得不能のため`unknown`のままとした。

`windows/20260803-064002-goal7.1-pos/`ではPOS経由の開局と現金会計初回を実機送信し、jobId、payload hash、acceptedBytes、spooler job ID、Hostログ、操作者紙面判定を保存した。ただし再印刷riskの明示承認が得られず安全停止し、中間計・精算は未送信である。紙面から営業日がUTC由来で前日になった不具合と、3行feedでは最終文字行へcut位置が掛かる不具合を検出した。営業日はローカル日付、production末尾は5行追加した8行feedへ修正した。このpartial runは不合格証跡であり、Windows Acceptedへ数えない。

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

## 2026-08-03 継続監査

自動検証を再実行し、`pnpm check`（全workspaceのbuild・typecheck・test・PrinterHostのbuilt/deploy smoke）と、POS→PrinterHost統合テストは合格した。これにより、ビルド済み起動経路、FIFO先頭処理、同一jobIdの冪等性、結果不明の自動再送禁止は自動証拠として維持される。

Windowsの未追跡run artifact `windows/20260803-070121-goal7.1-pos-feed8/pos-printerhost-evidence.json` には5種のjobId、payload hash、acceptedBytes、spoolerJobId、操作者判定が記録されている。再印刷については操作者が指定したDownloads写真（SHA-256 `bec8796913702444dca61a1c964b1cb07d841e5f41496c3b1e626b1f58f07bab`）を目視し、受付番号`1000-0012`、日本語全文、金額、余白、部分cutを確認できるが、runディレクトリ内の写真hashとして固定されていない。中間計・精算の`paperPhotoId`は`ok`というプレースホルダーで、紙面写真の実体・hashがない。runの`result.md`も「再印刷承認待ち」と記載されたままである。このため、送信証拠は保存済みでも、5種の紙面受入をWindows Acceptedへ昇格させない。

Linux x86_64の正式Host/systemd/POS経由run、Windows/LinuxのHost常駐無人起動、USB切断・再接続および送信後結果不明の実機証跡は未取得である。紙切れ・カバー開・ドロアー物理開放は引き続き`unknown`/未実施とする。P001/P002/P003/P006の判定は変更しない。
