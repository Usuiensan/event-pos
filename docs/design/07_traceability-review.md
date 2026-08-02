# 07. 要件追跡と相互レビュー

## 1. Objective完了追跡

| Goal要求 | 証拠 | 状態 |
| --- | --- | --- |
| 技術スタック | `01_architecture.md` 1章 | 定義済み |
| ディレクトリ構成 | `01_architecture.md` 3章 | 定義済み |
| DBモデル | `02_data-and-api.md` 1〜3章 | 定義済み。業務未決はADRへ分離 |
| API境界 | `02_data-and-api.md` 4〜6章 | 定義済み |
| 印刷キュー | `03_printing.md` 5章 | 定義済み |
| OS固有プリンター層 | `03_printing.md` 6〜8章 | interface定義済み。採用品はADR-P001/P002 |
| テスト戦略 | `04_test-strategy-and-acceptance.md` 1〜2、7章 | 定義済み |
| ADR管理 | `05_pending-adrs.md`、`08_adr-decisions-2026-07-24.md` | Accepted判断と実機Pendingを分離 |
| 18章の分類 | `04_test-strategy-and-acceptance.md` 3〜6章 | 46/46件をA/H/R分類 |
| 未確定業務・実機結果を推測しない | `05_pending-adrs.md`、`03_printing.md` 8章 | gateと必要証拠を定義 |
| 成果物の相互レビュー | 本書2章 | 3観点の独立レビューを反映 |
| 実装フェーズ別Goal | `06_phase-goals.md` | 9件作成 |

## 2. 相互レビュー記録

| Review ID | Reviewer | 日付 | 対象 | 初回最大重要度 | 状態 | 再確認 |
| --- | --- | --- | --- | --- | --- | --- |
| RV-DATA-01 | `domain_data_review` | 2026-07-24 | 業務・DB・API draft 1〜final | Critical | 検証済み | 再確認でP0/P1なし |
| RV-PRINT-01 | `printing_os_review` | 2026-07-24 | 印刷・OS・実機 draft 1〜final | P0 | 検証済み | 再確認でP0/P1なし |
| RV-ACCEPT-01 | `acceptance_goal_review` | 2026-07-24 | 受入分類・Goal draft 1 | P1 | 検証済み | 再確認でP0/P1なし |

各reviewerは要件v0.5と設計成果物を独立に照合した。指摘を重要度付きで受け取り、下表の修正後に同じreviewerへ再確認を依頼した。未解消のP0/P1がある間は設計完了にしない。

### Review A: 業務・DB・API

確認観点:

- 会計確定の原子性
- 追記型取引・在庫・現金・監査
- 負数在庫
- 返品・締め・冪等性
- APIの状態変更境界

指摘と反映:

| 指摘 | 対応 |
| --- | --- |
| 初回print job/operationは会計確定と同一transactionに必要 | Architecture/DBの確定手順へ明記 |
| print送信はcommit後でなければならない | queue worker境界へ明記 |
| 現金を集計値だけにせずcash ledgerを正本にする | `cash_movements` とtransaction境界を追加 |
| 値引き配賦がないと税・返品・再印刷を再現できない | `applied_discount_lines` を追加 |
| 現行masterを過去取引から参照しない | transaction/receipt snapshotを固定 |
| 税、返品、見本、担当者印字等が初期設計で未確定 | ADR-D007〜D019を追加し、2026-07-24判断を08へ記録 |
| 取り置き受取をdraft追加時点で減算すると取消時に不整合 | active claimを導入し、会計確定時だけremaining/reservedを減算 |
| 責任者番号の3桁・有効期間重複制約が曖昧 | ASCII 3桁CHECKと半開区間重複拒否triggerを定義 |
| R18自己申告だけのpolicyが有効化できる | 自己申告とは別の容貌/身分証目視groupをvalidatorで必須化 |
| 再印刷の別人承認強制は要件5.3の自己承認許可と矛盾 | 自己承認を許可し、`self_approved` とrisk acceptanceを監査 |

### Review B: 印刷・OS・実機

確認観点:

- 永続直列queue
- template/IR/ESC-POS境界
- 二重印刷
- status能力差
- Windows/Linux adapter
- drawer/cut

指摘と反映:

| 指摘 | 対応 |
| --- | --- |
| 差込み文字列からcommand injectionが起こり得る | 宣言的YAML→typed AST→canonical IRへ変更 |
| 送信途中crashを自動再送すると二重印刷になる | `delivery_certainty=unknown` を隔離し明示reprintだけ許可 |
| status失敗をoffline/正常と決めつけてはいけない | Capabilityのunsupported/unknownを定義 |
| status照会と印刷が競合する | 同一printer mutexでstatus/send/device jobを直列化 |
| drawerをtemplateに置くと再印刷でも開く | Receipt ASTからdrawerを除外し専用device job化 |
| template版だけではOS間画像再現性が不足 | renderer/font/asset/hashをjobへ保存 |
| full命令と完全切断は同義ではない | fullをTM-T70II allowlistから除外し実機結果を別証拠化 |
| jobとoperationにqueue状態が重複すると競合する | `printer_operations.state` を唯一のqueue正本に統一 |
| `retry_wait` の順序・上限・復旧条件が不明 | strict FIFO、2/5/15秒、最大3再試行、fault block/resumeを定義 |
| 再印刷元・版・現物結果が曖昧 | source jobと版を固定し、現物結果3値・risk acceptance・承認を必須化 |

### Review C: 受入試験・Goal分割

確認観点:

- 18章全項目数
- 自動/実機/人間の責任分離
- ADR gate
- Goalの独立性と完了基準

指摘と反映:

| 指摘 | 対応 |
| --- | --- |
| 18章は46件 | AC 22、PR 11、R18 3、CL 10を全件採番 |
| 「同じ印字」はbytesだけでは証明不能 | PR-01/10をA+H+Rに分類 |
| privacyはschema不在だけでは証拠が弱い | canary PIIを全保存先でscan |
| 実機未決を環境変数defaultで埋めてはいけない | ADR gate、起動拒否/機能無効を規定 |
| 一つのGoalでは大きすぎる | 技術検証を含む9 Goalへ分割 |

## 3. 章別要件追跡

| 要件章 | 主設計 | 主受入 |
| --- | --- | --- |
| 1〜4 目的・構成・性能 | Architecture 1〜6 | AC-01〜03、AC-12、CL-10 |
| 5 認証・承認 | Architecture 7、Data 2.1 | AC-10、CL-09 |
| 6 商品・在庫・値引き | Data 2.2/2.5 | AC-03〜11、CL-04〜07 |
| 7 会計・支払 | Data 2.3/2.4、API 5.2 | AC-12〜22 |
| 8 R18 | Data age verification、ADR-D011 | R18-01〜03 |
| 9 顧客画面 | Architecture realtime、API 6 | AC-01/04、R18-01/02 |
| 10 プリンター | Printing全章 | PR-01〜11 |
| 11 レシート・税 | Data tax summary、Printing snapshot | AC-08〜11、PR-07/10、CL-08 |
| 12 取消・返品 | Data transaction境界、ADR-D009 | AC-04、CL-03 |
| 13 現金・締め | Data 2.6 | CL-01〜03/08〜10 |
| 14 保存・CSV | Architecture 8、Data export | CL-03/04/10 |
| 15 操作性 | Architecture UI、Test browser | AC-13〜22、Rレビュー |
| 16 障害 | Architecture 6/8、Printing 5〜8 | PR-03/04、CL-10 |
| 17 監査 | Architecture 7、Data audit | CL-03/09 |
| 18 受入 | Test document | 46件 |
| 19 未確定 | ADR登録簿・判断記録 | P001〜P006 |

## 4. 設計上の既知の保留

以下は設計漏れではなく、決定権者または実機証拠を待つ意図的な保留である。

- P001〜P003/P006の実機・本番構成決定
- D020バーコード名前空間はAccepted。残件は使用予定scanner・58 mm実機読取り結果
- P004/P005/D010による要件差分は `docs/requirements/即売会向けPOSレジ_要件定義_v0.5.md` へ反映済み
- Windows/Linux双方のUSB/spooler・status実測能力表。既存Debian環境を初期基準にする
- drawer型番/pulse
- 税/値引き/返品の業務判断
- 本番hardwareと復旧目標

これらを未決のまま総合受入完了へ進めない。

## 5. 実装引渡し判定

設計は次の条件を満たしたため、ADRが許す範囲のフェーズ実装へ引き渡せる。

- 各write use caseのtransaction境界が明示されている。
- public API、状態、冪等・版競合が定義されている。
- printの論理生成と物理送信、成功証拠が分離されている。
- 46件の受入条件に必要な証拠種別が割り当てられている。
- 未確定事項は暗黙defaultではなくADR gateになっている。
- 各実装Goalに成果、制約、verificationがある。

## 6. 2026-07-24 ADR更新監査

| 確認項目 | 結果 |
| --- | --- |
| 利用者が確定した判断 | P004、D007〜D012、D015〜D017をAcceptedとして08へ記録 |
| P005確定 | 特定会計ソフト非依存のcanonical bundleを随時再生成し、製品別adapterは将来追加 |
| 推奨案採用 | D013、D014、D018、D019をAcceptedへ移行 |
| 要件v0.5との差分 | P004、P005、D010を要件v0.5へ統合し、AC-10、CL-04、CL-07を整合 |
| DB/API整合 | event別商品、税込・税率別一回丸め、全部返品、見本区分廃止、R18初期appearance、担当者印字設定、超過取り置きを反映 |
| Goal整合 | Goal 2/3/8の前提と対象外機能を更新 |
| 最終保留 | 実機・本番構成P001〜P003/P006、およびD020のscanner・58 mm実機読取りがPending |
| 追加提案 | D020で伝票・取り置き・商品・ISDNを分離するCode 128名前空間を提案 |

## 7. 2026-08-02 Linux本番方針更新（Superseded）

- Windows本番ホスト方針を`10_adr-linux-production-host-2026-08-02.md`で置き換えたが、このLinux単独方針は後のADR-P010によりSupersededとなった。
- 当時は要件v0.6、Architecture、Printing、受入、Pending ADR、Goal、引継ぎ文書をLinux本番へ更新した。
- 現在の正本は11章とADR-P010であり、Windows/Linux双方を本番USB・障害復旧・性能受入対象とする。
- x86_64とARM64の双方を自動試験対象とし、採用ハードウェアはP006の実測後に確定する。

## 8. 2026-08-02 会計確定実装の受入証跡

対象commitは `92f3bc0`、`5f36707`、`aefa758`、`104fa41`、`470863d`、`64ae53e`。Goal 2〜4のうち、税区分、会計ドラフト、会計確定、顧客表示投影、R18保存境界を実装した。自動試験の正本は `packages/contracts/src/checkout.test.ts`、`packages/contracts/src/auto-discount.test.ts`、`apps/server/src/checkout.test.ts`、`apps/register-web/src/checkout-api.test.ts` である。

| 受入項目 | 実装・自動試験証拠 | 判定 |
| --- | --- | --- |
| AC-02 | 60会計のburstで取引、明細、支払、在庫移動、冪等記録、初回print job/operation、現金移動を各60件照合 | A合格。15分継続900件はGoal 9で再実施 |
| AC-03 | 在庫1点に対する2レジ確定を並行実行し、取引2件、在庫移動2件、残高-1を照合 | A合格 |
| AC-07 | 販売停止商品を含むセット追加を全件rollbackし、draft versionと明細0件を照合 | A合格 |
| AC-08/09 | 数量token非重複、最大値引き、同額時rule ID決定、条件解除後の再計算を照合 | A合格 |
| AC-10/11 | 任意値引き0/100/101%、自動値引きとの併用、解除、非負合計を照合。承認・理由API/UIは未作成 | A合格 |
| AC-12 | 同一冪等keyの同時確定と再送で同一取引を返し、取引と初回print jobを1件に固定 | A合格 |
| AC-18 | 預り金不足で422 `PAYMENT_INSUFFICIENT`、draft payment 0件、取引0件を照合。既存エラーモーダルへ日本語messageを表示 | A合格、Rは総合受入で実施 |
| AC-21 | 500円預り、110円支払、390円釣銭を支払snapshotと顧客表示投影で照合 | A合格 |
| R18-03 | 許可fieldを限定し、容貌確認・身分証目視だけを保存。canary生年月日をdraft/取引DBから検出しないことを照合 | A合格 |
| 原子性・障害境界 | `after_inventory`故障注入で全成果物をrollback。commit後の印刷送信失敗では取引・在庫を保持しprint jobだけ`failed`へ遷移 | 合格 |
| 再起動復元 | SQLiteをclose/reopenし、取引snapshot、完了draft、顧客表示投影を再取得 | 合格 |
| UI接続 | 実ブラウザーで商品追加、顧客画面同期、現金会計、預り・釣銭表示、スタッフ画面再読込後の会計済復元を確認 | 合格 |
| Docker | `docker compose up -d --build --wait`後にcontainer healthとDB readinessが`ok`。隔離環境でcatalog→draft→line→cash→finalize→transaction/customer projectionを通過 | 合格 |

2026-08-02時点で `pnpm check` は型検査、80件の自動試験、全workspace buildに成功した。通常composeの `event-pos-pos-1` は既存volumeを保持したまま `running/healthy` である。

次はこの実装範囲を総合受入済みと誤認しないこと。TM-T70IIの紙面、cut、USB切断・再接続、status能力、15分継続負荷、10端末、画面視認性の人間レビューは未実施であり、Goal 6/7/9の証拠が必要である。

## 9. 2026-08-02 Goal 4 音声・顧客画面同期・R18スキップ・会計済みロック

対象commitは `0e0d30a`、`569a788`、`0a7a4f4`、`dee0165`。既存の会計確定API、SQLite正本、draft version、`Idempotency-Key`、顧客画面REST projection、18歳/20歳の最終確認条件を維持したまま、Goal 4の一部を実装した。在庫、複数プリンター、Windows/Linux PrinterHost、backup、XLSX/CSV export、Docker導入scriptは対象外である。

| 対象 | 実装・試験証拠 | 判定 |
| --- | --- | --- |
| 3種類の音量 | tap/error/speechを0〜100で独立保存。server版付き設定とregister別localStorageを復元し、業務メニューから個別試聴 | A合格。実ブラウザーで17/42/73を保存し再読込後の復元を確認 |
| エラー音区分 | 誤操作は指定WAVから変換した2.44秒MP3、system errorはC5 523.25Hz連続ブザー。誤操作DOMに音停止buttonを生成しない | A合格。実会場の聞き分けはR未実施 |
| 読み上げ優先順位 | server lastSeenが有効なcustomerへ一度だけ割当て、未接続・期限切れ時だけstaffへ割当て。ack済みsequenceは再生しない | A合格。speaker実音量・二端末実聴はR未実施 |
| heartbeat | customerが2秒ごとに小payloadをPOSTし、server TTL 5秒で利用可否を判定。WebSocket接続状態を利用可否の正本にしない | A合格 |
| WebSocket/REST復元 | WebSocketはID/version通知だけ。250ms〜8秒の指数backoff、再接続時REST再取得、1秒REST polling、ETag/no-store、draft/projection version比較を実装 | A合格。network shapingを使う低帯域Human Reviewは未実施 |
| R18スキップ | customer利用可能時は要求から10秒間disabledで残秒表示、10秒後有効。customerなし/TTL切れは即時有効 | A合格。別tab実ブラウザーで接続中10秒と、customerなしの即時有効を確認。切断再評価は単体試験済み |
| R18保存境界 | 容貌確認・身分証目視だけを既存APIへ保存し、年齢、生年月日、身分証番号は保存しない。18歳確認で20歳商品を確定できない既存試験を維持 | A合格。対面運用のH/Rは未実施 |
| 会計済みlock | 完了draftをREST/SQLiteから復元し、取消、数量、売価、値引き、支払変更/再実行、登録中止をUIとhandlerとserverで拒否。REST polling中も利用者が開いた支払画面を維持 | A合格。実ブラウザーで会計直後と再読込後の「次の取引」表示、登録中止disabledを確認 |
| finalize失敗・連打/再送 | 成功後のGET draftだけで完了表示。送信中guardと既存冪等keyを維持し、同一key再送でtransaction/初回print job各1件を照合 | A合格 |
| Docker | `docker compose up -d --build --wait`で再buildし、`event-pos-pos-1`が3000番でhealthy | 合格 |

自動試験の正本は `apps/server/src/realtime.test.ts`、`apps/server/src/checkout.test.ts`、`apps/register-web/src/audio-settings.test.ts`、`apps/register-web/src/realtime-client.test.ts`、`apps/register-web/src/state-version.test.ts`、`apps/register-web/src/age-skip.test.ts`、`apps/register-web/src/error-dialog.test.tsx` である。リポジトリにPlaywright依存がないため、スタッフ画面と顧客画面はin-app browserの別tabで実動確認した。別browser contextを使う自動E2Eは未完了として残す。

Goal 4全体、R18、音の聞き取り、画面視認性を自動試験だけで完了扱いにしない。実会場に近いspeakerと騒音下で3音量・誤操作MP3・C5連続ブザーを確認し、customer端末の電源断/再接続、遅延・低帯域、R18対面手順、会計済み操作のHuman Reviewを実施するまでH/Rは未完了である。

## 10. 2026-08-02 Goal 5 レシート・永続印刷キュー

対象commitは `2123830`、`99835a9`、`9a45179`。自動試験の正本は `packages/receipt-ir/src/index.test.ts`、`packages/receipt-template/src/index.test.ts`、`packages/escpos/src/index.test.ts`、`apps/printer-host/src/app.test.ts`、`apps/server/src/print-queue.test.ts`、`apps/server/src/printing-schema.test.ts`、`apps/server/src/printing-routes.test.ts`、`apps/server/src/checkout.test.ts`、`apps/register-web/src/print-status.test.ts` である。

| 受入項目 | 実装・自動試験証拠 | 判定 |
| --- | --- | --- |
| PR-02 | 4件同時triggerでもactive dispatchを1件に限定し、operation sequenceどおりのjob ID、完了状態、compiler/adapter/write hash、accepted bytesを照合 | A合格。4台実レジと実機連続紙面のH/Rは未実施 |
| PR-05 | 再印刷前後でtransaction、transaction line、payment、tax summary、inventory movement、cash movement件数を照合し、元jobも不変で新reprint jobだけ追加 | A合格 |
| PR-08 | template/IR/ESC/POSを独立packageへ分離し、template v2有効化前後で旧取引・旧jobを変更せず旧版再生成。全workspace typecheck/test/buildを実施 | A合格。依存境界の総合Rは未実施 |
| PR-09 | 未知node/変数、raw/drawer/buzzer/full cut、不正引数、幅超過、finish欠落/複数、source SHA不一致をunit/API試験で拒否 | A合格 |
| PR-10 | 同じsnapshotから同じASTを生成し、canonical IR、CP932、日本語、U+00A5、画像、QR、バーコード、feed、partial cutのgolden hashを固定。template更新後も旧jobのIR/hash/bytesを一致確認 | A合格。紙面・文字化け・配置・cutのH/Rは未実施 |
| PR-11 | original/reprint jobへtemplate key/version/source hash、asset manifest、font/renderer/finishing policy版、snapshot、IR/hash、bytes/hashを保存し、再印刷がsource版を使うことを照合 | A合格 |
| queue failure境界 | 0 byteかつretryableだけを2/5/15秒、最大4 attempt。short write、timeout、host応答不明、dispatch後crashはunknownで再送せず、prepared中断だけ復元。retry_wait/device faultのhead追越し禁止 | 合格 |
| PrinterHost冪等性 | 同じjobIdのHTTP再送を2回受けてもFakeTransport dispatchは1回。canonical IRから得たbytesを追加feed/cutなしで完全一致送信 | 合格 |
| migration/再起動 | 旧6状態をGoal 5状態へmigrationし、起動時にSQLiteの未完了jobを回収。会計確定後のPrinterHost失敗でも売上・支払・在庫・現金・監査を保持 | 合格 |
| UI状態 | 待機、送信中、送信完了、失敗、再試行待ち、結果不明、取消を対応し、`unknown`と通常失敗を別class/文言にするunit試験。実ブラウザーで送信中→紫色の「結果不明（紙面を確認）」遷移、受付番号、再印刷確認modalの3値・理由・承認欄を確認 | A合格。通常失敗を含む残り状態の視認性Hは未完了 |
| Docker | 初回buildで新packageのruntime copy漏れを検出・修正後、`docker compose up -d --build --wait`成功。`event-pos-pos-1` healthy、live/readyとtemplate一覧を確認 | 合格 |

2026-08-02時点の `pnpm check` は型検査、118件の自動試験、全workspace buildに成功した。Windows上のgoldenと同じ9件のreceipt IR/template/ESC/POS変換試験をDocker Linux build stageでも実行し、hashを含めて一致を確認した。これはOS非依存bytesの証拠であり、TM-T70II紙面一致の証拠ではない。

Human Reviewは未完了である。template preview APIの人間可読内容、結果不明表示、再印刷確認画面は確認済みだが、通常失敗・再試行待ち・取消を含む全状態の視認性とレイアウト総合判定は残る。Goal 6/7ではWindows x64とLinux x86_64/ARM64について、TM-T70IIの日本語・円記号・幅・実feed・部分cut、USB切断/再接続、紙切れ/カバー/open/offline/status能力、Windows Service、udev/systemd、既存Debian基準紙面との差分を記録する。ADR-P009はProposedのままである。

## 11. 2026-08-02 Windows/Linux同格対応への訂正

- 利用者判断により、Linuxだけを初期本番対象としたADR-P007をSupersededとし、ADR-P010をAcceptedとした。
- Windows x64と64bit Linuxは同格の本番対応プロファイルであり、個別eventの機材選択によってもう一方の正式サポートを廃止しない。
- 要件v0.6、Architecture、Printing、受入台帳、Pending ADR、Goal 6/7/9、引継ぎ、継続promptを両OS受入へ更新した。
- PR-01/03/04/06/07/10とCL-10は、Windows/Linux双方のA/H/R証跡がそろうまでOS対応全体を完了扱いにしない。
- WindowsのRAW spooler/EPSON/OPOS/ServiceとLinuxのRAW/libusb/udev/systemdはOS別に実測し、同じjob契約、ESC/POS bytes、紙面、certainty、復旧結果へ収束させる。
