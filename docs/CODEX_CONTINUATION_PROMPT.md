# 別PCでCodexを再開するためのプロンプト

以下を新しいCodexタスクの最初に貼り付ける。

```text
C:\private\event-pos の開発を引き継いでください。

最初に、次の文書を完全に読んでください。
- AGENTS.md
- README.md
- docs/HANDOFF.md
- docs/design/README.md
- docs/design/05_pending-adrs.md
- docs/design/06_phase-goals.md
- docs/design/09_barcode-namespace-proposal.md
- docs/design/15_adr-windows-linux-printer-parity-2026-08-02.md

このリポジトリは、C:\private\discord-printer-bot から分離した即売会向けPOSです。
Discord botを実行時依存にしないでください。

Windows x64と64bit Linuxは同格の本番対応プロファイルです。片方だけのUSB送信、状態取得、障害復旧、紙面確認でプリンター対応を完了扱いにしないでください。
TM-T70IIは現在Debian上のDiscord botにつながっているため、POS用実機試験ではDiscord bot service停止とUSB排他を確認し、このDebian紙面をWindows/Linux共通fixtureの比較基準にしてください。

次の作業がGoal 6なら`docs/GOAL6_PRINTER_PARITY_PROMPT.md`を実行条件の正本にしてください。

まずgit status、現在のbranch、直近commit、未確定ADRを確認し、docs/HANDOFF.mdの「次の作業」と現状との差分を報告してください。
ユーザーの既存変更を保持し、force-pushは本当に必要か再考してください。
```
