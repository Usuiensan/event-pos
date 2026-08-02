# 14. 後続Goalへ回す項目

更新日: 2026-08-02

この文書は、レジ・顧客画面・R18のUI改善Goalから意図的に分離した項目を記録する。ここに記載した項目は、現在のGoal 4の完了条件へ含めない。

## 推奨実施順

1. Goal 3: 会計・在庫・現金・冪等finalizeの完成
2. Goal 4: 音声、顧客画面同期、R18スキップ、会計済み操作ロック
3. Goal 5: 永続印刷キューと複数プリンター対応
4. Goal 6/7: Linux・Windows PrinterHostと実機検証
5. Goal 8: バックアップ、XLSX/CSV export、Docker運用スクリプト
6. Goal 9: 総合受入

## Goal 3へ回す項目

- 会計確定API、永続draft、サーバー側金額再計算
- 会計確定と同一SQLite transactionでの在庫movement・inventory balance更新
- 現金台帳、支払、監査、初回print jobの原子確定
- Idempotency-Key、Enter連打、HTTP再送、途中失敗時の全rollback
- 最後の1点を複数レジが同時販売した場合の整合性

## Goal 5へ回す項目

- printerIdごとの印刷queue、FIFO、mutex、状態管理
- 複数プリンターへのjob routing
- 同一プリンター内のバイト列混在防止
- 印字受付番号による手動仕分け
- 初回印刷、再印刷、結果不明、手動再印刷の状態管理

## Goal 6/7へ回す項目

- Linux PrinterHost + systemd
- Windows PrinterHost + Windows Serviceまたはportable起動
- USB再接続、紙切れ、カバー、状態取得、送信結果不明
- Windows/Linux双方のTM-T70II実機試験
- Windows Firewall、再起動、スリープ、Windows Updateへの運用対応
- Linux本番とWindows本番の配備プロファイル比較

## Goal 8へ回す項目

- Docker Desktop + Docker Composeのinstall/start/stop/status/backup/restore/remove script
- 通常のremoveでDB volumeを削除しない運用
- SQLite整合スナップショット、integrity_check、foreign_key_check、SHA-256、manifest
- 中間計・日計commit後の自動バックアップjob
- `database.sqlite`、`event-pos-export.xlsx`、`manifest.json` の自動bundle
- SQLite snapshotからの人間向けXLSX生成
- canonical CSVの管理画面/CLIからの任意export
- CSV/XLSXの行数、合計、受付番号、内部IDの照合
- XLSX生成失敗時の再試行とSQLite backup保持
- backup restoreの自動試験

## Goal 9へ回す項目

- 60会計/分、10端末、複数プリンターの総合負荷
- Windows/Linux両配備プロファイルの総合試験
- Wi-Fi低帯域、遅延、短時間切断、再起動、復元の総合試験
- 実機プリンター、紙面、カット、運用手順の人間レビュー
- 未完了の実機/Human Reviewを含む最終受入判定

## 完了扱いの注意

- 後続項目を設計文書へ記録しただけでは実装済みとしない。
- 自動試験だけで実機プリンターや人間レビューを完了扱いにしない。
- Windows/Linuxのどちらを採用する場合でも、POS Server、SQLite、REST/API、印刷jobの正本は共通化する。
