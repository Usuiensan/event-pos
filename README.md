# event-pos

同人誌即売会向けの、複数端末対応POSレジシステム。

## 現在の段階

要件・設計を確定し、Windows PCとTM-T70IIを使った実機検証および実装を開始する段階。

- 本番サーバー兼プリンターホスト候補: Windows PC
- レシートプリンター: EPSON TM-T70II
- 既存比較環境: `discord-printer-bot` が稼働するDebian
- 内部ID: UUIDv7
- 取引・取り置き共通受付番号: 営業セッション1桁＋連番6桁＋Damm検査数字
- 通常表示: `SNNN-NNNC`

## ディレクトリ

```text
docs/requirements/       元の要件定義
docs/design/             ADR、アーキテクチャ、データ、印刷、試験設計
docs/printer-baseline/   Debian環境のbytes・設定・紙面比較資料
tools/hardware-test/     Windows/TM-T70II実機検証ツール
deploy/windows/          Windows導入・service・復旧手順
```

## リポジトリ境界

このリポジトリは `discord-printer-bot` から独立させる。

再利用するESC/POS生成、文字・画像ラスタ、カット処理、golden testは、移植元commitとファイルを記録したうえでこのリポジトリへ移植する。Discord連携、AI機能、Discord設定、Debian専用service構成には依存しない。

## 次の作業

1. Debian比較環境のプリンター出力とESC/POS bytesを保存する。
2. WindowsノートPCへcloneする。
3. TM-T70IIをWindowsへ接続し、Spooler RAWとEpson提供方式を比較する。
4. USB切断、再接続、紙切れ、カバー開、排他、部分カットを測定する。
5. ADR-P001/P002を確定してWindows PrinterTransportを実装する。
