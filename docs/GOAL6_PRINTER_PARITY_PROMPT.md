# Goal 6投入プロンプト: Windows/Linuxプリンター技術検証

```text
C:\private\event-posでGoal 6「Windows/Linuxプリンター技術検証とADR決定」を実施してください。

開始基準はPR #5マージ後のmain。Goal 5で確立したReceiptSnapshot、canonical IR/ESC/POS hash、永続FIFO、attempt、delivery certainty、再印刷契約は維持する。

目標は、Windows x64と64bit Linuxの双方でTM-T70IIが同じ必須機能、紙面、障害処理、復旧手順を満たすための実測証拠を揃え、ADR-P001/P002をOS別に決定すること。片方だけを開発用、暫定版、機能縮小版として扱わない。正式adapterのPOSキュー・status API・UI統合はGoal 7とする。

## 現在の実装差分

- `LinuxRawTransport`、`WindowsRawTransport`、`hardware-test`、Linux udev/systemd、Surface運用文書は雛形段階。
- 現行`hardware-test`は`documentType: "hardware-test"`を`renderEscPos`へ渡し、I/O前に`approved renderer output is required`で失敗する。
- Linux transportの既定status probeは`unknown`で、PrinterHostは送信前に拒否する。未検証状態を`ready`へ読み替えない。
- Windows transportは外部`discord-printer-bot/tools/rawprint.ps1`を既定参照し、statusはWindows printer queueの粗い判定だけである。この実行時依存を解消し、RAW spooler/EPSON driver/API/OPOSの能力を実測する。
- `discord-printer-bot`は読取り専用の基準資料とし、実際にDebianで稼働しているcommitとservice設定を証拠へ記録する。

## 共通probe

既存の決定的ESC/POS packageから固定fixtureを生成する。`hardware-test`を本番document typeのallowlistへ追加せず、専用の純粋fixture builderまたは完全なReceiptDocument/版metadataを使う。

fixtureにはASCII、CP932日本語、U+00A5、32桁幅、左右row、固定画像、QR、Code 128、3行feed、partial cutを含める。必要ならpartial3を別fixtureにする。full cut、drawer、buzzer、NVメモリ・設定変更、任意raw payloadは含めない。

dry-runでESC/POS `.bin`、canonical IR、各SHA-256、bytes長、fixture/version manifestを生成する。実機runではOS/kernel/architecture、driver、device/spooler、各writeのoffset/bytesWritten/errno、status要求とraw response、normalized status、timeout、排他、compiler/adapter/write hash、紙面証拠IDもJSONへ保存する。一度でも送信された可能性がある失敗を自動再送しない。

## Windows x64

- RAW spooler、EPSON driver/API、必要に応じOPOSを比較する。
- printer名、driver/version、spooler job ID、bytes hash、acceptedBytesの意味を記録する。
- 印刷と状態取得のmutex、OPOS Claim timeout、別process占有、USB切断・再接続を測定する。
- 紙切れ、カバー開、offline、recoverable/fatal errorをraw値とともに測定する。
- portable起動とWindows Serviceの無人起動、専用account、再起動、ログ、Windows再起動・sleep復帰・update後復旧を検証する。
- POSコンテナからUSBを直接扱わず、Windows native printer-hostとのHTTP境界を維持する。

## Linux x86_64

- 既存Debianを基準とし、`/dev/usb/lp*`と必要な双方向方式を比較する。libusbはRAW経路で必要能力が得られない場合に測定する。
- DLE EOT等の要求bytesとraw responseを保存し、公式TM-T70II資料と照合する。
- udev安定名、service user/group、read/write権限、status/print mutex、USB切断後のdevice node再生成を測定する。
- systemdの無人起動、異常終了、OS再起動、USB再接続後復旧を検証する。
- 既存Debianでprobeを実行するときはDiscord bot serviceを停止し、deviceを保持するprocessがないことを確認し、終了後に元serviceとjournalを確認する。

## 共通実機受入

両OSで同じ`.bin`を使い、正常印刷、日本語・円記号・32桁配置、画像、QR/バーコード実読取り、feed、部分cut、同時open、紙切れ、カバー開、USB切断前/送信中/再接続、printer-host停止・再起動、OS再起動、同一jobId再送、4レジFIFOを確認する。

Windows x64、Linux x86_64でIR/bytes hashが一致し、取引番号、全文、配置、文字化け、feed、cutが同じ紙面になることを写真またはscanで判定する。OSが全bytesを受理したことと物理紙面完了を分けて記録する。Linux ARM64は2026-08-03に実機未保有のため、Goal 6の正式サポート対象から除外した。

実機、OS、architecture、障害シナリオへ到達できない場合は成功を推測せず、未取得証拠を明示する。片方の証拠しかない状態でGoal 6やPrinterHost対応全体を完了扱いにしない。

## ADRと証跡

ADR-P001にはWindows/Linux別の採用方式、driver/library、timeout、mutex、partial write、切断・再接続、配布、serviceを記録する。ADR-P002にはreachable、online、cover、paper、recoverable/fatal errorを接続方式ごとに`supported/unsupported/unknown`で記録する。応答なしを正常へ変換しない。

P003はdrawer型番、pin、pulse、安全制限が提供された場合だけ実機試験し、不明ならPendingを維持する。P006は両OSのBOM・運用証拠が揃うまで、P009は防災経路の別判断が終わるまでAcceptedにしない。

`docs/printer-baseline/`へWindows/Linux別のmanifest、raw status、ログ、紙面対応表を保存し、PR-01/03/06/07/10のA/H/RについてOS別の実施済み部分と未完了部分を分離して更新する。

完了条件は、共通probeの自動試験と`pnpm check`が成功し、Windows x64とLinuxの実機証拠、OS別能力表、再現可能な導入・障害復旧手順、同一bytes/紙面判定が揃うこと。実機証拠が不足する場合はGoal 6を未完了として引き渡す。
```
