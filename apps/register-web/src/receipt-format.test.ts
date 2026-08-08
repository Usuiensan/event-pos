import { describe, expect, it } from "vitest";
import { buildReceiptTemplate } from "./receipt-format.js";

describe("レシート簡易フォーマット", () => {
  it("ヘッダー・フッター画像と文字、JAN印字をテンプレートへ反映する", () => {
    const template = buildReceiptTemplate({
      headerText: "{{eventName}}\n{{circleName}}",
      footerText: "ありがとうございました",
      headerAsset: { assetId: "header-logo", version: 1, sha256: "hash", mime: "application/x-event-pos-mono-raster", widthDots: 384, heightDots: 20, rasterBase64: "" },
      footerAsset: { assetId: "footer-logo", version: 1, sha256: "hash", mime: "application/x-event-pos-mono-raster", widthDots: 200, heightDots: 20, rasterBase64: "" },
      printJan: true,
    });
    expect(template).toContain('assetId: "header-logo"');
    expect(template).toContain('text: "{{eventName}}\\n{{circleName}}"');
    expect(template).toContain('text: "JAN {{productCode}}"');
    expect(template).toContain('assetId: "footer-logo"');
    expect(template).toContain('text: "ありがとうございました"');
  });

  it("JAN印字を切るとJAN行を出さない", () => {
    expect(buildReceiptTemplate({ headerText: "", footerText: "", printJan: false })).not.toContain("{{productCode}}");
  });
});
