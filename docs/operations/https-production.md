# 本番HTTPSと会場LAN運用

## 原則

会場Wi-Fiは十分な長さの固有パスワードを設定し、POS運用端末以外へ共有しない。来場者、出展者、会場共用端末を同じLANへ入れない。HTTPSはこの原則に加えて、同一LAN内の盗聴・改変、接続先取り違えを防ぐため必須とする。

## サーバー設定

ローカルCAでサーバー証明書を発行し、固定hostnameと使用する固定IPをSANへ含める。秘密鍵はPOS実行ユーザーと管理者だけが読めるACLにする。

```powershell
$env:HOST = '0.0.0.0'
$env:PORT = '3443'
$env:POS_REQUIRE_HTTPS = 'true'
$env:POS_TLS_CERT_PATH = 'C:\ProgramData\event-pos\tls\server.crt'
$env:POS_TLS_KEY_PATH = 'C:\ProgramData\event-pos\tls\server.key'
node C:\event-pos\apps\server\dist\index.js
```

`POS_REQUIRE_HTTPS=true`で証明書または秘密鍵がなければ起動を拒否する。HTTPへの自動fallbackは行わない。

## Docker本番起動

証明書と秘密鍵をホストの`.secrets/tls/server.crt`、`.secrets/tls/server.key`へ配置してから起動する。

```powershell
docker compose up -d --build
Invoke-WebRequest -SkipCertificateCheck https://localhost:3443/health/ready
```

本番`pos`コンテナは3443番のHTTPSだけを公開する。証明書がない場合は起動を拒否し、HTTPへfallbackしない。`pos-training`は開発用HTTPとして3002番で起動する。

## 端末導入と当日確認

1. CA証明書のSHA-256 fingerprintを別経路で照合する。
2. iPad/PCへCAを導入し、明示的に信頼する。
3. 固定hostnameのHTTPS URLだけをホーム画面へ登録する。
4. 証明書警告が出ないこと、WebSocketが`wss`になることを確認する。
5. Wi-Fiパスワードを知る端末一覧を責任者が確認する。
6. 端末紛失時はWi-Fiパスワードを変更し、端末からCAを削除する。
