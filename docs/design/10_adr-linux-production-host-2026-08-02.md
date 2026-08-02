# ADR-P007 Linux本番サーバー・プリンターホスト方針

- 状態: `Superseded`
- 決定日: 2026-08-02
- Supersedes: 2026-07-24に記録したWindows本番プリンターホスト方針
- Superseded by: ADR-P010 `15_adr-windows-linux-printer-parity-2026-08-02.md`

この文書はLinuxだけを初期本番対象とした時点の履歴である。現在の正本はADR-P010であり、Windows x64と64bit Linuxの双方を同格の本番対応・実機受入対象とする。

## 決定

即売会本番では、POS server、SQLite正本、印刷ワーカー、TM-T70II USB接続を64bit Linux機へ集約する。候補distributionはDebian、Ubuntu、Raspberry Pi OSとし、Windows PCは開発・管理・ブラウザークライアントとして利用できるが、初期本番のプリンターホスト要件には含めない。

CPUはx86_64またはARM64を対象とする。Raspberry Pi等を採用する場合、microSD単独を正本DBの保存先にせずUSB SSD等を使用する。具体的な機種、distribution/version、storage、UPS、予備機、復旧目標はADR-P006で決定する。

## 理由

- TM-T70IIはすでにDebian上のDiscord botから稼働しており、ESC/POS送信、systemd運用、USB再接続の実測基準がある。
- 即売会本番ではUI操作端末とプリンターサーバーを分離でき、Linux機を固定構成・自動起動・省電力で運用しやすい。
- Windows固有のSpooler/OPOS比較を初期必須作業から外し、既存Linux知見をPOS用に移植できる。
- Raspberry Piかx86_64小型PCかは、性能、storage耐障害性、USB安定性、交換容易性を実測してから選ぶべきである。

## 制約

- `event-pos`は`discord-printer-bot`へ実行時依存しない。コード移植時は移植元commit、ファイル、golden testを記録する。
- `/dev/usb/lp*`の番号を固定とみなさず、udevによる安定名または属性検索を使う。
- 印刷とstatus取得を同一printer mutexで直列化し、`EBUSY`等のstatus失敗と実際の印刷結果を分離する。
- USB切断後のdevice node再生成、systemd再起動、権限、paper/cover/status能力を実機で確認する。
- 取得不能状態は正常・異常と推測せず`unknown`とする。
- Windowsでも業務ロジック、DB migration、Web UI、ESC/POS生成の自動試験を実行できる状態を維持する。

## P001/P002/P006へ残す確認

- P001: `/dev/usb/lp*`、libusb等の採用方式、双方向status、排他、timeout、再接続、x86_64/ARM64配布。
- P002: reachable、online、cover、paper、recoverable/fatal errorの取得能力表。
- P006: Raspberry Pi/ARM64またはx86_64小型PC、distribution、USB SSD、router、UPS、予備機、復旧時間目標。

## 検証順序

1. 既存Debian環境から同一fixtureのESC/POS bytes、hash、紙面、device・service設定を保存する。
2. POS用最小probeで送信、status、mutex、切断・再接続を再現する。
3. Linux PrinterTransportを実装し、fakeと同じcontract testを通す。
4. x86_64とARM64でbuild、migration、負荷、USB、停電復旧を比較する。
5. P001/P002/P006をAcceptedにして本番機を固定する。
