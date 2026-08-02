# Linux x86_64 PrinterHost本番起動

Windowsと同じjob、hash、FIFO、結果不明契約を使い、OS差をLinux RAW transportとsystemdだけに閉じ込める。`PrinterHost`はPOS serverとは別processで動かす。

## 配置と設定

1. Node.js 24、pnpm 11を導入し、release rootで`pnpm install --frozen-lockfile`と`pnpm check`を通す。
2. `lsusb`、`udevadm info`、`ls -l /dev/usb/lp*`でTM-T70IIを特定する。`lp0`を固定値とせず、確認済みudev ruleで`/dev/event-pos-receipt`を作る。
3. system user `event-pos`を作成して`lp` groupへ追加し、`/opt/event-pos`はroot所有・service user読取り専用にする。
4. `printer-host.env.example`を`/etc/event-pos/printer-host.env`へ配置し、mode `0640`、root所有にする。POS serverには`PRINTER_HOST_URL=http://127.0.0.1:4318`を設定する。ドロアー未受入中は`DRAWER_ENABLED=false`とする。
5. unitを`/etc/systemd/system/event-pos-printer-host.service`へ配置する。

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now event-pos-printer-host.service
systemctl status event-pos-printer-host.service
curl --fail http://127.0.0.1:4318/health/live
curl --fail http://127.0.0.1:4318/api/v1/printer/status
```

DLE EOTの4応答が揃わない場合はstatusを`unknown`として送信を止める。取得不能をreadyへ読み替えない。

## ログ、停止、再起動

```bash
journalctl -u event-pos-printer-host.service -n 100 --no-pager
sudo systemctl restart event-pos-printer-host.service
sudo systemctl stop event-pos-printer-host.service
```

ログの`transport_accepted`は`/dev`への全bytes書込み完了であり、紙面完了ではない。`jobId`、`bytesSha256`、`acceptedBytes`をPOS DBのattemptと照合し、紙面結果を別記録へ保存する。

USB切断時はserviceと既存`discord-printer-bot.service`を同時に動かさない。service停止、USB再接続、安定device名・owner/group確認、service起動、status確認の順で復旧する。応答消失時に`dispatch_started`だったjobは自動再送せず、POSの`unknown`と紙面を確認して明示再印刷する。

## 更新

serviceを停止し、POS DBをbackupしてからrelease全体を更新する。`pnpm install --frozen-lockfile`と`pnpm check`が失敗したreleaseは起動しない。旧releaseはDBと分離して保持し、復旧時も未確定jobを勝手に再送しない。

## BC-415M-B(6C)

到着前、またはP003の両OS受入前は`DRAWER_ENABLED=false`を維持する。到着後は接続図と2番pin、4/40 msを確認し、TM-T70IIのDK connector以外へ接続しない。Windows/Linuxで各1回だけ責任者操作として試験し、payload hash `dd99377f56cea3fca547e0df16d32c23d79eec311071cb670abc8a7f5c11c1de`、host応答、ログ、物理開放結果を保存する。全bytes受理だけで物理開放成功とは判定しない。
