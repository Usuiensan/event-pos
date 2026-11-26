import { describe, expect, it } from "vitest";
import { canOpenCashOperationsForReopen } from "./register-lifecycle.js";

describe("canOpenCashOperationsForReopen（F-081）", () => {
  it("精算済みレジでは責任者だけが現金管理を開ける", () => {
    expect(canOpenCashOperationsForReopen("closed", "manager")).toBe(true);
    expect(canOpenCashOperationsForReopen("closed", "admin")).toBe(true);
    expect(canOpenCashOperationsForReopen("closed", "operator")).toBe(false);
  });

  it("精算済み以外の状態では再開用の導線を出さない", () => {
    expect(canOpenCashOperationsForReopen("preparing", "manager")).toBe(false);
    expect(canOpenCashOperationsForReopen("open", "manager")).toBe(false);
    expect(canOpenCashOperationsForReopen("open", "admin")).toBe(false);
  });
});
