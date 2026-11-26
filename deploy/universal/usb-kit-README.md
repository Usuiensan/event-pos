# USBキット（Windows / Mac 兼用）

このキットは Windows と Mac のどちらでも使えます。使うPCに Node.js や Docker を入れる必要はありません。

## 起動

- **Windows**: `Start-USB-Kit.bat` をダブルクリックします
- **Mac**: `Start-USB-Kit.command` をダブルクリックします（Apple Silicon / Intel 両対応）

コンソール（コマンドプロンプト／Terminal）1つで POS と PrinterHost が起動し、ブラウザーが開きます。

初回はイベント情報を入力します。商品一覧は空で、管理者の責任者番号は `001` です。終了時はコンソールで Ctrl+C を押し、DBの書き戻しが完了してからUSBを取り外してください。

## プリンター設定

- Windows: `printer-host.env`（Windowsスプーラー経由）
- Mac: `printer-host-macos.env`（Epson TM-T70II をUSB接続）

使うOS側のファイルを編集してください。

## アップデート（Windows側）

キット内の `Update-USB-Kit.bat` をダブルクリックすると、GitHub の配布リリースから新しいプログラムを取得して反映します。DBと初期設定（`event-config\usb-kit-initial`）は保護され、変化していたら更新前の状態へ自動で戻します。Mac側のファイル（`Start-USB-Kit.command`、`printer-host-macos.env`、Mac用ランタイム）も更新で消えません。

- 「アップデーターだけを先に更新しました」と出た場合は、そのままもう一度 `Update-USB-Kit.bat` を実行してください
- 更新前のプログラム一式はそのPCの `%LOCALAPPDATA%\EventPos\UsbKit\update-backup` に残ります

Mac側には自動アップデーターはありません。Macで更新する場合は、ビルド元で兼用キットを再ビルドして同じフォルダーへ上書きしてください（DB・初期設定・プリンター設定は引き継がれます）。

## 終了・シャットダウン時の動作

- Windows: コマンドプロンプトを「×」で閉じたり、シャットダウン／サインアウトしたりすると、終了通知を受け取った時点で会計の受付を止めてUSBへ最終保存を試みます
- Mac: 通常のシャットダウン・再起動では最長10秒の猶予を求めて最終保存を試みます。スリープ時は未同期のDBをUSBへ保存します（POSは稼働したまま）。Mac版の終了通知対応（EventPosPowerEvents.app）が同梱されていないビルドでは、この自動保存は働きません。Ctrl+Cでの終了と書き戻しは通常どおり動作します

## DBの復旧（強制終了・電源断で起動できなくなったとき）

会計はPC側のSQLite DBへ確定時に保存します。稼働中は5秒ごとに変更を調べ、変更があれば確定済みDBをUSBへ保存します。

強制終了や電源断の後は、**同じPC、同じユーザー、同じUSB**で起動してください。PCに残ったSQLite DBを検査し、確定済みのデータをUSBへ書き戻してからPOSを起動します。書き戻しが終わるまで別のPCではこのUSBを使えません。

- Windows のローカルDB: `%LOCALAPPDATA%\EventPos\UsbKit\data`（旧版で復旧情報からUSBを識別できない場合は `Recover-USB-Kit-DB.bat` を実行）
- Mac のローカルDBとログ: `~/Library/Application Support/EventPos/UsbKit`
