# Windows/Linuxプリンター実機試験ツール

TM-T70IIへ固定fixtureを送信し、送信方式、状態取得、障害復旧を比較するCLIをここへ実装する。

初期比較対象:

- Windows RAW spooler、EPSON driver/API、OPOS
- Windows native printer-hostのportable/Service運用
- `/dev/usb/lp*`への直接送信
- 双方向statusが必要な場合のlibusb等
- Debian既存環境の出力bytes・紙面・systemd・USB設定
- Windows x64、Linux x86_64（Goal 6の正式サポート対象）

実機を接続するまで、送信方式や取得可能なstatusを確定扱いにしない。印刷成功とstatus取得失敗を別々に記録する。

## 共通fixtureとdry-run

fixtureは本番document typeにも任意raw payloadにも依存しない純粋なcanonical IR builderである。ASCII、CP932日本語、U+00A5、32桁row、固定画像、QR、Code 128、3行feed、partial cutだけを含む。バーコードHRIの切断防止のため、v2は3行feedを2回（合計6行）送る。full cut、drawer、buzzer、NV書込み、設定変更は含めない。

```sh
PRINTER_EVIDENCE_DIR=./evidence/tm-t70ii/dry-run \
  pnpm --filter @event-pos/printer-host hardware-test
```

これは`fixture.ir`、`fixture.bin`、`fixture-manifest.json`を生成するだけで、デバイスへ触れない。双方でこの`.bin`のSHA-256が一致することを確認してから実機送信を行う。

## Goal 6 実機試験手順

試験はWindows x64とLinux x86_64の双方で行う。Linux ARM64は2026-08-03に実機未保有のため、このGoal 6の正式サポート・受入対象から除外した。Linuxでは`/dev/usb/lp0`の番号を固定せず、まず実際のデバイス名と権限を記録する。Windowsではprinter名、driver/version、port、spooler/OPOS状態を記録する。

```sh
uname -a
uname -m
cat /etc/os-release
ls -l /dev/usb/lp* 2>/dev/null || true
systemctl status event-pos-printer-host --no-pager || true
```

### A. RAW送信と紙面

```sh
PRINTER_DEVICE=/dev/event-pos-tmt70ii \
PRINTER_EVIDENCE_DIR=./evidence/tm-t70ii/linux-x86_64-$(date +%Y%m%d-%H%M%S) \
sh tools/hardware-test/run-linux.sh --take-device
```

JSONの`result`、`statusBefore`、`statusAfter`、`bytesSha256`、`bytesLength`を保存し、紙面の文字・フィード・カットを目視して同じ試験番号へ記録する。送信成功だけでは紙面完了の証拠としない。status取得に失敗した場合の`statusAfter`は`unknown`として保存する。

既存Debianではこのscriptが既定で`discord-printer-bot` serviceを停止し、`fuser`でdevice保持processがないことを確認する。`--take-device`なしには送信しない。終了時はtrapで元serviceを開始し、status/journal、稼働commit、service定義を同じ証跡dirへ保存する。DLE EOT `10 04 01`〜`10 04 04`の要求bytesと1-byte raw responseもrun JSONへ保存するが、未検証の応答は常に`unknown`である。

`event-pos`をまだDebianへ配布していない段階では、同じ`fixture.bin`と同梱の`linux-remote-probe.mjs`を一時dirへcopyして実行できる。これは既存botのrawprint（再送設定を持つ）を使わず、partial writeとDLE EOT応答を記録して自動再送しない。

### Windows x64 RAW spooler

PowerShellでdry-run後、明示的に`-Run`を付ける。リポジトリ同梱のWinspool `WritePrinter` scriptを使うため、`discord-printer-bot`への実行時依存はない。

```powershell
.\tools\hardware-test\run-windows.ps1 -PrinterName 'EPSON TM-T70II Receipt' -EvidenceDir .\evidence\tm-t70ii\windows-x64 -Run
```

`windows-spooler-result.json`へdriver、port、spooler job ID、acceptedBytes、queue由来raw値、write offsetを記録する。queueの`Normal`はdevice statusの`ready`を意味しないため、紙切れ/cover/offlineはEPSON APIまたはOPOS比較を含む実測まで`unknown`のままとする。

印刷しない障害状態は、次の status-only probe で採取する。Windows queue/PnPのraw値、EPSON OPOS for .NETとTM-T70II componentの導入有無、OPOS logical deviceの登録有無を保存する。OPOSを導入済みでもlogical deviceが未設定なら、推測してOpen/Claimはしない。

```powershell
.\tools\hardware-test\capture-windows-status.ps1 `
  -PrinterName 'EPSON TM-T70II Receipt' `
  -EvidenceDir .\evidence\tm-t70ii\windows-x64-cover-open `
  -Scenario cover-open
```

`windows-status-result.json`のqueue状態は常に`unknown`として扱う。EPSON APIまたはOPOSによるdevice-level statusを別途実測した場合だけ、raw値と対応表をADR-P002へ追加する。

### Windows x64 OPOS status-only

SetupPOSに登録済みのlogical deviceを、印刷なしで `Open → Claim(timeout) → status properties → Release → Close` する。`-EnableDevice`を付けた場合はproperty readのため一時的に`DeviceEnabled=true`へ設定し、必ず`false`へ戻してからRelease/Closeする。`-Run`なしではdeviceを操作しない。Claimの成否・実測時間・cover/paper/error/powerのOPOS値を保存し、例外時にも自動再送はしない。

EPSON OPOS for .NET 1.14はPowerShell 7と互換ではないため、64-bit Windows PowerShell 5.1（`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`）で実行する。`TM-T70II`はPosExplorerのservice object名であり、SetupPOS UI上の表示名とは区別する。

```powershell
.\tools\hardware-test\capture-windows-opos-status.ps1 `
  -LogicalName 'TM-T70II' `
  -EvidenceDir .\evidence\tm-t70ii\windows-opos-normal `
  -ClaimTimeoutMs 3000 `
  -EnableDevice `
  -Run
```

### B. 切断・再接続

1. printer-hostを停止し、USBを抜いた状態でprobeを実行する。デバイス未存在またはI/Oエラーは`unknown`になり、自動再送されないことを確認する。
2. USBを再接続し、`ls -l`でデバイスノードを再確認する。
3. systemd運用では`systemctl restart event-pos-printer-host`後に`systemctl is-active`とjournalを保存する。
4. 同じ`jobId`を再送して二重印刷されないこと、紙面確認後の明示再印刷だけが新しい印刷になることを確認する。

### C. status能力表

紙切れ、カバー開放、USB切断を各1回実施し、取得できた値を`ready`、`paper_out`、`offline`、`unknown`のいずれかで記録する。取得できない機種・接続方式は`unknown`のままADR-P002へ記載し、正常扱いに補正しない。

証跡には、試験日時、機種、OS、CPUアーキテクチャ、device/spooler、Windows Serviceまたはsystemd unit、入力fixtureのhash、結果JSON、紙面写真、操作と判定者を紐付ける。Windows/Linuxのどちらか一方だけではGoal 6を完了扱いにしない。

## Goal 7.1 POS統合受入

build済みPOS serverとPrinterHostを起動したTTY terminalで、開局、現金会計初回、再印刷、中間計、精算を順に送信する。各紙面を確認するまで次のjobは作成しない。初回紙面が`printed`または`indeterminate`の場合、再印刷前に完全一致の`REPRINT`入力を必須とする。

```powershell
node .\tools\hardware-test\run-goal7-pos-acceptance.mjs --run `
  --operator goal7-operator --manager goal7-manager `
  --pos-url http://127.0.0.1:3000 `
  --output .\docs\printer-baseline\windows\YYYYMMDD-HHMMSS-goal7.1-pos
```

開局と初回の紙面確認後、`REPRINT`を入力せず安全停止したrunだけは、同じoutput directoryとDBを使って`--resume`できる。既に合格した2枚は再送せず、再印刷承認から再開する。別の失敗状態やjob構成ではresumeを拒否する。

```powershell
node .\tools\hardware-test\run-goal7-pos-acceptance.mjs --run --resume `
  --operator goal7-operator --manager goal7-manager `
  --pos-url http://127.0.0.1:3000 `
  --output .\docs\printer-baseline\windows\YYYYMMDD-HHMMSS-goal7.1-pos
```
