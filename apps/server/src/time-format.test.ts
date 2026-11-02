import { describe, expect, it } from "vitest";
import { formatJstDateTime } from "./time-format.js";

describe("formatJstDateTime", () => {
  it("UTCのISO文字列をJSTの表示形式へ変換する", () => {
    expect(formatJstDateTime("2026-11-02T02:45:00.000Z")).toBe("2026-11-02 11:45");
  });

  it("日付をまたぐ場合もJSTで繰り上がる", () => {
    expect(formatJstDateTime("2026-11-01T16:30:00.000Z")).toBe("2026-11-02 01:30");
  });
});
