# Goal 6 PR受入のOS別進捗

`A` は自動試験、`H` は実機、`R` は紙面/運用の人間確認。実機なしの項目を完了にはしない。

| 要件 | Windows x64 | Linux x86_64 | Linux ARM64 | 現在の根拠と残件 |
| --- | --- | --- | --- | --- |
| PR-01 同一内容をTM-T70IIへ印刷 | A,H,R: Winspool RAWで紙面・実読取り済み | A: fixture生成済み / H,R: 未実施 | A: fixture生成済み / H,R: 未実施 | 同一fixture hashのLinux紙面が必要 |
| PR-03 紙切れ/cover/USB切断 | A: unknownを保持 / H,R: 未実施 | A: unknownを保持 / H,R: 未実施 | A: unknownを保持 / H,R: 未実施 | raw statusと能力表を実測で更新 |
| PR-06 cut/drawer | A: partial bytes固定 / H,R: cut未実施、drawer Pending | A: partial bytes固定 / H,R: cut未実施、drawer Pending | A: partial bytes固定 / H,R: cut未実施、drawer Pending | P003の機種/pin/pulse未提供 |
| PR-07 rendererから実機印刷 | A,H,R: canonical IR/bytes→Winspool→紙面・実読取り済み | A: canonical IR/bytes fixture済み / H,R: 未実施 | A: canonical IR/bytes fixture済み / H,R: 未実施 | 既存Debian commit/serviceをrun manifestへ記録 |
| PR-10 同一取引+版の再現 | A,H,R: fixture固定hashの紙面・実読取り済み。ただし同一jobId/4レジFIFO未実施 | A: deterministic fixture test済み / H,R: 未実施 | A: deterministic fixture test済み / H,R: 未実施 | same `.bin`、同一jobId、4レジFIFO、Linux紙面比較が必要 |

Goal 7の正式adapter・POS queue/status API/UI統合はこの表の対象外である。ここでのWinspool/Linux RAW probeは技術検証用であり、実機結果が揃うまで正式採用ではない。
