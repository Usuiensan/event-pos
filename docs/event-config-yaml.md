# 分割イベント設定

`event-config/<イベント名>/` は、人が編集するイベント設定の正本です。生成した `EventCatalog` JSON はAPI・SQLiteへ渡すための成果物であり、直接編集しません。

```text
event.yaml              イベント、販売者、ロケール
departments.yaml        POS部門と精算帰属先
staff.yaml              担当者・責任者番号・権限（PINや秘密情報は含めない）
products/*.yaml         部門別の商品
register-ui.yaml        タブ、クイック登録、顧客待機画面
discounts.yaml          自動値引き
receipt-settings.yaml   帳票種別と有効テンプレート版・共通文言
assets/                 顧客画面用の非秘密アセット
```

最小の動作例は [event-config/demo](../event-config/demo) です。商品・担当者・UI・値引き・帳票を別ファイルにしたため、Git差分から変更理由を判断できます。

## 検証と生成

```powershell
pnpm catalog validate .\event-config\demo
pnpm catalog build .\event-config\demo --out .\dist\event-catalog.json
```

`validate` はschema version、未知field、商品・部門・担当者の重複、部門・タブ・商品参照、無効商品のUI/値引き参照、金額・数量、年齢区分、assets、指定した帳票templateパスを検査します。エラーは設定ファイルと設定パスを示します。同じ入力は常に同じJSONを生成します。

## 開局前の再読み込み

POSサーバーを起動する環境で `POS_EVENT_CONFIG_DIR` に対象ディレクトリを指定します。管理者は次のAPIでYAMLを再検証してSQLiteの統合カタログを更新できます。

```powershell
Invoke-RestMethod -Method Post `
  -Uri "https://pos.example/api/v1/events/demo-event-large/catalog/reload"
```

営業セッションが開局済みの場合は `409 business_already_open` で拒否されます。再読み込み後に商品、担当者、値引き、顧客画面を確認してから開局してください。

## 旧JSONとの移行

既存のJSONインポート/API更新は互換性のため当面維持します。新規・更新の設定は分割YAMLを編集し、`validate` と `build` の後に再読み込みまたは既存JSON更新APIへ投入してください。CSVは将来の商品基本情報だけの入力として追加可能ですが、値引きとクイック登録はYAMLに残します。

設定にはPIN、アクセストークン、実売上、顧客情報、SQLite DBを含めず、Gitへcommitしないでください。YAML、非秘密の画像、帳票テンプレートはレビュー済みであればcommitできます。
