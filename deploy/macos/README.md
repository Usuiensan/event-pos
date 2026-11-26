# macOS USBキットの作成

macOSの開発環境で実行します。開発環境にはNode.js 24、pnpm、Xcode Command Line Toolsが必要です。キットには公式Node.jsランタイムとPrinterHostのUSB依存を同梱します。

```sh
pnpm install --frozen-lockfile
./deploy/macos/build-usb-kit.sh "/Volumes/POS-USB/event-pos-usb-kit" arm64
```

Apple Silicon用は `arm64`、Intel Mac用は `x64` を指定します。省略時はビルドに使うNode.jsと同じアーキテクチャです。

Windows / Mac 兼用キットは、第2引数に `universal` を指定します（Windows側の開発PCでも `build-usb-kit.ps1 -Universal` で同じ兼用キットを作成できます）。

```sh
./deploy/macos/build-usb-kit.sh "/Volumes/POS-USB/event-pos-usb-kit" universal
```

Mac上で兼用キットを作ると、終了・スリープ通知用の `EventPosPowerEvents.app` は arm64 + x86_64 のユニバーサルバイナリになります。Windows等で作る場合は `deploy/macos/prebuilt/EventPosPowerEvents.app`（Macで一度ビルドして配置したユニバーサル版）があれば同梱され、無ければ通知対応なし（Ctrl+Cでの終了・書き戻しは動作）でビルドされます。

更新する場合は、POSを正常終了した後、同じ出力フォルダーを指定してコマンドを再実行します。DB、初期設定ディレクトリ、プリンター設定は引き継がれます。起動・終了・復旧の手順は、生成されるキット内の `README.md` を参照してください。
