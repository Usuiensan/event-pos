# レジ設定JSONの作り方

レジの商品・担当者・商品タブ・自動値引き・顧客画面を設定するJSONです。アプリでは「業務メニュー」→「商品JSONインポート」から読み込みます。インポートには `catalog_import` 権限が必要です。

## 最小構成

`eventId`、`products`、`quickEntries` が必須です。JSONはUTF-8で保存してください。

```json
{
  "eventId": "event-2026-08-03",
  "products": [
    {
      "productCode": "00000001",
      "name": "新刊",
      "priceInclTax": 800,
      "taxRate": 10,
      "taxCategory": "inclusive_10",
      "saleState": "on_sale"
    }
  ],
  "quickEntries": []
}
```

## 商品 (`products`)

| 項目 | 必須 | 内容 |
| --- | --- | --- |
| `productCode` | ○ | 商品管理コード。商品間で重複不可。バーコード運用時は登録したコードをそのまま使用する。 |
| `name` | ○ | 画面・レシートに表示する商品名。 |
| `priceInclTax` | ○ | 税込表示価格。0以上の整数（円）。 |
| `taxRate` | ○ | `taxCategory`と一致する税率（0、8、10）。 |
| `taxCategory` | ○ | `inclusive_10`、`inclusive_8`、`exclusive_10`、`exclusive_8`、`exempt`、`non_taxable`。 |
| `priceExclTax` | 税抜のみ | 税抜価格。`priceInclTax = priceExclTax + floor(priceExclTax × 税率 / 100)`。 |
| `saleState` | ○ | `on_sale`（販売）または `off_sale`（販売停止）。 |
| `ageCheck` | 任意 | `none`、`18`、`20`。省略時は年齢確認なし。 |
| `tabId` | 任意 | 表示する商品タブのID。 |
| `displayColor` | 任意 | 商品ボタンのCSSカラー。 |
| `thumbnailUrl` | 任意 | 商品ボタン画像のURL。 |
| `internalToken` | 任意 | 内部管理用文字列。 |

税込10%なら `taxRate: 10` と `taxCategory: "inclusive_10"` のように必ず組み合わせます。税抜商品の例:

```json
{
  "productCode": "00000002",
  "name": "税抜商品",
  "priceExclTax": 1000,
  "priceInclTax": 1100,
  "taxRate": 10,
  "taxCategory": "exclusive_10",
  "saleState": "on_sale"
}
```

## クイック登録 (`quickEntries`)

単品は `productCode` と `quantity`、セットは `components` を使います。参照先の商品コードは `products` に存在していなければなりません。

```json
"quickEntries": [
  {
    "id": "set-01",
    "label": "新刊2冊セット",
    "components": [
      { "productCode": "00000001", "quantity": 1 },
      { "productCode": "00000002", "quantity": 1 }
    ],
    "tabId": "books"
  }
]
```

## 商品タブ (`productTabs`)

```json
"productTabs": [
  { "id": "books", "label": "本", "color": "#dbeafe" }
]
```

商品の `tabId`、クイック登録の `tabId` と同じIDを指定します。

## 担当者 (`staffMembers`)

責任者番号は3桁の数字で重複不可です。権限は `catalog_import`（JSON取込）、`refund`、`reprint` のいずれかです。

```json
"staffMembers": [
  {
    "responsibleNumber": "001",
    "displayName": "管理者",
    "permissions": ["catalog_import", "reprint"]
  }
]
```

## 自動値引き (`autoDiscountRules`)

対象商品の組合せが揃ったときに固定額を値引きします。`discountYen` は対象商品の合計を超えられません。

```json
"autoDiscountRules": [
  {
    "id": "pair-discount",
    "label": "2冊セット値引き",
    "requiredProducts": [
      { "productCode": "00000001", "quantity": 1 },
      { "productCode": "00000002", "quantity": 1 }
    ],
    "discountYen": 100,
    "priority": 10
  }
]
```

## 顧客画面 (`customerWelcome`)

`message`、`circleName`、`space`、`imageUrl` は任意の文字列です。

```json
"customerWelcome": {
  "message": "いらっしゃいませ",
  "circleName": "event-pos",
  "space": "東A-01a",
  "imageUrl": "/catalog/welcome.png"
}
```

## 反映手順と確認

1. 既存JSONをバックアップし、編集後にUTF-8の `.json` として保存します。
2. 商品コード、税区分・税率、セット参照先、担当者番号の重複を確認します。
3. 責任者としてサインオンし、「業務メニュー」→「商品JSONインポート」を選択します。
4. 取込後、商品タブ・商品価格・クイック登録・担当者権限を画面で確認します。
5. 本番反映前に、少なくとも現金会計のテスト商品1件を登録し、レシートの品名・価格・税区分を確認します。

不正なJSONは取込前に拒否され、現在の設定は置き換わりません。取込はイベント単位で保存され、画面を再読み込みしてもサーバー保存値が使用されます。

## APIで更新する場合

管理用の更新経路では、JSON本文を次のAPIへ送信します。`eventId`のパスとJSON内の`eventId`は一致させてください。

```powershell
$json = Get-Content -Raw -Encoding UTF8 .\catalog.json
Invoke-RestMethod -Method Put `
  -Uri "https://pos.example/api/v1/events/event-2026-08-03/catalog" `
  -ContentType "application/json; charset=utf-8" `
  -Body $json
```

API更新後も、レジ画面を再読み込みして商品・タブ・担当者を確認してください。
