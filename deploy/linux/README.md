# Linux本番対応プロファイル

Windowsと同格にサポートするLinux本番機への導入、systemd unit、udev、更新、backup、復旧手順をここへ配置する。

## 対象候補

- Debian/Ubuntu x86_64
- Debian/Ubuntu ARM64
- Raspberry Pi OS 64bit

具体的なdistribution/versionと機種はADR-P006で確定する。Raspberry Piを採用する場合はmicroSD単独を正本DB保存先にしない。

## 配布要件

- 専用service userで実行する。
- USB deviceをudevの安定名または属性で解決する。
- systemdで起動順、再起動方針、停止時timeoutを定義する。
- 更新前にbackupし、migration・自動試験が失敗した場合はserviceを再起動しない。
- 本番DB、秘密、暗号鍵をGitへ保存しない。
## Printer host

`apps/printer-host` is intended to run as a separate process from the POS server.

1. Confirm the device path with `lsusb`, `udevadm info` and `ls -l /dev/usb/lp*`; do not assume `lp0` or `lp1`.
2. Create `/etc/event-pos/printer-host.env`:

```text
PRINTER_DEVICE=/dev/usb/lp0
POS_BASE_URL=http://127.0.0.1:3000
```

3. Install `event-pos-printer-host.service`, create the restricted `event-pos` user, add it to `lp`, then run `systemctl daemon-reload` and `systemctl enable --now event-pos-printer-host`.
4. Verify `journalctl -u event-pos-printer-host`, `/health/live`, and a test job. Keep the actual device path, `lsusb` output, bytes hash, OS/kernel, paper width, and paper photo in the event evidence bundle.

The supplied udev file is a commented template. Confirm vendor/product identifiers before enabling a rule. Status probing that cannot be verified is reported as `unknown`; it must not be treated as ready or paper-out.

For recovery, stop the service before reconnecting USB, verify the device node and group permissions, start the service, then query the job state. A job that was transmitting when the host disappeared remains `unknown` and is not automatically resent.
