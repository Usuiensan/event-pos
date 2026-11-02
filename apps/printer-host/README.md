# Printer Host

POS本体から印刷ジョブを受信し、プリンター接続へ渡す独立プロセスです。

```powershell
pnpm --filter @event-pos/printer-host dev
```

初期実装はFakeTransportを使用します。Linux実機では`LinuxRawTransport`へ差し替えますが、状態取得は実機検証前は`unknown`を返します。POS側のHTTP APIへ状態を通知する場合は`HttpStateSink`を利用します。

印刷ジョブは`jobId`で冪等化され、送信途中で完了判定できない場合は自動再送せず`unknown`として扱います。

## macOS USBプリンター

TM-T70IIを接続したMac上で、リポジトリ直下の`.env`に`PRINTER_HOST_TOKEN`を設定し、次を実行します。

```sh
openssl rand -hex 32
```

出力を`.env`の`PRINTER_HOST_TOKEN`へ設定してから起動します。

```sh
pnpm --filter @event-pos/printer-host start:macos-usb
```

PrinterHostはUSB VID/PIDとシリアル番号で対象機を限定します。POSコンテナとの接続に必要な場合は`0.0.0.0:4318`で待ち受け、Bearer tokenで保護します。USB status応答で取得できない機能は`unknown`のまま扱います。
