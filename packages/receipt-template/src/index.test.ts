import { describe, expect, it } from "vitest";
import { compileReceiptTemplate, DEFAULT_RECEIPT_TEMPLATE, validateReceiptTemplate, type ReceiptSnapshot } from "./index.js";

const snapshot: ReceiptSnapshot = {
  schemaVersion: 1, eventName: "例大祭", circleName: "サークル", transactionId: "tx-1", publicReference: "1000-0015", transactionType: "sale", originalPublicReference: "", confirmedAt: "2026-08-02 12:00", businessDate: "2026-08-02", registerNo: "1", staffPrintLabel: "001",
  lines: [{ productCode: "00000001", name: "新刊", quantity: 1, unitPriceYen: 500, unitPriceFormatted: "¥500", grossYen: 500, grossFormatted: "¥500", discountAllocatedYen: 0, discountFormatted: "¥0", taxYen: 45, taxFormatted: "¥45", netYen: 500, netFormatted: "¥500", taxRateBps: 1000 }],
  discounts: [], taxSummaries: [{ taxRateBps: 1000, taxableNetYen: 500, taxableNetFormatted: "¥500", taxYen: 45, taxFormatted: "¥45" }], payments: [{ methodName: "現金", amountYen: 500, amountFormatted: "¥500", tenderedYen: 1000, tenderedFormatted: "¥1,000", changeYen: 500, changeFormatted: "¥500" }],
  subtotalYen: 500, subtotalFormatted: "¥500", discountTotalYen: 0, discountTotalFormatted: "¥0", taxTotalYen: 45, taxTotalFormatted: "¥45", totalYen: 500, totalFormatted: "¥500", tenderedYen: 1000, tenderedFormatted: "¥1,000", changeYen: 500, changeFormatted: "¥500",
  isReprint: false, reprintLabel: "", reprintNo: 0, originalReceiptNumber: "", footer: "ありがとうございました", returnPolicy: "返品は責任者へお申し出ください", hasOriginalTransaction: false, hasDiscounts: false, hasTendered: true, hasChange: true,
};

describe("receipt template", () => {
  it("同じsnapshotから同じASTと人間向けpreviewを生成する", () => {
    expect(compileReceiptTemplate(DEFAULT_RECEIPT_TEMPLATE, snapshot)).toEqual(compileReceiptTemplate(DEFAULT_RECEIPT_TEMPLATE, snapshot));
    expect(compileReceiptTemplate(DEFAULT_RECEIPT_TEMPLATE, snapshot).humanReadable).toContain("新刊 x1");
  });

  it("未知node・変数・幅超過・finish欠落/複数を有効化前に拒否する", () => {
    expect(() => validateReceiptTemplate("schemaVersion: 1\nbody:\n  - raw: 1\n")).toThrow("許可node");
    expect(() => validateReceiptTemplate("schemaVersion: 1\nbody:\n  - text: '{{secret}}'\n  - finish: { feedLines: 3, cutMode: partial }\n")).toThrow("未知変数");
    expect(() => validateReceiptTemplate(`schemaVersion: 1\nbody:\n  - row: { left: "${"長".repeat(20)}", right: "¥100" }\n  - finish: { feedLines: 3, cutMode: partial }\n`)).toThrow("2列幅");
    expect(() => validateReceiptTemplate("schemaVersion: 1\nbody:\n  - text: ok\n")).toThrow("finishは1個");
    expect(() => validateReceiptTemplate("schemaVersion: 1\nbody:\n  - finish: { feedLines: 1, cutMode: partial }\n  - finish: { feedLines: 1, cutMode: partial }\n")).toThrow("finishは1個");
  });

  it("raw ESC/POS・drawer・buzzer・full cutを許可しない", () => {
    for (const node of ["raw", "drawer", "buzzer"]) expect(() => validateReceiptTemplate(`schemaVersion: 1\nbody:\n  - ${node}: true\n  - finish: { feedLines: 1, cutMode: partial }\n`)).toThrow("許可node");
    expect(() => validateReceiptTemplate("schemaVersion: 1\nbody:\n  - finish: { feedLines: 1, cutMode: full }\n")).toThrow("none/partial/partial3");
  });
});
