# Windows x64 PrinterHost本番起動

`PrinterHost` はPOS serverとは別processで動かす。`pnpm build` はbundleを作らず、PrinterHostとworkspace packageをそれぞれ`dist`へ出力する。本番Nodeはworkspace packageの`default` exportとして`dist/index.js`を読む。repository、production dependencies、各`dist`、`apps/printer-host/scripts`を同じreleaseとして配置し、一部だけを差し替えない。

## portable起動

1. Node.js 24 x64、pnpm 11を導入し、repository rootで`pnpm install --frozen-lockfile`、`pnpm check`を実行する。
2. production dependencyだけを含むportable directoryを、まだ存在しない出力先へ作成する。

```powershell
.\deploy\windows\build-portable.ps1 -OutputDirectory C:\event-pos\releases\printer-host-<commit>
```

3. 出力先の`printer-host.env.example`を`printer-host.env`へ複製し、`NODE_EXE`と`PRINTER_NAME`を実機に合わせる。`printer-host.env`はGitへ追加しない。
4. POS server側へ`PRINTER_HOST_URL=http://127.0.0.1:4318`を設定する。ドロアー未受入中は`DRAWER_ENABLED=false`のままにする。
5. 出力先から次を実行する。repository checkoutからの保守起動にも同じlauncherを使用できる。

```powershell
.\start-printer-host.ps1
```

別terminalで`Invoke-RestMethod http://127.0.0.1:4318/health/live`と`Invoke-RestMethod http://127.0.0.1:4318/api/v1/printer/status`を確認する。statusが`unknown`またはofflineなら印刷を開始しない。

## Windows Service

WinSW 3 x64の実行ファイルを`deploy\windows\event-pos-printer-host.exe`として配置する。隣接するXML、PowerShell、`printer-host.env`を使用するため、ファイル名を変えない。管理者PowerShellで次を実行する。

```powershell
Set-Location C:\private\event-pos\deploy\windows
.\event-pos-printer-host.exe install
.\event-pos-printer-host.exe start
.\event-pos-printer-host.exe status
```

サービスの「ログオン」タブで専用のローカルサービスアカウントを設定し、repositoryの読取り、プリンター利用、`deploy\windows\logs`への書込みだけを許可する。対話ユーザーや管理者アカウントでの常用はしない。資格情報をXML、env、コマンド履歴へ保存しない。

停止・再起動・ログ確認は次のとおり。

```powershell
.\event-pos-printer-host.exe stop
.\event-pos-printer-host.exe restart
Get-Content .\logs\event-pos-printer-host.out.log -Tail 100
Get-Content .\logs\event-pos-printer-host.err.log -Tail 100
```

ログの`transport_accepted`はOS/spoolerによる全bytes受理であり、紙面完了ではない。`jobId`、`bytesSha256`、`acceptedBytes`、`spoolerJobId`をPOS DBのattemptと照合し、紙面結果は別の受入記録へ保存する。

更新時はserviceを停止し、DB backup後に新releaseで`pnpm install --frozen-lockfile`と`pnpm check`を通してから起動する。停止中または応答消失時に`dispatch_started`だったjobは自動再送せず、POS上の`unknown`と紙面を確認して明示再印刷する。
