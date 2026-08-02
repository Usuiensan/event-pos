# 即売会向けPOSレジ 実装設計 v0.6

## 位置づけ

本設計は `即売会向けPOSレジ_要件定義_v0.6.md` を実装へ引き渡せる粒度に具体化する。現在のv0.6はADR-P010に従い、Windows/Linux双方を同格の本番対応プロファイルとする。v0.5以前は履歴として保持する。

未確定の業務判断、USBライブラリー、プリンター状態、キャッシュドロアー実機挙動は推測しない。該当箇所は `05_pending-adrs.md` の決定ゲートを通過するまで実装または本番受入を完了扱いにしない。

## 成果物

| 文書 | 内容 |
| --- | --- |
| `01_architecture.md` | 技術スタック、構成、ディレクトリ、実行・障害境界 |
| `02_data-and-api.md` | DBモデル、制約、トランザクション、REST/WebSocket API |
| `03_printing.md` | テンプレート、中間表現、印刷キュー、OS固有層 |
| `04_test-strategy-and-acceptance.md` | テスト戦略、18章全受入条件の分類 |
| `05_pending-adrs.md` | 決定待ちADRと決定期限・必要証拠 |
| `06_phase-goals.md` | 実装フェーズ別のGoalモード投入文 |
| `07_traceability-review.md` | 要件追跡、相互レビュー結果、完了監査 |
| `08_adr-decisions-2026-07-24.md` | 利用者判断、AI推奨案、要件v0.5との差分、会計CSV調査 |
| `09_barcode-namespace-proposal.md` | 伝票・取り置き・商品コードのバーコード名前空間案 |
| `10_adr-linux-production-host-2026-08-02.md` | Linuxだけを初期本番対象としたSuperseded ADR |
| `11_adr-print-host-process-boundary-2026-08-02.md` | POS本体とプリンターホストの責務・通信境界ADR |
| `12_adr-disaster-print-integration-2026-08-02.md` | kishou_server/Discord防災通知とPOS printer-host共用印刷ADR |
| `13_windows-surface-temporary-deployment-2026-08-02.md` | Surface上のDocker POSとWindows printer-hostの配備プロファイル |
| `14_deferred-goals.md` | 後続Goalへ分離した在庫・印刷・OS・バックアップ・総合受入項目 |
| `15_adr-windows-linux-printer-parity-2026-08-02.md` | Windows/Linuxを同格の本番対応とするADR-P010 |
| `17_goal8-backup-excel.md` | 中間計・精算時のSQLite snapshot、単一Excel帳票、manifest、再生成設計 |

## 固定した技術方針

- 単一POSサーバー・単一DBを基本とし、プリンターホストは別プロセス（同一機への同居可）として分離する。
- 金額はすべて整数円、商品コードは文字列、時刻はUTCで保存する。
- 会計確定と印刷完了を分離し、会計確定と印刷ジョブ登録は同じDBトランザクションに含める。
- 確定済み取引、在庫移動、監査記録は上書き・削除せず、取消・訂正を追加記録する。
- プリンター状態を推測せず、取得不能は `unknown` としてAPIと画面へ返す。
- 実機へ送信開始後にプロセスが落ちたジョブは自動再送しない。二重印刷防止を優先し、人間が紙面確認後に明示的に再印刷する。
- Windows x64と64bit Linuxを同格の本番対応とし、OS・CPU差は`PrinterTransport`、service管理、配布成果物に閉じ込める。

## 実装開始ゲート

フェーズ1は未確定ADRを保留したまま開始できる。本番OS対応方針はADR-P010 `15_adr-windows-linux-printer-parity-2026-08-02.md`を正とする。次の機能は対応ADRが決まるまで開始しない。

- OS実機USB送信: ADR-P001
- 実機状態表示: ADR-P002
- キャッシュドロアー駆動: ADR-P003
- 本番設置・障害訓練: ADR-P006
