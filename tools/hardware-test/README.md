# Linuxプリンター実機試験ツール

TM-T70IIへ固定fixtureを送信し、送信方式、状態取得、障害復旧を比較するCLIをここへ実装する。

初期比較対象:

- `/dev/usb/lp*`への直接送信
- 双方向statusが必要な場合のlibusb等
- Debian既存環境の出力bytes・紙面・systemd・USB設定
- x86_64 LinuxとARM64 Linux

実機を接続するまで、送信方式や取得可能なstatusを確定扱いにしない。印刷成功とstatus取得失敗を別々に記録する。
