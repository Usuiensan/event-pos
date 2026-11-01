import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { buildReceiptTemplate, parseReceiptFormatSettings, sha256Fallback } from "./receipt-format.js";

// DEFAULT_RECEIPT_TEMPLATE v5 と簡易設定のデフォルト生成結果を同期するための期待値。
const DEFAULT_RECEIPT_TEMPLATE_V5 = `schemaVersion: 1
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
  - finish: { feedLines: 8, cutMode: partial }
`;

describe("レシート簡易フォーマット", () => {
  it("デフォルト設定は DEFAULT_RECEIPT_TEMPLATE v5 と一致する", () => {
    expect(buildReceiptTemplate({
      headerText: "{{eventName}}\n{{circleName}}",
      footerText: "{{footer}}\n{{returnPolicy}}",
      printJan: true,
    })).toBe(DEFAULT_RECEIPT_TEMPLATE_V5);
  });

  it("ヘッダー・フッター画像と文字、JAN印字をテンプレートへ反映する", () => {
    const template = buildReceiptTemplate({
      headerText: "{{eventName}}\n{{circleName}}",
      footerText: "ありがとうございました",
      headerAsset: { assetId: "header-logo", version: 1, sha256: "hash", mime: "application/x-event-pos-mono-raster", widthDots: 384, heightDots: 20, rasterBase64: "" },
      footerAsset: { assetId: "footer-logo", version: 1, sha256: "hash", mime: "application/x-event-pos-mono-raster", widthDots: 200, heightDots: 20, rasterBase64: "" },
      printJan: true,
    });
    expect(template).toContain('assetId: "header-logo"');
    expect(template).toContain('text: "{{eventName}}"');
    expect(template).toContain('text: "{{circleName}}"');
    expect(template).toContain('text: "JAN {{productCode}}"');
    expect(template).toContain('assetId: "footer-logo"');
    expect(template).toContain('text: "ありがとうございました"');
  });

  it("JAN印字を切るとJAN行を出さない", () => {
    expect(buildReceiptTemplate({ headerText: "", footerText: "", printJan: false })).not.toContain("{{productCode}}");
  });

  it("生成したテンプレートを簡易設定へ戻せる", () => {
    expect(parseReceiptFormatSettings(buildReceiptTemplate({ headerText: "ヘッダー1\nヘッダー2", footerText: "フッター1\nフッター2", printJan: true }))).toEqual({ headerText: "ヘッダー1\nヘッダー2", footerText: "フッター1\nフッター2", headerAssetId: "", footerAssetId: "", printJan: true });
  });

  it("DEFAULT_RECEIPT_TEMPLATE v5 を簡易設定へ戻せる", () => {
    expect(parseReceiptFormatSettings(DEFAULT_RECEIPT_TEMPLATE_V5)).toMatchObject({ headerText: "{{eventName}}\n{{circleName}}", footerText: "{{footer}}\n{{returnPolicy}}", printJan: true });
  });

  it("SHA-256フォールバックはブロック境界を含めNode実装と一致する", () => {
    for (const length of [0, 3, 55, 56, 64, 119, 128]) {
      const bytes = Uint8Array.from({ length }, (_, index) => index & 0xff);
      expect(sha256Fallback(bytes)).toBe(createHash("sha256").update(bytes).digest("hex"));
    }
  });

  it("画像付きテンプレートの画像IDを読み取れる", () => {
    const template = buildReceiptTemplate({ headerText: "", footerText: "", headerAsset: { assetId: "header-logo", version: 1, sha256: "hash", mime: "application/x-event-pos-mono-raster", widthDots: 384, heightDots: 20, rasterBase64: "" }, footerAsset: { assetId: "footer-logo", version: 1, sha256: "hash", mime: "application/x-event-pos-mono-raster", widthDots: 200, heightDots: 20, rasterBase64: "" }, printJan: false });
    expect(parseReceiptFormatSettings(template)).toMatchObject({ headerAssetId: "header-logo", footerAssetId: "footer-logo" });
  });

  it("resetがない、またはschemaVersionがない本文は読まない", () => {
    expect(parseReceiptFormatSettings("schemaVersion: 1\nbody:\n  - align: left\n  - finish: {}\n")).toBeNull();
    expect(parseReceiptFormatSettings("body:\n  - reset: true\n")).toBeNull();
  });
});
