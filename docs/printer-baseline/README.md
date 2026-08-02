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
