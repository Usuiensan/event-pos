# event-pos 引継ぎ資料

更新日: 2026-08-02

この文書は、別PCや本番Linux機へ作業を引き継いだときに、Codexの会話履歴が参照できなくても作業を再開できるようにするための正本である。

## 1. リポジトリ

- GitHub: `https://github.com/Usuiensan/event-pos`
- 公開範囲: Private
- default branch: `main`
- 初期commit: `15935c8 event-posリポジトリを初期化`
- 旧実装の参照元: `discord-printer-bot`
- 参照時点のDiscord bot commit: `0057b3d`
- 参照時点のDiscord bot branch: `codex/printer-operations-guide`

`event-pos` はDiscord botから独立した製品とする。Discord botをGit submodule、package依存、実行時依存にはしない。必要な印刷コードは移植元commitとファイルを記録してから、テストとともに移植する。

## 2. 製品の目的

同人誌・グッズ等の即売会で使用する、複数レジ端末対応POSである。

- 売上、税込価格、税率、値引き、返品、在庫、取り置き、R18確認を扱う。
- 管理端末、レジ端末、カスタマーディスプレイを会場LANで接続する。
- レシートはEPSON TM-T70IIへ印刷する。
- 本番構成では64bit Linux機をPOS server兼プリンターホストとする。
- Debian、Ubuntu、Raspberry Pi OS等を候補とし、現在TM-T70IIが接続されているDiscord bot用Debian環境を初期実測基準とする。
- Windows PCは開発・管理・ブラウザークライアントとして継続利用できる。

## 3. 技術方針

- pnpm/TypeScript monorepo
- Fastify server
- React UI
- SQLite
- DB、USB、時刻、ID採番はport越しに注入する。
- ESC/POS生成はOS非依存の純粋処理にする。
- 本番対象PrinterTransportはLinux。
- プリンター状態を推測しない。取得不能は `unknown`。
- プリンターへ送信開始後に結果不明となったjobは自動再送せず、人間が紙面を確認して再印刷する。
- 内部IDはUUIDv7。
- 確定済み取引、在庫移動、監査記録は上書き・削除せず、訂正イベントを追記する。

詳細は `docs/design/01_architecture.md` から `10_adr-linux-production-host-2026-08-02.md` を参照する。

## 4. 受付番号

取引伝票番号と取り置き番号は共通の受付番号へ統合する。

```text
S NNNNNN C
│ │      └ Damm方式の検査数字
│ └ business day内で取引・取り置き共通の6桁連番
└ event内の営業セッション番号1桁
```

- 通常表示: `SNNN-NNNC`
- 完全表記: `YY-MMDD-SNNN-NNNC`
- ハイフンを除いた8桁でも入力できる。
- 通常は最初の営業セッションなので先頭は `1`。
- 真の新規開局では `S` を進め、連番を `000001`へ戻す。
- 同日の2回目の新規開局も別営業セッションとする。
- 締め取消・再開では `S` を進めず、同じセッションの続番を使う。
- `S=1..9`、連番=`000001..999999`。上限で循環させない。
- 取引と取り置きは同じcounterを使う。
- 取消後も番号を再利用しない。

## 5. バーコード名前空間

- EAN、UPC、ISBN、ISDN、インストアコードを商品コードとして利用できるよう、数字だけのシステム予約領域を作らない。
- ISDNで使われる278、279、292をPOS内部用途へ予約しない。
- システム用バーコードは非GS1 Code 128。
- magicは `PS`、続く数字でversion/typeを表す。
- `PS11`: 取引
- `PS12`: 取り置き
- `PS13`: POS発行の商品ラベル
- 完全な128bit UUIDの10進表現は最大39桁となり、58mm紙のCode 128には長すぎるため採用しない。
- DBの正本はUUIDv7、バーコードはDB一意制約を持つscanner専用alternate tokenとする。
- Code 128のmodule幅、quiet zone、100回連続読取りは本番候補Linux、TM-T70II、使用予定scannerで確定する。

## 6. 主な業務判断

- 商品コード、価格、税、原価、sale state、在庫はevent別にできる。
- 顧客表示・レジ表示の頒布価格は税込。
- 税額丸めは税率別にレシート1枚につき1回。初期値は購入者に有利な切捨て。
- 率値引きの初期上限は100%。任意値引きの承認・理由入力は当面実装しない。
- 無料配布の理由入力は当面実装しない。
- 特定会計ソフトには依存せず、正本からcanonical CSV bundleを随時再生成できるようにする。
- 部分返品は実装しない。全部返品後、返品しない商品を新規取引として再登録する。
- レシートなし返品は商品コードから登録できる。
- 見本在庫という区分は作らず、販売可能在庫と同様に扱う。
- R18確認の初期policyは容貌確認。容貌確認または身分証目視の方法だけを保存し、身分証個別情報は保存しない。
- レシートの担当者表記は、責任者番号または登録表示名。表示名はペンネーム・ハンドルネームを許可する。
- 現金箱モードは営業中に変更せず、次営業から適用する。
- 販売可能数量を超える取り置きを警告付きで許可する。
- 無料配布時の顧客画面は可能なら金額が0へ切り替わる演出を行う。難しければ会計待ち表示を継続できる。
- 保持期限後の削除・匿名化は保守手順で扱い、アプリから自動削除しない。
- 本番会場LANはローカルCAによるHTTPSを原則とする。

## 7. プリンター方針

- 本番プリンターホスト: 即売会へ持ち込む64bit Linux機
- 候補: Debian/Ubuntu x86_64・ARM64、Raspberry Pi OS 64bit
- 現在TM-T70IIはDiscord botのDebian環境へUSB接続されており、ここからPOS用probeを開始できる。
- `/dev/usb/lp*`直接送信と、必要な双方向status方式を比較する。
- 同一fixtureのESC/POS bytes、SHA-256、紙面、USB・udev・systemd設定、障害時ログを保存する。
- 送信、排他、紙切れ、カバー開、USB切断、再接続、部分カットをLinuxで測定する。
- Linuxでの実測が終わるまでADR-P001/P002をAcceptedにしない。
- Raspberry Pi採用時はmicroSD単独を正本DB保存先にせず、USB SSD等を使用する。
- キャッシュドロアーは型番・pin・pulse・連続駆動制限が判明するまで実機駆動しない。

比較資料は `docs/printer-baseline/`、probeは `tools/hardware-test/`、Linux導入手順は `deploy/linux/` に置く。

## 8. 別PCでの再開手順

1. Codexをインストールし、現在と同じChatGPT/GitHubアカウントで認証する。
2. GitHub CLIを導入し、private repositoryを読めるアカウントでログインする。
3. リポジトリをcloneする。

```powershell
New-Item -ItemType Directory -Path C:\private -Force
git clone https://github.com/Usuiensan/event-pos.git C:\private\event-pos
Set-Location C:\private\event-pos
git status
```

4. Codexで `C:\private\event-pos` を開く。
5. `AGENTS.md`、この文書、`docs/design/README.md`を読ませる。
6. `docs/CODEX_CONTINUATION_PROMPT.md`の文面で新しいタスクを開始する。
7. 既存DebianでDiscord bot serviceを停止し、USB使用中でないことを確認する。
8. Linuxのdistribution、CPU、driver、USB device、udev、systemd情報を記録してからPOS用probeを開始する。

## 9. 移行してはいけないもの

次のものはGitへcommitしない。

- `%USERPROFILE%\.codex\auth.json`
- GitHub、Discord、OpenAI等のtoken
- `.env`
- Codexの生のsession transcript
- 個人情報を含むログ
- 身分証情報
- 本番DBと暗号鍵

Codexの`config.toml`、個人用skills、MCP設定が必要な場合も、秘密情報を除外して個別に再設定する。

## 10. 2026-08-02 実装状況

作業branchは `codex/durable-sale-finalization`。会計確定の実装commitは次のとおり。

- `46bcaf3 商品マスタに税区分を追加して明細表示する`
- `96aa216 会計金額をサーバー規則で再計算する`
- `1bcbaaa 会計ドラフトと冪等な確定処理を永続化する`
- `feb9b2e レジ画面を永続会計APIへ接続する`
- `9f98af9 値引き併用と解除の境界処理を正す`
- `d96360c 印刷送信失敗時の会計保持を検証する`

実装済み:

- 商品masterの税込10%、税込8%、税抜10%、税抜8%、免税、非課税と、過去catalogの互換読込
- SQLite migration、event別商品正規化、版付きsale draft、明細、セット、取消状態、支払、R18確認
- server側の自動・任意値引き、税率別1回切捨て、無配0円、現金不足・釣銭10,000円以上の拒否
- UUIDv7内部IDとDamm検査数字付き受付番号
- 冪等な会計確定transaction。取引snapshot、在庫、現金、監査、初回print job/operationを同時commit
- commit後の印刷送信。失敗時も売上を戻さずprint jobを`failed`にする
- 現金、クレジット、売掛、無配、預り・釣銭、R18容貌確認・身分証目視
- スタッフ画面と顧客画面のREST接続。BroadcastChannel/localStorageは更新通知だけに使い、表示内容はDB投影から再取得
- SQLite再open後の完了取引、draft、顧客表示復元

確認済み:

- `pnpm check`: 型検査、80件の自動試験、全workspace build成功
- 実ブラウザー: 商品追加、顧客同期、現金会計、預り・釣銭、再読込後の会計済復元
- Docker: `docker compose up -d --build --wait`成功。`event-pos-pos-1`は3000番で`running/healthy`、DB readinessは`ok`
- 隔離Docker環境: catalog登録から会計確定、取引snapshot、顧客表示投影まで成功

詳細な受入対応は `docs/design/07_traceability-review.md` 8章を参照する。

## 11. 次の作業

最新要件は `docs/requirements/即売会向けPOSレジ_要件定義_v0.6.md`。v0.5以前は履歴として保持する。

1. 返品、取り置き、締め、CSV、backup/restoreなど、今回の会計確定範囲外を各Goalで実装する。
2. 60会計/分を15分継続する900件負荷と10端末試験をGoal 9で実施する。
3. 既存DebianとTM-T70IIでPOS用printer probeを実行し、紙面、cut、status、USB切断・再接続、udev/systemdを証拠化する。
4. 本番候補Linuxの永続diskとbackup/restoreを確定し、P001/P002/P006を判断する。
5. AC-18を含むA+R項目の視認性と、46件の総合受入を人間レビュー込みで完了する。

