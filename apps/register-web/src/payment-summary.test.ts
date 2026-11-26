import { describe, expect, it } from "vitest";
import { paymentSummaryFromTotals, summarizePayments } from "./payment-summary.js";

describe("summarizePayments（F-075 複合支払の預り・釣銭集計）", () => {
  it("クレジットが先でも現金行の預り・釣銭を拾う", () => {
    expect(summarizePayments([
      { /* credit 40 */ },
      { tenderedYen: 100, changeYen: 40 },
    ])).toEqual({ tenderedYen: 100, changeYen: 40, hasTendered: true });
  });

  it("現金が先でも同じ集計になる", () => {
    expect(summarizePayments([
      { tenderedYen: 100, changeYen: 40 },
      { /* credit 40 */ },
    ])).toEqual({ tenderedYen: 100, changeYen: 40, hasTendered: true });
  });

  it("現金行が複数あれば全行を合計する", () => {
    expect(summarizePayments([
      { tenderedYen: 50, changeYen: 20 },
      { tenderedYen: 100, changeYen: 30 },
    ])).toEqual({ tenderedYen: 150, changeYen: 50, hasTendered: true });
  });

  it("釣銭0円でも預りありとして扱う", () => {
    expect(summarizePayments([{ tenderedYen: 100, changeYen: 0 }]))
      .toEqual({ tenderedYen: 100, changeYen: 0, hasTendered: true });
  });

  it("現金預りが無い支払だけなら hasTendered=false", () => {
    expect(summarizePayments([{}, {}])).toEqual({ tenderedYen: 0, changeYen: 0, hasTendered: false });
    expect(summarizePayments([])).toEqual({ tenderedYen: 0, changeYen: 0, hasTendered: false });
  });
});

describe("paymentSummaryFromTotals", () => {
  it("射影の集計値をそのまま写す", () => {
    expect(paymentSummaryFromTotals(150, 50)).toEqual({ tenderedYen: 150, changeYen: 50, hasTendered: true });
  });

  it("預りが射影に無い場合は空の集計", () => {
    expect(paymentSummaryFromTotals(undefined, undefined)).toEqual({ tenderedYen: 0, changeYen: 0, hasTendered: false });
  });
});
