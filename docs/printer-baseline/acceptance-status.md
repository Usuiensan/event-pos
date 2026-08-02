# Goal 6 PR受入のOS別進捗

`A` は自動試験、`H` は実機、`R` は紙面/運用の人間確認。実機なしの項目を完了にはしない。

| 要件 | Windows x64 | Linux x86_64 | Linux ARM64 | 現在の根拠と残件 |
| --- | --- | --- | --- | --- |
| PR-01 同一内容をTM-T70IIへ印刷 | A,H,R: fixture v2で紙面・実読取り済み | A,H,R: 同一fixture v2で紙面・実読取り済み | A: fixture生成済み / H,R: 未実施 | ARM64の同一fixture hash紙面が必要 |
| PR-03 紙切れ/cover/USB切断 | A: unknownを保持 / H,R: 未実施 | A,H: cover/paper-outは`unknown`、USB切断は`ENODEV`、再接続後ready復帰を実測 / R: UI未実施 | A: unknownを保持 / H,R: 未実施 | Windows fault stateとARM64のraw status・UIを実測 |
| PR-06 cut/drawer | A: partial bytes固定 / H,R: cut未実施、drawer Pending | A: partial bytes固定 / H,R: cut未実施、drawer Pending | A: partial bytes固定 / H,R: cut未実施、drawer Pending | P003の機種/pin/pulse未提供 |
| PR-07 rendererから実機印刷 | A,H,R: canonical IR/bytes→Winspool→紙面・実読取り済み | A,H,R: 同一bytesを`/dev/usb/lp0`へ送信、bot停止/復帰、紙面・実読取り済み | A: canonical IR/bytes fixture済み / H,R: 未実施 | ARM64の既存基準・紙面を記録 |
| PR-10 同一取引+版の再現 | A,H,R: fixture v2固定hashの紙面・実読取り済み。ただし同一jobId/4レジFIFO未実施 | A,H,R: Windowsと同一hashの紙面・実読取り済み | A: deterministic fixture test済み / H,R: 未実施 | same `.bin`、同一jobId、4レジFIFO、ARM64紙面比較が必要 |

Goal 7の正式adapter・POS queue/status API/UI統合はこの表の対象外である。ここでのWinspool/Linux RAW probeは技術検証用であり、実機結果が揃うまで正式採用ではない。
