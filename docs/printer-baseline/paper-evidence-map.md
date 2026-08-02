# 紙面・障害証跡対応表

| 試験ID | OS/方式 | fixture SHA-256 | 紙面写真/scan ID | QR実読取り | Code 128実読取り | 日本語・円・32桁 | feed/cut | 判定 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| W-01 | Windows x64 Winspool RAW | `cb0fd1c71fe171d075167d967b099d4a6c26eb71aabcbf2b1ae9ccf88f3dac0d` | 未取得 | 未確認 | 未確認 | 未確認 | 未確認 | OS/spooler受理済み、紙面未判定 |
| W-02 | Windows x64 Winspool RAW | `cb0fd1c71fe171d075167d967b099d4a6c26eb71aabcbf2b1ae9ccf88f3dac0d` | `windows/20260803-0001/paper-W-01.jpg` | 操作者スマホ実読取りOK | 操作者スマホ実読取りOK | 写真確認済み | HRIがcutで見切れ（不合格） | v1の紙面不具合。v2で是正 |
| W-03 | Windows x64 Winspool RAW | `f0ff616649668fb7972837ab1134a1996e437ce2a5b43f0d60b4cd7af9ddc695` | 操作者報告 | 操作者実読取りOK | 操作者実読取りOK | 操作者確認済み | HRIまで読取り可・cut可 | v2正常紙面受入。状態・障害試験は未実施 |
| L64-01 | Linux x86_64 `/dev/usb/lp0` | `cb0fd1c71fe171d075167d967b099d4a6c26eb71aabcbf2b1ae9ccf88f3dac0d` | 操作者報告 | 操作者実読取りOK | 操作者実読取りOK | 操作者確認済み | HRIがcutで見切れ（不合格） | v1の紙面不具合。v2で是正 |
| L64-02 | Linux x86_64 `/dev/usb/lp0` | `f0ff616649668fb7972837ab1134a1996e437ce2a5b43f0d60b4cd7af9ddc695` | 操作者報告 | 操作者実読取りOK | 操作者実読取りOK | 操作者確認済み | HRIまで読取り可・cut可 | v2正常紙面受入。状態・障害試験は未実施 |
| LA64-01 | Linux ARM64 | 未生成 | 未取得 | 未取得 | 未取得 | 未取得 | 未取得 | 未実施 |

写真・scanはこの表のIDでファイル名へ結び、取引番号・個人情報を写さない。各OSで同じ`fixture.bin`のhashを記録し、物理紙面の一致は別途人間が判定する。
