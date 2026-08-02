# Goal 6 PR受入のOS別進捗

`A` は自動試験、`H` は実機、`R` は紙面/運用の人間確認。実機なしの項目を完了にはしない。

| 要件 | Windows x64 | Linux x86_64 | 現在の根拠と残件 |
| --- | --- | --- | --- |
| PR-01 同一内容をTM-T70IIへ印刷 | A,H,R: fixture v2をUSB切断→再接続後にも紙面・実読取り済み（W-04/W-05） | A,H,R: 同一fixture v2で紙面・実読取り済み | Windows/Linux同一hashの紙面比較は取得済み。写真/scan補強は任意 |
| PR-03 紙切れ/cover/USB切断 | A,H: Winspool queue/PnPはcover/paperを区別不能。OPOSではnormal時CoverOpen=`false`、RecEmpty=`false`、RecNearEnd=`true`、ErrorLevel=`None`を実測 / H: OPOS cover/paper-out/USB切断値は未実施 | A,H: cover/paper-outは`unknown`、near-endはn=4=`1e`、USB切断は`ENODEV`、再接続後/OS再起動後ready復帰を実測 / R: UI未実施 | Windows OPOSのcover/paper-out/USB fault、host再起動・同一jobId/4レジFIFO、両OSのUIは未実施 |
| PR-06 cut/drawer | A: partial bytes固定、BC-415M用drawer bytes `1b70000214`固定 / H,R: cut受入済み、drawer物理開放は判定待ち | A: partial bytes固定、同一drawer bytesのRAW write試験済み / H,R: drawer実機未実施 | BC-415M-B(6C)・2番pin・4/40 ms候補を固定。Windowsはtransport受理済みだが物理結果未判定、Linuxは到着後に実機証跡を取得 |
| PR-07 rendererから実機印刷 | A,H,R: canonical IR/bytes→Winspool→紙面・実読取り済み。OPOS `M-T70II` CheckHealthもOpen/Claim→診断印刷`Complete`を実測 | A,H,R: 同一bytesを`/dev/usb/lp0`へ送信、bot停止/復帰、紙面・実読取り済み | Windows Service、OPOS raw status/Claim timeoutは未実施 |
| PR-10 同一取引+版の再現 | A,H,R: fixture v2固定hashの紙面・実読取り済み。ただし同一jobId/4レジFIFO未実施 | A,H,R: Windowsと同一hashの紙面・実読取り済み | same `.bin`は取得済み。同一jobId/4レジFIFO未実施 |

Linux ARM64は実機未保有のため、2026-08-03にGoal 6の正式サポート・受入対象から除外した。将来再追加する場合は別途、同じfixtureと全実機受入を満たす必要がある。

Goal 7の正式adapter・POS queue/status API/UI統合はこの表の対象外である。ここでのWinspool/Linux RAW probeは技術検証用であり、実機結果が揃うまで正式採用ではない。

## Goal 7.1 統合差分

| 要件 | Windows x64 | Linux x86_64 | 現在の根拠と残件 |
| --- | --- | --- | --- |
| build済みHost・常駐起動 | A: standalone smoke、production-only portable deploy smoke、portable/WinSW定義、実backendのoffline statusまで確認 / H,R: Service無人起動未実施 | A: systemd/udev/env定義 / H,R: 対象機へ未配置 | 起動・停止・再起動・ログrunbookは実装。両OSのservice実演が必要 |
| POS FIFO統合 | A: 初回、再印刷、開局、中間計、精算の5jobを実HTTP HostへFIFO送信 | A: OS非依存経路は同一 / H,R: Linux実transport未実施 | compiler/adapter/write hashとacceptedBytesの自動一致は確認。実機runnerは紙面確認を逐次保存し、初回確認前の再印刷を禁止。両OSのHostログ・紙面が必要 |
| 再起動・切断・結果不明 | A: queue/Host試験でunknown・自動再送禁止を確認 / H,R: 実Service/USB未実施 | A: 同じqueue契約 / H,R: 実systemd/USB未実施 | 既存Goal 6 probeだけでGoal 7.1完了にはしない |
| 紙面5種 | 未実施（USB controller不在） | 未実施（対象機へ到達不能） | jobId/hash/acceptedBytes/hostログと紙面判定をOS別に保存する |

詳細は[Goal 7.1 status](goal7.1-status.md)を参照する。
