# プリンター比較基準

Discord botが稼働するDebian環境を初期基準として、Windows/Linux両PrinterTransportの比較資料を保存する。

## 保存するもの

- `discord-printer-bot` の移植元commit SHA
- TM-T70IIの接続情報と設定
- Windows/Linux別のOS、CPU、driver、USB device/spooler情報
- 同一fixtureから生成したESC/POS bytesとSHA-256
- 印字したレシートの写真またはscan
- 日本語、円記号、画像、バーコード、紙送り、部分カットの結果
- 紙切れ、カバー開、USB切断、再接続、service/OS再起動時のログ
- Windows/Linux別のstatus能力表と同一紙面判定

秘密情報、Discord token、個人情報は保存しない。

## Goal 6の実行入口

- [共通probe手順](../../tools/hardware-test/README.md)
- [OS別能力表](capability-matrix.md)
- [PR-01/03/06/07/10のOS別進捗](acceptance-status.md)
- [Goal 7.1 PrinterHost本番統合状況](goal7.1-status.md)
- [紙面証跡対応表](paper-evidence-map.md)
- `windows/`、`linux-x86_64/`、`linux-arm64/` のmanifestへ実測JSON、raw status、ログ、写真IDを追記する。

現時点のmanifestはすべて`template-not-measured`である。実機が未接続の環境で値を埋めたり、`unknown`を`ready`へ置換したりしない。
