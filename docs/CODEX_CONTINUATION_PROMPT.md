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

このリポジトリは、C:\private\discord-printer-bot から分離した即売会向けPOSです。
Discord botを実行時依存にしないでください。

本番プリンターホストは、このWindowsノートPCです。
TM-T70IIは通常Debian上のDiscord botにつながっているため、Windows実機試験ではサービス停止とUSBつなぎ替えを明示的に確認してください。

まずgit status、現在のbranch、直近commit、未確定ADRを確認し、docs/HANDOFF.mdの「次の作業」と現状との差分を報告してください。
ユーザーの既存変更を保持し、force-pushは本当に必要か再考してください。
```

