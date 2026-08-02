# ADR-P010 Windows/Linuxプリンターホスト同格対応

- 状態: `Accepted`
- 決定日: 2026-08-02
- Supersedes: ADR-P007 `10_adr-linux-production-host-2026-08-02.md`

## 決定

Windows x64と64bit Linuxを、TM-T70IIプリンターホストの同格な本番対応プロファイルとする。個別eventではADR-P006により一方の機材を選択できるが、もう一方を開発専用・暫定・機能縮小版にはしない。

両OSは同じ不変print job、canonical IR、ESC/POS bytes、hash、FIFO、attempt、delivery certainty、再印刷契約を使用する。OS差は`PrinterTransport`、状態取得adapter、service管理、導入・復旧成果物に閉じ込める。

## 必須能力

WindowsとLinuxの双方で次を完了する。

- TM-T70IIへの全bytes送信とacceptedBytes/hash照合
- 日本語、U+00A5、画像、QR、バーコード、feed、部分カットの同一紙面
- printer単位の排他と4レジFIFO
- 紙切れ、カバー開、offline、USB切断または`unknown`の正確な表現
- 送信途中停止、process/OS再起動、USB再接続、明示再印刷
- 同一jobIdの二重dispatch防止
- 専用service account、無人起動、更新、ログ、復旧runbook

WindowsはRAW spooler、EPSON driver/API、OPOS等を実測してADR-P001/P002で採用方式と能力を決める。Linuxは`/dev/usb/lp*`、libusb等を同様に実測する。方式は同一でなくてよいが、利用者から見た必須機能、状態の意味、紙面および復旧結果は同じにする。

## 完了判定

自動試験だけ、片方のOSだけ、またはOSへの全bytes受理だけでは完了としない。Windows x64、Linux x86_64および対象とするARM64について、自動試験、実機試験、紙面・運用の人間レビューを保存する。

取得不能な状態は正常と推測せず、OS・接続方式ごとに`unsupported`または`unknown`とする。状態取得能力に差が残る場合は、その差をUIとrunbookへ明示し、必要な代替確認手順まで受入する。

## P006との関係

ADR-P006は個別eventへ持ち込むサーバー、storage、router、UPS、予備機および復旧目標を決める。P006でWindowsまたはLinuxを選んでも、ADR-P010の両OSサポート要件は失効しない。
