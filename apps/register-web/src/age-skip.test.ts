import { describe, expect, it } from "vitest";
import { ageSkipRemainingSeconds, canSkipCustomerAgeConfirmation } from "./age-skip.js";

describe("R18客側スキップ", () => {
  const requestedAt = "2026-08-02T00:00:00.000Z";
  const start = Date.parse(requestedAt);

  it("顧客画面なしでは即時有効になる", () => {
    expect(canSkipCustomerAgeConfirmation(false, requestedAt, start)).toBe(true);
  });

  it("顧客画面ありでは10秒未満を無効、10秒後を有効にする", () => {
    expect(canSkipCustomerAgeConfirmation(true, requestedAt, start + 9_999)).toBe(false);
    expect(ageSkipRemainingSeconds(requestedAt, start + 9_001)).toBe(1);
    expect(canSkipCustomerAgeConfirmation(true, requestedAt, start + 10_000)).toBe(true);
  });

  it("10秒以内でもheartbeat期限切れなら再評価して即時有効にする", () => {
    expect(canSkipCustomerAgeConfirmation(true, requestedAt, start + 3_000)).toBe(false);
    expect(canSkipCustomerAgeConfirmation(false, requestedAt, start + 3_000)).toBe(true);
  });
});
