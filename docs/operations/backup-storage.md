# 本番バックアップ保存先

本番起動では `NODE_ENV=production` と、絶対パスの `POS_ARTIFACT_ROOT` を必ず設定する。DBファイル自身、ドライブまたはfilesystemのroot、相対パスは拒否される。`POS_ARTIFACT_MIN_FREE_BYTES` は既定 `2147483648`（2 GiB）で、下回ると点検・精算は確定済みのまま成果物だけ `STORAGE_LOW` になる。

推奨例は、DBが `D:\event-pos\data\event-pos.sqlite` の場合に成果物を別diskの `E:\event-pos-artifacts`、LinuxではDBを `/var/lib/event-pos/event-pos.sqlite`、成果物を `/srv/event-pos-artifacts` とする構成である。同じdiskしかない場合も専用directoryを指定し、ダッシュボードで空き容量を確認する。

Windowsはサービスアカウントだけに変更権限を与え、設定後に `icacls E:\event-pos-artifacts` の結果を導入記録へ保存する。Linuxは `install -d -m 0700 -o event-pos -g event-pos /srv/event-pos-artifacts` を実行し、`stat -c '%U %G %a %n' /srv/event-pos-artifacts` の結果を保存する。アプリは作成物をdirectory `0700`、file `0600`で要求するが、Windows ACLの成功はアプリ側で推測しない。

日計後は業務メニューで成果物ID、SQLite・xlsx・manifestの3 hashと保存先を確認する。manifestと実ファイルのhashを照合し、SQLite backupを別パスへコピーして `PRAGMA integrity_check` と主要件数・金額を照合する。保持期限による削除は自動化せず、責任者承認後に実施する。
