# 09. バーコード名前空間案

## 1. 状態

- ADR: D020
- 状態: `Accepted`（2026-07-24）
- 確定済み: 取引・取り置き共通受付番号は営業セッション1桁＋連番6桁＋Damm検査数字、通常表示 `SNNN-NNNC`。
- 目的: 返品用伝票、取り置き、外部商品コード、POS内部商品コードを一台のバーコードリーダーで曖昧なく識別する。

## 2. 外部コードと衝突させない原則

ISDNはISBN-13に準じた13桁で、先頭278〜279を作品番号、292を価格等の2段目バーコードに使用する。いずれもインストアコード20x〜29xを利用している。

POSは次の規則を守る。

1. 伝票、取り置き、内部商品へ13桁数字を発番しない。
2. POS内部バーコードは英字種別を含む非GS1 Code 128とする。
3. 数字だけの8/12/13/14桁は外部商品コード候補として扱う。
4. 13桁で先頭278、279、292の値をPOS内部用途へ登録できない。
5. より広く、先頭3桁20x〜29xの13桁数字をPOS内部用途へ自動発番しない。
6. Code 128のバーコード自体にあるchecksumを使用し、POS独自payloadをEAN/JANとして偽装しない。

参考: https://isdn.jp/about.html

## 3. 提案するコード

| 対象 | 人間向け表示 | Code 128 payload | 用途 |
| --- | --- | --- | --- |
| 取引伝票 | `1123-456C` | `PS11<system token>` | 返品、取消、再印刷、照会 |
| 取り置き | `1123-457C` | `PS12<system token>` | 受取、解除、照会 |
| 内部商品 | 任意の商品コード | `PS13<system token>` | POS発行の商品ラベル |
| 外部商品 | EAN/UPC/ISBN/ISDN表記 | 元の数字payload | 商品登録 |

`PS` は非GS1のPOS用magic、次の数字はpayload version、その次の数字はtype（1=取引、2=取り置き、3=商品）である。`system token` はDBで一意制約を持つscanner専用の不変tokenとし、完全な128bit UUIDの10進表現は58 mm紙のCode 128には長すぎるため使用しない。DB参照の正本はUUIDv7とする。

レシートと取り置き票には、人間向け共通受付番号と対応する `PS...` Code 128を併記する。実際のmodule幅、高さ、quiet zone、58 mm紙での読取りは実機試験で確定する。

## 4. scanner router

scanner入力は各画面が直接解釈せず、サーバー共通の `BarcodeRouter` へ渡す。

判定順:

1. `PS11` + system token: 取引伝票
2. `PS12` + system token: 取り置き
3. `PS13` + system token: 内部商品token
4. 数字だけのGTIN候補: 桁数とcheck digitを検証し外部商品barcodeを検索
5. event内の明示登録済みcustom barcodeを完全一致検索
6. どれにも一致しなければunknownとしてエラー

重要な拒否規則:

- `PS` で始まるが構文不正な値を、商品コードや現金入力へfallbackしない。
- 一つのscan payloadを複数の商品または複数種別へ登録できない。
- 有効なGTINと同じ数字列を別商品のcustom codeへ登録できない。
- 278/279/292を含む外部コードを内部商品tokenへ変換せず、元payloadのまま外部barcodeとして保存する。
- scanner入力とキーボードの預り金入力を別bufferにし、barcodeを金額として解釈しない。

## 5. データモデル案

| テーブル | 主要列・制約 |
| --- | --- |
| `product_barcodes` | event_id, product_id, normalized_payload, kind(gtin/ean/upc/isbn/isdn/custom), unique(event_id,normalized_payload) |
| `product_internal_tokens` | event_id, product_id, token, version, active, unique(token) |
| `public_references` | event_id, business_day_id, session_no（1桁）, sequence_no（6桁）, check_digit, subject_type(transaction/hold), subject_id, unique(event_id,session_no,sequence_no), unique(subject_type,subject_id) |
| `document_barcodes` | subject_type(transaction/hold), subject_id, payload, version, unique(payload), unique(subject_type,subject_id,version) |

取引と取り置きは `business_days.next_public_reference_no` を共有する。7桁本体はevent内営業セッション番号1桁 `S` とbusiness day内連番6桁 `NNNNNN` の `SNNNNNN` で、Damm検査数字 `C` を付け `SNNN-NNNC` と表示する。真の新規開局では `S` を進め `NNNNNN` をリセットし、締め取消・再開では同じ `S` の続番を使う。DB参照の正本はUUIDで、受付番号とbarcode payloadは検索用alternate keyとする。

`product_code` はevent内の商品管理番号として残せるが、scanner identityの正本にはしない。商品へ複数の外部barcodeを関連付けられるようにする。

## 6. API案

- `POST /barcode/resolve`: payloadを受け、`transaction/hold/product/unknown` と対象IDを返す。
- `POST /admin/products/{id}/barcodes`: 外部barcodeを追加。namespace/check digit/重複を検証する。
- `POST /admin/products/{id}/internal-label`: `PS13` tokenのラベルを生成する。
- `GET /transactions/{id}/barcode`: 伝票Code 128用payloadを取得する。
- `GET /holds/{id}/barcode`: 取り置きCode 128用payloadを取得する。

変更系操作はresolve結果だけで実行せず、返されたsubject ID、version、権限、現在状態を各use caseで再検証する。

## 7. 試験

- EAN-8、UPC-A、EAN-13、GTIN-14と、278/279/292のfixtureを外部商品として解決できる。
- `PS11/PS12/PS13` が商品、現金、相互の種別へ誤分類されない。
- 不正なversion、長さ、文字、check digitを拒否しfallbackしない。
- 同一payloadの二重登録と、別商品への付替え競合を拒否する。
- 4レジ同時採番で取引・取り置きの共通受付番号とbarcodeが一意になる。
- 同日2回以上の新規開局で `S` が進み、締め取消・再開では進まない。
- Damm検査数字が不正な手入力受付番号を拒否する。
- transaction barcodeから返品対象、hold barcodeから受取対象だけを取得する。
- 58 mmレシートと取り置き票を実機印刷し、使用予定scannerで連続100回読取り、誤読・未読を記録する。
- scanner切断、二重送信、末尾Enterの有無、手入力貼付けを試験する。

## 8. 採用時に要件へ追加する事項

- 商品コード8桁以上という既存規則と、barcode namespaceを分離する。
- scanner入力は桁数による商品/預り金推測だけでなく、共通routerを必ず通す。
- 返品、取消、再印刷は伝票barcodeから開始できる。
- 取り置き登録時にhold barcodeを発行し、受取・解除時に利用できる。
- 278〜279、292を含むインストアコード領域をPOS内部コードへ使用しない。
