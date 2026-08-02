# BC-415M-B(6C) drawer pulse — Windows x64

- 実行日: 2026-08-03 JST
- PrinterHost: `windows-spooler` / `EPSON TM-T70II Receipt`
- 接続前提: BC-415M-B(6C) の6ピンモジュラーケーブルをTM-T70IIのDKコネクターへ接続
- command: `ESC p 0 2 20` (`1b 70 00 02 14`)
- 対象pin: 2（TM-T70IIの既定drawer output）
- ON/OFF: 4 ms / 40 ms
- payload SHA-256: `dd99377f56cea3fca547e0df16d32c23d79eec311071cb670abc8a7f5c11c1de`
- Host結果: `acceptedBytes=5`、`payloadLength=5`、`completionEvidence=transport_accepted`
- normalized status: reachable/online=`supported:true`、cover/paper/error=`unknown`
- 物理開放: **未判定。現物の開放確認を担当者が追記するまで成功と扱わない。**

Windows RAW spoolerはドロアー開放センサーを取得しない。transport受理はプリンターへの投入証拠であり、ドロアーが開いた証拠ではない。
