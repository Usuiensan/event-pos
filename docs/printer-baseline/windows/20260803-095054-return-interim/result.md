# TM-T70II 返品・中間点検紙面試験

- 実施日時: 2026-08-03 09:52 JST
- OS: Windows x64
- printer: EPSON TM-T70II Receipt
- adapter: Windows RAW spooler
- 専用DB: `event-pos.sqlite`
- transport証跡: `return-interim-evidence.json`

## 送信結果

| 紙面 | job ID | state | delivery certainty | bytes |
| --- | --- | --- | --- | ---: |
| 試験準備売上 | `019fc51b-cf71-753e-81e0-c951b210d51a` | completed | accepted | 522 |
| 全部返品 | `019fc51b-e1db-7e52-9f5a-8ed507c571e2` | completed | accepted | 460 |
| 中間点検 | `e44e6c34-3512-45a7-95e2-e1e5b807efe5` | completed | accepted | 300 |

`completed/accepted`はWinspoolが全bytesを受理したことだけを表す。紙面完了を推測しない。

## 紙面目視

操作者が`IMG_0473.jpg`で6枚を確認し、印字良好と判定した。返品・中間点検は全文、配置、日本語・円金額、部分カットに問題なし。

6枚の内訳は、最初のrunで開局・試験準備売上の2枚、修正後runで開局・試験準備売上・全部返品・中間点検の4枚である。最初のrunは返品API pathの誤りで安全停止したが、停止前に作成済みの開局・売上jobは正常に印字された。同一jobの自動再送による重複ではない。

- 判定: 合格
- 判定者: 利用者
- 写真: `IMG_0473.jpg`
- 全文: 良好
- 配置: 良好
- 文字化け: なし
- 部分カット: 良好

