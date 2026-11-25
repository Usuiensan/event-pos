import { describe, expect, it } from "vitest";
import { DEFAULT_REASON, PAY_IN_REASON_OPTIONS, PAY_OUT_REASON_OPTIONS, REASON_OPTIONS, cashMovementReasonOptions } from "./reason-options.js";

describe("理由プリセット", () => {
  it("従来の共通理由は変更しない（返品・再印刷・取り置き用）", () => {
    expect(REASON_OPTIONS).toEqual(["用紙不具合", "システム不具合", "売主都合", "買主都合", "その他"]);
    expect(DEFAULT_REASON).toBe("その他");
  });

  it("入金専用の理由が選択できる", () => {
    expect(cashMovementReasonOptions("pay_in")).toEqual(["釣銭補充", "両替", "金庫から補充", "他レジから", "売掛回収", "立替返済", "預り金", "その他"]);
    expect(PAY_IN_REASON_OPTIONS).toContain("立替返済");
    expect(PAY_IN_REASON_OPTIONS).not.toContain("立替精算");
  });

  it("出金専用の理由が選択できる", () => {
    expect(cashMovementReasonOptions("pay_out")).toEqual(["両替", "売上金回収・金庫へ", "銀行入金", "立替精算", "消耗品・備品", "交通費", "仕入・買い出し", "返金", "その他"]);
    expect(PAY_OUT_REASON_OPTIONS).toContain("立替精算");
    expect(PAY_OUT_REASON_OPTIONS).not.toContain("立替返済");
  });

  it("入金・出金とも既定値「その他」を含む", () => {
    expect(PAY_IN_REASON_OPTIONS).toContain(DEFAULT_REASON);
    expect(PAY_OUT_REASON_OPTIONS).toContain(DEFAULT_REASON);
  });

  it("入出金の理由に重複がない", () => {
    expect(new Set(PAY_IN_REASON_OPTIONS).size).toBe(PAY_IN_REASON_OPTIONS.length);
    expect(new Set(PAY_OUT_REASON_OPTIONS).size).toBe(PAY_OUT_REASON_OPTIONS.length);
  });
});
