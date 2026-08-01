import { describe, expect, it } from "vitest";
import { createCashCheck } from "./cash-counting.js";

describe("cash counting", () => {
  it("calculates actual cash and shortage/overage", () => {
    const check = createCashCheck({ sessionId: "s1", kind: "opening", theoreticalYen: 1000, counted: [{ denomination: 500, quantity: 1 }, { denomination: 100, quantity: 4 }] });
    expect(check.countedYen).toBe(900); expect(check.differenceYen).toBe(-100);
  });
  it("rejects duplicate denominations and negative quantities", () => {
    expect(() => createCashCheck({ sessionId: "s1", kind: "closing", theoreticalYen: 0, counted: [{ denomination: 100, quantity: 1 }, { denomination: 100, quantity: 1 }] })).toThrow();
    expect(() => createCashCheck({ sessionId: "s1", kind: "closing", theoreticalYen: 0, counted: [{ denomination: 100, quantity: -1 }] })).toThrow();
  });
});
