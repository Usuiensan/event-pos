# ADR-P009 防災通知のDiscord・POS共用印刷経路

- Status: Proposed
- Date: 2026-08-02
- Scope: `kishou_server`、`discord-printer-bot`、`event-pos` printer-host

## 調査した既存経路

### kishou_server

- `jma_server.js`がJMA/P2P/NERVの入力を受信し、重複排除・優先順位付けを行う。
- `lib/formatter.js`がEEW、地震、津波の表示用データを整形する。
- `lib/nervSource.js`がNERVをニュース等へ分類する。
- `lib/discordWebhook.js`と`lib/discordBot.js`がDiscord用Markdownを生成し、カテゴリ購読・送信を行う。
- Discord購読カテゴリには`intensity_N`、`include_intensity_N`、`eew`、`nerv_news`等がある。通知閾値と本文表示閾値は分離されている。

### discord-printer-bot

- `src/discordContent.js`がDiscordメッセージをReceiptLine/テキスト/画像等へ分解する。
- `src/escpos.js`の`EscPosBuilder`がCP932、日本語モード、画像、QR、バーコード、カットを含むESC/POS bytesを生成する。
- `src/printer.js`がWindows、bridge、Linux USBを切り替え、Linuxでは`/dev/usb/lp0`へRAW送信する。
- Linux statusはDLE EOT（`10 04 01`〜`04`）を送信して1バイト応答を読み、オフライン、カバー、紙切れ、紙詰まり等を判定する。status取得失敗は印刷成功と混同せず、現行実装ではエラー通知へ分類される。
- `PROXMOX.md`の本番構成はDebian CT、`PRINTER_BACKEND=linux-usb`、systemd常駐、USB passthroughである。

## 防災印刷対象

防災通知の印刷対象は次のいずれかとする。

1. 地震: 最大震度が5弱以上（内部値45以上）で、本文には震度3以上の地域だけを残す。
2. ニュース速報: NERV分類が`news`または購読カテゴリ`nerv_news`に該当するもの。
3. 緊急地震速報（EEW）: 発表・更新・取消を含む。EEWは震度条件を待たず優先する。
4. 津波情報: 津波警報、大津波警報、津波注意報、到達・観測・解除等を含む。

訓練・試験電文、重複済みイベント、購読対象外のNERVカテゴリは印刷しない。地震の最大震度条件と地域表示条件は別々に適用する。

## 決定案

Discord送信と印刷は別々に判定するが、通知元からプリンターホストへは共通の不変印刷payloadを渡す。既存Discord botのESC/POS生成結果を移植する場合も、POS会計レシートのキューと防災通知のキューを同じprinter-hostの排他・冪等性・状態管理へ通す。

印刷payloadは、次のいずれかを許可する。

- 構造化テキスト/ReceiptDocumentをprinter-hostがレンダリングする。
- 既存botが生成したESC/POS bytesをBase64で渡す（source、rendererVersion、bytesSha256を保存する）。

後者により、既存botの紙面互換性を保ったまま、POSが会計中でも防災通知を同じTM-T70IIへ印刷できる。生のESC/POS命令は防災通知の固定生成器または許可済みrendererからだけ受け入れ、一般利用者入力を命令として解釈しない。

## 保留・受入

- `kishou_server`からの通知をどの境界（HTTP webhook、共有キュー、またはprinter-host API）で渡すかは実装時に決定する。初期はprinter-hostの`POST /api/v1/print-jobs`へ専用`documentType`とsource metadataを付ける案を推奨する。
- 防災通知は会計取引ではないため、取引・在庫を作成しない。印刷ジョブ、通知ID、source、重複キー、状態だけを監査する。
- 実機では、会計レシートと防災通知の混線がないこと、通知の割込み順序、紙切れ・カバー開・status取得不能時の`unknown`を確認する。
