# Windows USBキット

`Start-USB-Kit.bat`をダブルクリックすると、POS serverとPrinterHostを起動してブラウザーを開きます。Docker DesktopやNode.jsの事前インストールは不要です。

## アップデート（新しいプログラムへの更新）

キット内の`Update-USB-Kit.bat`をダブルクリックすると更新できます。どのPCでも動きます（Windowsとネット接続だけ必要です）。

- ふだんは GitHub の配布リリースから新しいプログラムを取得して反映します。既に最新なら「既に最新です」と表示して終わります
- DBと初期設定（`event-config\usb-kit-initial`）は保護され、変化していたら更新前の状態へ自動で戻します
- 更新中はキットを起動しないでください（稼働中は安全のため停止します）
- 更新前のプログラム一式はそのPCの`%LOCALAPPDATA%\EventPos\UsbKit\update-backup`に残ります
- アップデーター自体の新版は、次回`Update-USB-Kit.bat`を起動したときに自動で差し替わります（旧版は`update-usb-kit.ps1.prev`に残ります）

ビルド元PCでは、リポジトリから直接ビルドして反映することもできます。その場合は環境変数`EVENT_POS_UPDATE_MODE`に`local`を設定してから実行してください（ビルド元は`EVENT_POS_REPO`で変更できます）。

配布リリースの作成は、ビルド元PCで`deploy\windows\publish-kit-release.ps1`を実行します（GitHubトークンが要ります）。
