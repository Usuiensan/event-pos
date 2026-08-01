# Windows Surface一時運用構成

## 推奨構成

親族のSurfaceを即売会で一時利用する場合は、POSサーバーとWindowsプリンターホストを分離する。

```text
Surface
├─ Docker Desktop (Linux container)
│  └─ POS server + SQLite + register web
├─ Windows native printer-host
│  └─ Windows spooler / EPSON TM-T70II
└─ Browser
   └─ http://127.0.0.1:3000 のレジ画面
```

POSコンテナからUSBプリンターを直接扱わない。Windowsのプリンタードライバー、USBポート、RAW spoolerはホストOSに残し、printer-hostのHTTP境界だけをコンテナへ公開する。

## 採用理由

- Docker内LinuxからWindows USB spoolerへ直接アクセスする不安定な経路を避ける。
- SurfaceからN100/Debian/Raspberry Piへ移行するとき、POSコンテナとprinter-hostの責務を維持できる。
- POS DBはDocker volumeへ保存し、Surface終了時にexport bundleを取得できる。
- プリンター切断がPOSコンテナを停止させない。

## 一時運用の起動順

1. Surfaceを有線または専用LANへ接続し、スリープを無効化する。
2. Docker Desktopを起動し、POSコンテナをloopbackまたは専用LANアドレスへbindする。
3. Windows printer-hostを起動し、`POS_BASE_URL`をPOSコンテナのURLへ設定する。
4. `EPSON TM-T70II Receipt`のWindows状態を確認し、テストレシートを1枚印刷する。
5. レジブラウザーを開く。
6. 終了時は会計受付を止め、印刷ジョブ確認、DB/export bundle取得、POS停止、printer-host停止の順に行う。

## セキュリティと復旧

- DockerのPOS APIは原則loopbackまたは会場専用LANだけへ公開する。認証・Origin検査を省略しない。
- printer-hostはPOS APIの許可元を固定し、任意の外部URLへ状態通知しない。
- Surface上のDocker Desktopが使えない場合は、Node.js 24のPOSサーバーをWindowsネイティブ起動するフォールバックを用意する。DBとHTTP契約は共通にする。
- Docker volumeを唯一のバックアップとみなさず、営業終了時にSQLite backup/export bundleを別媒体へ保存する。

## 実装課題

- `apps/printer-host`へWindows spooler transportを追加し、既存`discord-printer-bot/tools/rawprint.ps1`相当のRAW送信を共通`PrinterTransport`へ実装する。
- Docker Compose、`.env.example`、Surface向け起動runbookを追加する。
- Windows printer-hostとPOSコンテナ間のHTTP接続、再起動、ジョブ状態、会計レシートと防災通知の混線なしを試験する。

## リポジトリ内の起動ファイル

- `Dockerfile`: POS server runtimeのみをLinuxコンテナへ収める。
- `docker-compose.yml`: `127.0.0.1:3000`と`pos-data` volumeを定義する。
- `.env.example`: Surface用の初期環境変数を定義する。

Surfaceでは`.env.example`を`.env`へコピーし、`docker compose up -d --build`で起動する。Windows printer-hostは別途`PRINTER_BACKEND=windows-spooler`で起動し、Docker Desktopの`host.docker.internal`を介して接続する。DockerコンテナへUSBデバイスを渡す設定は行わない。
