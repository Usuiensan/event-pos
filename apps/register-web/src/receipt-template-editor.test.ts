import { describe, expect, it } from "vitest";
import { parseReceiptTemplateNodes, serializeReceiptTemplateNodes, type TemplateNode } from "./receipt-template-editor.js";

const V6 = `schemaVersion: 1
body:
  - reset: true
  - align: center
  - emphasis: { bold: true, underline: false, invert: false }
  - text: "{{eventName}}"
  - text: "{{circleName}}"
  - emphasis: { bold: false, underline: false, invert: false }
  - align: left
  - if: isReprint
    body:
      - emphasis: { bold: true, underline: false, invert: true }
      - text: "{{reprintLabel}} #{{reprintNo}}"
      - text: "元受付番号 {{originalReceiptNumber}}"
      - emphasis: { bold: false, underline: false, invert: false }
  - row: { left: "受付番号", right: "{{publicReference}}" }
  - row: { left: "確定日時", right: "{{confirmedAtPrinted}}" }
  - row: { left: "レジ/担当", right: "{{registerNo}}/{{staffPrintLabel}}" }
  - rule: single
  - each: lines
    body:
      - text: "{{name}}"
      - text: "JAN {{productCode}}"
      - row: { left: "単¥{{unitPriceFormatted}} × {{quantity}}", right: "{{netFormatted}}" }
  - rule: single
  - if: hasDiscounts
    body:
      - row: { left: "値引", right: "{{discountTotalFormatted}}" }
  - row: { left: "税", right: "{{taxTotalFormatted}}" }
  - emphasis: { bold: true, underline: false, invert: false }
  - row: { left: "合計", right: "{{totalFormatted}}" }
  - emphasis: { bold: false, underline: false, invert: false }
  - each: payments
    body:
      - row: { left: "{{methodName}}", right: "{{amountFormatted}}" }
  - if: hasTendered
    body:
      - row: { left: "預り", right: "{{tenderedFormatted}}" }
  - if: hasChange
    body:
      - row: { left: "釣銭", right: "{{changeFormatted}}" }
  - text: "{{footer}}"
  - text: "{{returnPolicy}}"
  - barcode: { value: "{BPS14{{businessDateYYMMDD}}{{publicReferenceRaw}}", width: 2, height: 96, hri: below }
  - finish: { feedLines: 8, cutMode: partial }
`;
describe("レシートテンプレートGUI用パーサ", () => {
  it("v6を往復できる", () => expect(serializeReceiptTemplateNodes(parseReceiptTemplateNodes(V6)!)).toBe(V6));
  it("全kindを往復できる", () => { const nodes: TemplateNode[] = [{ kind: "reset" }, { kind: "text", text: "x\n{{eventName}}" }, { kind: "row", left: "左", right: "右" }, { kind: "align", value: "center" }, { kind: "emphasis", bold: true, underline: true, invert: false }, { kind: "size", width: 2, height: 1 }, { kind: "rule", style: "double" }, { kind: "feed", lines: 3 }, { kind: "image", assetId: "a", widthDots: 384 }, { kind: "qr", data: "d", moduleSize: 4, errorCorrection: "Q" }, { kind: "finish", feedLines: 8, cutMode: "partial3" }, { kind: "each", collection: "lines", body: [{ kind: "if", condition: "quantityOne", body: [{ kind: "text", text: "one" }] }] }, { kind: "if", condition: "hasDiscounts", body: [{ kind: "text", text: "discount" }] }]; expect(parseReceiptTemplateNodes(serializeReceiptTemplateNodes(nodes))).toEqual(nodes); });
  it("ラベルを書き換えたv6も往復できる", () => { const changed = V6.replace("受付番号", "確認番号"); expect(serializeReceiptTemplateNodes(parseReceiptTemplateNodes(changed)!)).toBe(changed); });
  it("想定外の本文は読まない", () => { expect(parseReceiptTemplateNodes("ただの文字列")).toBeNull(); expect(parseReceiptTemplateNodes("schemaVersion: 1\nbody:\n  - barcode: x\n")).toBeNull(); expect(parseReceiptTemplateNodes(V6.replace("schemaVersion: 1", "schemaVersion: 2"))).toBeNull(); });
});

const V8_LOOSE = `schemaVersion: 1
body:
  - reset: true
  - align: center
  - emphasis: { bold: true, underline: false, invert: false }
  - text: "{{eventName}}"
  - text: "{{circleName}}"
  - emphasis: { bold: false, underline: false, invert: false }
  - align: left
  - if: isReprint
    body:
      - emphasis: { bold: true, underline: false, invert: true }
      - text: "{{reprintLabel}} #{{reprintNo}}"
      - text: "伝票番号 {{originalReceiptNumber}}"
      - emphasis: { bold: false, underline: false, invert: false }
  - text:"{{confirmedAtPrinted}}    {{publicReference}}"
  - text:"レジ{{registerNo}}    担当{{staffPrintLabel}}" 
  - rule: single
  - each: lines
    body:
      - text: "{{name}}"
      - text: "品番 {{productCode}}"
      - row: { left: "＠{{unitPriceFormatted}} × {{quantity}}", right: "{{netFormatted}}" }
  - rule: single
  - if: hasDiscounts
    body:
      - row: { left: "値引", right: "{{discountTotalFormatted}}" }
  - row: { left: "税", right: "{{taxTotalFormatted}}" }
  - emphasis: { bold: true, underline: false, invert: false }
  - row: { left: "合計", right: "{{totalFormatted}}" }
  - emphasis: { bold: false, underline: false, invert: false }
  - each: payments
    body:
      - row: { left: "{{methodName}}", right: "{{amountFormatted}}" }
  - if: hasTendered
    body:
      - row: { left: "預り", right: "{{tenderedFormatted}}" }
  - if: hasChange
    body:
      - row: { left: "釣銭", right: "{{changeFormatted}}" }
  - text: "{{footer}}"
  - text: "{{returnPolicy}}"
  - finish: { feedLines: 8, cutMode: partial }
`;
describe("手書きゆらぎのある本文", () => {
  it("コロンの後の空白なし・行末空白でも読み、正しい形へ直せる", () => { const nodes = parseReceiptTemplateNodes(V8_LOOSE); expect(nodes).not.toBeNull(); expect(nodes).toHaveLength(24); const canonical = serializeReceiptTemplateNodes(nodes!); expect(canonical).toContain('text: "{{confirmedAtPrinted}}    {{publicReference}}"'); expect(canonical).toContain('text: "レジ{{registerNo}}    担当{{staffPrintLabel}}"'); expect(parseReceiptTemplateNodes(canonical)).toEqual(nodes); });
});
