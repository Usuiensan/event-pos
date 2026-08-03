import { describe, expect, it } from "vitest";
import { ensureEventDetails, newDepartment, nextDepartmentId } from "./admin-settings.js";

describe("管理画面の部門採番", () => {
  it("未使用の3桁連番を採番する", () => {
    expect(nextDepartmentId([])).toBe("001");
    expect(nextDepartmentId([{ departmentId: "001", code: "001", name: "青果", settlementOwnerId: "001", enabled: true }, { departmentId: "003", code: "003", name: "書籍", settlementOwnerId: "003", enabled: true }])).toBe("002");
  });

  it("新規部門は内部IDを表示名から分離する", () => {
    expect(newDepartment([])).toEqual({ departmentId: "001", code: "001", name: "新しい部門", settlementOwnerId: "001", enabled: true });
  });
});

describe("管理画面のイベント情報補完", () => {
  it("旧DBにeventがなくても編集可能な初期値を用意する", () => {
    const result = ensureEventDetails({ eventId: "event-1", products: [], quickEntries: [] });
    expect(result.event).toEqual({ name: "event-1", businessDate: "1970-01-01", seller: { circleName: "", space: "", receiptIssuerName: "" }, locale: { language: "ja-JP", currency: "JPY", timezone: "Asia/Tokyo" } });
  });
});
