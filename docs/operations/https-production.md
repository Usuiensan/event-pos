# HTTPS運用

現在のDocker本番プロファイルはHTTPS `3443`を使用し、証明書と秘密鍵がない場合は起動しない構成です。この構成を使う場合は本書の設定が必要です。

ただし、ローカルCA方式そのものをevent-pos全体の完成条件にはしません。実際のイベントで採用するネットワーク構成に応じて判断します。

## Docker本番プロファイル

証明書と秘密鍵を次へ配置します。

```text
.secrets/tls/server.crt
.secrets/tls/server.key
```

起動例:

```powershell
docker compose up -d --build --wait
Invoke-WebRequest -SkipCertificateCheck https://127.0.0.1:3443/health/ready
```

iPad/PCから証明書警告なしで利用する場合は、利用するhostname/IPを証明書のSANへ含め、端末側で発行CAを信頼させます。

## ネットワーク

POS専用または十分に隔離されたLANを優先します。

来場者等と共有する信頼できないネットワークへPOSの認証情報や会計通信を平文で流さないでください。共有ネットワークを使う場合はHTTPS等で通信を保護します。

Windows/Linux双方で同じ証明書方式を実演することや、ローカルCAを全ての構成に導入することは、本番投入の共通必須条件ではありません。
