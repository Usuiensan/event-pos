# Windows OPOS API probe の互換性・名前解決証跡

同じ状態を成功と推測しないため、2026-08-03の探索結果も保存する。

| 証跡dir | 実行環境/指定 | 結果 | 解釈 |
| --- | --- | --- | --- |
| `20260803-opos-normal` | PowerShell 7, `M-T70II` | Explorer初期化失敗 | 送信前に停止 |
| `20260803-opos-unelevated` | PowerShell 7, `M-T70II` | `AppDomainSetup.set_ApplicationBase` missing | EPSON OPOS .NET 1.14はPowerShell 7非互換 |
| `20260803-opos-normal-windows-powershell-v2` | Windows PowerShell 5.1 x64, `M-T70II` | logical device not found | SetupPOSの表示名はPosExplorer指定名ではない |
| `20260803-opos-normal-windows-powershell-x86` | Windows PowerShell 5.1 x86, `M-T70II` | logical device not found | x86化だけでは解決しない |
| `20260803-opos-tm-t70ii-normal` | Windows PowerShell 5.1 x64, `TM-T70II` | Open/Claim/Release/Close成功、sensor値はnull | `DeviceEnabled=false`では状態値を取得できない |
| `20260803-opos-enabled-normal` | Windows PowerShell 5.1 x64, `TM-T70II`, `-EnableDevice` | Open 130ms、Claim 208ms、sensor/error値取得、disable/release/close成功 | 採用する実測手順 |

OPOS API probeは印刷しない。例外・短縮・状態不明時の自動再送はない。
