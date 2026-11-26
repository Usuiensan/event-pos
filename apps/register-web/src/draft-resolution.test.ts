import { describe, expect, it } from "vitest";
import type { CheckoutDraft } from "./checkout-api.js";
import { canCancelDraftRegistration, canOpenDraftPayment, draftHasClaimedHoldLines, draftHasResidualObligations } from "./draft-resolution.js";

type Line = CheckoutDraft["lines"][number];
type Payment = CheckoutDraft["payments"][number];

const line = (overrides: Partial<Line> = {}): Line => ({
  lineId: "line-1", lineNo: 1, productId: "p1", productCode: "00000001", name: "商品",
  priceInclTax: 100, taxRate: 10, taxCategory: "inclusive_10", quantity: 1,
  status: "active", source: "manual", ...overrides,
});
const payment = (overrides: Partial<Payment> = {}): Payment => ({
  paymentId: "payment-1", sequence: 1, kind: "credit", amountYen: 100, ...overrides,
});
const draft = (overrides: Partial<CheckoutDraft> = {}): CheckoutDraft => ({
  draftId: "draft-1", eventId: "event-1", registerId: "register-1", staffId: "001",
  terminalId: "register-1", businessDate: "2026-08-03", sessionNo: 1, version: 1,
  state: "editing", lines: [], payments: [], ageVerifications: [],
  calculation: { lines: [], discounts: [], taxSummaries: [], subtotalYen: 0, discountTotalYen: 0, taxTotalYen: 0, totalYen: 0 },
  createdAt: "2026-08-03T00:00:00.000Z", updatedAt: "2026-08-03T00:00:00.000Z", ...overrides,
});

describe("登録中止・支払確認への到達判定（F-077 / F-079）", () => {
  it("有効明細がある通常の下書きは登録中止も小計もできる", () => {
    const target = draft({ lines: [line()] });
    expect(canCancelDraftRegistration(target)).toBe(true);
    expect(canOpenDraftPayment(target)).toBe(true);
  });

  it("F-077: 受取明細を全て取り消しても引当が残る下書きは登録中止できる", () => {
    const target = draft({ lines: [line({ status: "canceled", source: "hold" })] });
    expect(draftHasClaimedHoldLines(target)).toBe(true);
    expect(canCancelDraftRegistration(target)).toBe(true);
    // 引当だけでは支払確認は開かない（支払行がないため）
    expect(canOpenDraftPayment(target)).toBe(false);
  });

  it("F-079: 最後の明細を取り消しても支払行が残る下書きは登録中止も支払確認もできる", () => {
    const target = draft({ state: "editing", lines: [line({ status: "canceled" })], payments: [payment()] });
    expect(draftHasResidualObligations(target)).toBe(true);
    expect(canCancelDraftRegistration(target)).toBe(true);
    expect(canOpenDraftPayment(target)).toBe(true);
  });

  it("F-079: 0円の支払行（無配）だけが残っても対象になる", () => {
    const target = draft({ lines: [line({ status: "canceled" })], payments: [payment({ kind: "no_charge", amountYen: 0 })] });
    expect(canCancelDraftRegistration(target)).toBe(true);
    expect(canOpenDraftPayment(target)).toBe(true);
  });

  it("明細・支払・引当が何もない空の下書きは対象にならない", () => {
    const target = draft({ lines: [line({ status: "canceled" })] });
    expect(canCancelDraftRegistration(target)).toBe(false);
    expect(canOpenDraftPayment(target)).toBe(false);
    expect(canCancelDraftRegistration(draft())).toBe(false);
    expect(canCancelDraftRegistration(null)).toBe(false);
    expect(canOpenDraftPayment(undefined)).toBe(false);
  });

  it("確定済み・中止済み・保留中の下書きは対象にならない", () => {
    const residual = { lines: [line({ status: "canceled", source: "hold" })], payments: [payment()] };
    for (const state of ["completed", "canceled", "parked", "finalizing"] as const) {
      expect(canCancelDraftRegistration(draft({ state, ...residual }))).toBe(false);
      expect(canOpenDraftPayment(draft({ state, ...residual }))).toBe(false);
    }
  });

  it("支払状態の下書きでも支払行が残れば対象になる", () => {
    const target = draft({ state: "payment", lines: [line({ status: "canceled" })], payments: [payment()] });
    expect(canCancelDraftRegistration(target)).toBe(true);
    expect(canOpenDraftPayment(target)).toBe(true);
  });
});
