# 分割イベント設定

`event-config/<イベント名>/` は人が編集する設定の正本。生成した`EventCatalog` JSONはAPI・SQLite用成果物で、直接編集しない。

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

最小例は [event-config/demo](../event-config/demo)。商品・担当者・UI・値引き・帳票を分離し、Git差分から変更理由を判断できる。

## 検証と生成

```powershell
pnpm catalog validate .\event-config\demo
pnpm catalog build .\event-config\demo --out .\dist\event-catalog.json
```

`validate` はschema version、未知field、商品・部門・担当者の重複、各参照、金額・数量、年齢区分、assets、帳票templateパスを検査する。エラーは設定ファイルと設定パスを示し、同じ入力から同じJSONを生成する。

## 開局前の再読み込み

POSサーバー環境の`POS_EVENT_CONFIG_DIR`に対象ディレクトリを指定する。管理者は次のAPIでYAMLを再検証し、SQLite統合カタログを更新する。

```powershell
Invoke-RestMethod -Method Post `
  -Uri "https://pos.example/api/v1/events/demo-event-large/catalog/reload"
```

営業セッション開局済みなら`409 business_already_open`で拒否する。再読み込み後、商品、担当者、値引き、顧客画面を確認して開局する。

## 旧JSONとの移行

既存JSONインポート/API更新は互換性のため当面維持する。新規・更新は分割YAMLを編集し、`validate`・`build`後に再読み込みまたは既存JSON更新APIへ投入する。CSVは将来の商品基本情報入力として追加可能だが、値引きとクイック登録はYAMLに残す。

設定にPIN、アクセストークン、実売上、顧客情報、SQLite DBを含めず、Gitへcommitしない。YAML、非秘密画像、帳票テンプレートはレビュー済みならcommit可。
