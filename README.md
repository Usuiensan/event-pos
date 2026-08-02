# event-pos

同人誌即売会向けの、複数端末対応POSレジシステム。

## 現在の段階

要件・設計をLinux本番運用へ更新し、既存Debian環境とTM-T70IIを使った実機検証および実装を開始する段階。

- 本番サーバー兼プリンターホスト: Debian、Ubuntu、Raspberry Pi OS等の64bit Linux
- レシートプリンター: EPSON TM-T70II
- 初期実機基準: `discord-printer-bot` が稼働する既存Debian環境
- 開発・管理端末: Windows PCを継続利用可能
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
tools/hardware-test/     Linux/TM-T70II実機検証ツール
deploy/linux/            systemd、udev、導入・更新・復旧手順
.github/workflows/       Linux CI（型チェック、テスト、build）
```

## リポジトリ境界

このリポジトリは `discord-printer-bot` から独立させる。

再利用するESC/POS生成、文字・画像ラスタ、Linux USB送信、カット処理、golden testは、移植元commitとファイルを記録したうえでこのリポジトリへ移植する。Discord連携、AI機能、Discord設定には依存しない。既存Debianのsystemd・udev・USB運用知見はPOS用に再設計して取り込む。

## 開発コマンド

Node.js 24以上とpnpm 11を使用する。SQLiteはNode.jsの`node:sqlite`を使うため、Windows開発環境とLinux CIで同じ実行条件にする。

```powershell
pnpm install
pnpm check
pnpm --filter @event-pos/server dev
pnpm --filter @event-pos/register-web dev
```

`pnpm check`は全workspaceの型チェック、テスト、buildを実行する。React画面の実テストはUI実装タスクで追加する。

## 商品JSONの責任者設定

商品JSONには責任者番号とレジ表示名の対応を`staffMembers`で設定できる。責任者番号は先頭ゼロを含む3桁文字列で、イベント内で重複できない。表示名にはペンネームやハンドルネームを使用できる。

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

店員側画面は、`staffMembers`に存在しない番号、空欄、3桁でない番号でのサインオンを拒否する。

## 次の作業

1. 既存Debian環境のプリンター出力、ESC/POS bytes、USB・systemd・udev設定を保存する。
2. `/dev/usb/lp*`方式と必要な双方向status方式を、同じLinuxホスト上で比較する。
3. USB切断、再接続、紙切れ、カバー開、排他、部分カットを測定する。
4. ADR-P001/P002を確定してLinux PrinterTransportを実装する。
5. x86_64 LinuxとARM64候補で自動試験・負荷試験を行い、ADR-P006で本番機を確定する。
