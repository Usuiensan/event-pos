# Linux配布

本番Linux機への導入、systemd unit、udev、更新、backup、復旧手順をここへ配置する。

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
