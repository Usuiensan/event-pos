import { describe, expect, it } from "vitest";
import { newDepartment, nextDepartmentId } from "./admin-settings.js";

describe("管理画面の部門採番", () => {
  it("未使用の3桁連番を採番する", () => {
    expect(nextDepartmentId([])).toBe("001");
    expect(nextDepartmentId([{ departmentId: "001", code: "001", name: "青果", settlementOwnerId: "001", enabled: true }, { departmentId: "003", code: "003", name: "書籍", settlementOwnerId: "003", enabled: true }])).toBe("002");
  });

  it("新規部門は内部IDを表示名から分離する", () => {
    expect(newDepartment([])).toEqual({ departmentId: "001", code: "001", name: "新しい部門", settlementOwnerId: "001", enabled: true });
  });
});
