# Goal 7 PrinterHost 統合差分と契約

## 実装前との差分

Goal 6時点で、`print_jobs`、`printer_operations`、`print_attempts`、POS内の`PersistentPrintQueue`、`HttpPrinterHostClient`、Windows RAW spooler probe、Linux RAW USB probeは存在した。一方で、PrinterHostの状態は単純な`ready/paper_out/offline/unknown`で、HTTP成功結果にadapter証跡・正規化statusがなく、POSの`GET /printer/status`も常にunknownだった。

Goal 7ではPOSをキュー状態の唯一の正本に固定し、PrinterHost HTTPの`POST /api/v1/print-jobs`結果へ`jobId`、payload length/hash、`acceptedBytes`、`transportEvidence`、`statusObservation`、completion evidenceを含める。`jobId`再送はHostプロセス存続中に同じ結果または失敗を返し二重送信しない。同じ`jobId`で`bytesSha256`、payload length、document typeまたはprinterが異なる要求は`JOB_ID_PAYLOAD_MISMATCH`として拒否する。HostはPOSの状態を非同期更新せず、証跡はこの応答を受けたPOS queueだけが保存する。Host再起動またはHTTP timeoutで結果を照会できない場合はPOSが`unknown`として隔離し、自動再送しない。

`GET /api/v1/printer/status`はHostの能力付きobservationを返す。`reachable`、`online`、cover、paper、errorはそれぞれ`supported`、`unsupported`、`unknown`で表現し、未取得値を正常へ変換しない。POSの同名APIはPrinterHost設定時にこの値を中継し、未設定・到達不能時もunknownを返す。

## 永続FIFOと失敗規則

POSは`printer_operations`の最小sequenceだけを処理する。attemptは`prepared`、`dispatch_started`、`transport_accepted`、`postcheck_completed`を別commitし、compiler/adapter/write hash、accepted bytes、transport evidence、status observationを保存する。`acceptedBytes === payloadLength`とhash一致は送信完了であり紙面完了ではない。

0 bytes未送信をtransport証跡で証明した一時失敗だけを2/5/15秒、合計4 attemptまで再試行する。short write、timeout、Host到達不能、送信後終了は`failed/unknown`で止め、責任者が紙面を確認して再印刷を作成する。device faultは再試行回数で解除せず先頭jobをblockし、責任者resumeまで後続を追い越させない。再印刷は既存の取引・在庫・支払・現金台帳を変更しない。

## OS別導入と復旧

Linux x86_64は`deploy/linux/99-event-pos-printer.rules`を実機のvendor/productで確定し、安定名を`PRINTER_DEVICE`へ設定する。serviceは`event-pos`/`lp`で`event-pos-printer-host.service`をenableし、`journalctl -u event-pos-printer-host`、`GET /health/live`、`GET /api/v1/printer/status`で確認する。USB抜去後は安定名、group、serviceログを確認してから責任者resumeを行う。

Windows x64は専用service accountでPrinterHostを無人起動し、`PRINTER_BACKEND=windows-spooler`、`PRINTER_NAME`を設定する。RAW spoolerは到達可能性以外のcover/paper/errorを保証しないため、OPOS等で能力が確定するまでそれらをunknownとして表示する。再起動後はserviceログ、PrinterHost health/status、Windows printer queueとPnP、テストjobのhashを順に確認する。

drawerはADR-P003がAcceptedになるまでPrinterHost API・template・実機のいずれからも駆動しない。

## BC-415M-B(6C) のP003実装候補（2026-08-03）

ビジコムBC-415M-B(6C)は6ピンモジュラー式で、TMシリーズのDKコネクター経由で制御する。TM-T70IIの既定2番pinに対し、EPSONの`ESC p 0 2 20`例（ON 4 ms、OFF 40 ms）だけを許可する。任意のpin/pulseは受け付けない。責任者の「替」操作と現金会計時の操作は同じFIFO queueにdrawer operationとして入り、現金会計ではdrawerがreceiptより先行する。再印刷はdrawer operationを生成しない。

Windows RAW spoolerで`acceptedBytes=5`を取得しただけでは物理開放を証明しない。担当者による一回の物理開放、連続駆動制限、Linuxでも同じ実証を保存するまでADR-P003はPendingのままとする。

## 実機証跡の扱い

既存のWindows x64/Linux x86_64 probeと紙面証跡は`docs/printer-baseline/acceptance-status.md`およびOS別manifestを正本とする。Goal 7のPOS queue/API/UIを介した4レジFIFO、同一jobId、USB切断、Host/OS再起動、再印刷は未取得であり、実機成功とは主張しない。各runではjob/attempt ID、IR/bytes hash、Host結果、POS attempt、raw/normalized status、service log、紙面判定を同ディレクトリへ追加する。
