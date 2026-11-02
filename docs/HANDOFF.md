# ぽすりん 引継ぎ

このリポジトリを別環境や別のCodexセッションで扱うときは、過去の会話や削除済み設計文書ではなく、現在のコードと次の文書から開始します。

1. `AGENTS.md`
2. `docs/CURRENT_SPEC.md`
3. `docs/PRODUCTION_MINIMUM.md`
4. 必要に応じて `docs/operations/取扱説明書.md`
5. 設定変更なら `docs/event-config-yaml.md`

## 製品

同人誌・グッズ等の即売会向けWeb POSです。POS server、SQLite、ブラウザーレジ、顧客画面、管理画面、必要に応じてEPSON TM-T70II PrinterHostで構成します。

## 作業時の原則

- 現行コードとテストを仕様判断の第一資料にする。
- 過去のGoal、ADR、受入台帳をGit履歴から見つけても、自動的に未完了要件として復活させない。
- ユーザーが要求していないOS同格化、固定負荷値、テスト方式等を追加しない。
- 二重会計防止、transaction整合性、印刷結果不明時の扱い等、データ保全上の既存挙動は壊さない。
- UIは `docs/UI_POLICY.md` に従い、明示依頼なしに大幅変更しない。

## 開発コマンド

```powershell
pnpm install
pnpm check
pnpm --filter @event-pos/server dev
pnpm --filter @event-pos/register-web dev
```

## 主な場所

```text
apps/server/          POS API、SQLite、会計、営業、返品、印刷キュー、backup
apps/register-web/    レジ・顧客・管理画面
apps/printer-host/    TM-T70II PrinterHost
packages/             共通contract、計算、receipt/ESC-POS等
event-config/         分割YAMLイベント設定
docs/operations/      当日運用・保存先・HTTPSの実装別手順
docs/printer-baseline/ 実機証跡。要件ではない
docs/意匠チェック/    UI意匠確認資料
```

## Gitへ入れないもの

- `.env`
- token、PIN、秘密鍵
- Codex等の認証情報
- 本番DB
- 身分証情報
- 個人情報を含むログ

実装状況は固定の日付やGoal番号ではなく、現在の`main`とテスト結果から確認します。
