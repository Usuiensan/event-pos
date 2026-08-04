# event-pos

同人誌即売会向け複数端末POS。

## 現在の段階

Goal 5までの会計・レシート・永続印刷キュー実装済み。Windows/Linux双方のTM-T70II実機検証とOS adapter実装へ進行中。

- 本番対応プリンターホスト: Windows x64、およびDebian・Ubuntu・Raspberry Pi OS等の64bit Linux
- レシートプリンター: EPSON TM-T70II
- 初期実機基準: `discord-printer-bot` が稼働する既存Debian環境
- OS受入方針: Windows/Linuxの両方で送信、状態取得、障害復旧、紙面を受入する
- 内部ID: UUIDv7
- 取引・取り置き共通受付番号: 営業セッション1桁＋連番6桁＋Damm検査数字
- 通常表示: `SNNN-NNNC`

## ディレクトリ

```text
docs/requirements/       元の要件定義
docs/design/             ADR、アーキテクチャ、データ、印刷、試験設計
docs/HANDOFF.md          別PCへ移るためのプロジェクト知識の正本
docs/CODEX_CONTINUATION_PROMPT.md  新しいCodexタスクの開始文
docs/printer-baseline/   Debian環境のbytes・設定・紙面比較資料
tools/hardware-test/     Windows/Linux/TM-T70II実機検証ツール
deploy/linux/            systemd、udev、導入・更新・復旧手順
deploy/surface/          Windows native printer-host、導入・更新・復旧手順
.github/workflows/       CI（型チェック、テスト、build）
```

## リポジトリ境界

このリポジトリは `discord-printer-bot` から独立させる。

ESC/POS生成、文字・画像ラスタ、Linux USB送信、カット、golden testは移植元commit・ファイルを記録して移植する。Discord連携、AI機能、Discord設定には依存しない。既存Debianのsystemd・udev・USB知見はPOS用に再設計する。

## 開発コマンド

Node.js 24以上、pnpm 11を使用。SQLiteはNode.jsの`node:sqlite`でWindows/Linuxの実行条件を統一する。

```powershell
pnpm install
pnpm check
pnpm --filter @event-pos/server dev
pnpm --filter @event-pos/register-web dev
```

`pnpm check`は全workspaceの型チェック、テスト、buildを実行。React画面の実テストはUI実装タスクで追加する。

## 商品JSONの責任者設定

商品JSONの`staffMembers`で責任者番号とレジ表示名を設定する。番号は先頭ゼロを含む重複不可の3桁文字列。表示名はペンネーム・ハンドルネーム可。

```json
{
  "eventId": "demo-event",
  "staffMembers": [
    { "responsibleNumber": "001", "displayName": "テスト管理者" },
    { "responsibleNumber": "002", "displayName": "売り子A" }
  ],
  "products": [],
  "quickEntries": []
}
```

店員画面は未登録番号、空欄、3桁以外の番号でのサインオンを拒否する。

### 顧客画面の登録待ち表示

未登録商品時の顧客画面は`customerWelcome`でサークル名、配置、案内文、画像を設定する。`message`は改行可。`imageUrl`はブラウザ参照可能なURLまたは配信パス。

```json
{
  "customerWelcome": {
    "circleName": "サークル名",
    "space": "東A-01a",
    "message": "いらっしゃいませ\n新刊を頒布しています",
    "imageUrl": "/welcome.png"
  }
}
```

各項目は省略可。`message`未設定時は「いらっしゃいませ」を表示する。

## 次の作業

1. 既存Debianの基準bytes・紙面・USB/systemd/udev証拠を保存する。
2. Windows x64ではRAW spoolerと必要なEPSON/OPOS状態取得、Linuxでは`/dev/usb/lp*`と必要な双方向方式を実測する。
3. 両OSでUSB切断、再接続、紙切れ、カバー開、排他、部分カット、service再起動を測定する。
4. ADR-P001/P002をOS別の能力表付きで確定し、Windows/Linux PrinterTransportを同じ契約へ実装する。
5. Windows x64、Linux x86_64/ARM64の全プロファイルで自動・実機・運用受入を完了する。
# event-pos

イベント設定は [分割イベント設定](docs/event-config-yaml.md) を参照してください。
