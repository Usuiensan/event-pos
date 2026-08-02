# Goal 6 PR受入のOS別進捗

`A` は自動試験、`H` は実機、`R` は紙面/運用の人間確認。実機なしの項目を完了にはしない。

| 要件 | Windows x64 | Linux x86_64 | 現在の根拠と残件 |
| --- | --- | --- | --- |
| PR-01 同一内容をTM-T70IIへ印刷 | A,H,R: fixture v2をUSB切断→再接続後にも紙面・実読取り済み（W-04/W-05） | A,H,R: 同一fixture v2で紙面・実読取り済み | Windows/Linux同一hashの紙面比較は取得済み。写真/scan補強は任意 |
| PR-03 紙切れ/cover/USB切断 | A,H: USB切断でphysical PnP消失/queue raw `4096`、再接続後はPnP `OK`/queue raw `0`を取得。cover open・paper out時もraw `0`で、cover/paperは`unknown`を維持 | A,H: cover/paper-outは`unknown`、near-endはn=4=`1e`、USB切断は`ENODEV`、再接続後/OS再起動後ready復帰を実測 / R: UI未実施 | Windows host再起動・同一jobId/4レジFIFO、両OSのUIは未実施 |
| PR-06 cut/drawer | A: partial bytes固定 / H,R: cut受入済み、drawer Pending | A: partial bytes固定 / H,R: cut受入済み、drawer Pending | P003の機種/pin/pulse未提供 |
| PR-07 rendererから実機印刷 | A,H,R: canonical IR/bytes→Winspool→紙面・実読取り済み | A,H,R: 同一bytesを`/dev/usb/lp0`へ送信、bot停止/復帰、紙面・実読取り済み | Windows Service/OPOS比較は未実施 |
| PR-10 同一取引+版の再現 | A,H,R: fixture v2固定hashの紙面・実読取り済み。ただし同一jobId/4レジFIFO未実施 | A,H,R: Windowsと同一hashの紙面・実読取り済み | same `.bin`は取得済み。同一jobId/4レジFIFO未実施 |

Linux ARM64は実機未保有のため、2026-08-03にGoal 6の正式サポート・受入対象から除外した。将来再追加する場合は別途、同じfixtureと全実機受入を満たす必要がある。

Goal 7の正式adapter・POS queue/status API/UI統合はこの表の対象外である。ここでのWinspool/Linux RAW probeは技術検証用であり、実機結果が揃うまで正式採用ではない。
