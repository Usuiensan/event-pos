import { describe, expect, it } from "vitest";
import { createPublicReference, formatPublicReference, parseDatedPublicReference, parsePublicReference, validatePublicReference } from "./public-reference.js";

describe("public reference", () => {
  it("creates, formats, validates, and parses the 10-digit reference", () => {
    const reference = createPublicReference(1, 123456);
    expect(reference).toMatch(/^01\d{7}\d$/);
    expect(reference).toHaveLength(10);
    expect(validatePublicReference(reference)).toBe(true);
    expect(formatPublicReference(reference)).toBe(`${reference.slice(0, 5)}-${reference.slice(5)}`);
    expect(parsePublicReference(formatPublicReference(reference))).toEqual({ session: 1, sequence: 123456, checkDigit: Number(reference[9]) });
  });
  it("supports two-digit sessions up to 99", () => {
    const ten = createPublicReference(10, 1);
    expect(ten.startsWith("10")).toBe(true);
    expect(validatePublicReference(ten)).toBe(true);
    expect(parsePublicReference(ten)).toMatchObject({ session: 10, sequence: 1 });
    const ninetyNine = createPublicReference(99, 9999999);
    expect(validatePublicReference(ninetyNine)).toBe(true);
    expect(parsePublicReference(ninetyNine)).toMatchObject({ session: 99, sequence: 9999999 });
  });
  it("rejects a changed digit and invalid session or sequence", () => {
    const reference = createPublicReference(2, 42);
    const changed = `${reference.slice(0, 9)}${(Number(reference[9]) + 1) % 10}`;
    expect(validatePublicReference(changed)).toBe(false);
    expect(() => createPublicReference(0, 1)).toThrow();
    expect(() => createPublicReference(100, 1)).toThrow();
    expect(() => createPublicReference(1, 10000000)).toThrow();
  });
  it("parses dated receipt barcodes in both legacy 14-digit and current 16-digit forms (F-072)", () => {
    expect(parseDatedPublicReference("26080210000012")).toEqual({ businessDate: "2026-08-02", publicReference: "10000012" });
    expect(parseDatedPublicReference("2611290100000011")).toEqual({ businessDate: "2026-11-29", publicReference: "0100000011" });
  });
  it("rejects dated barcodes with a non-existent date or a bad check digit (F-072)", () => {
    expect(parseDatedPublicReference("2602300100000011")).toBeNull();
    expect(parseDatedPublicReference("2611290100000012")).toBeNull();
    // GTIN-14 として有効でも、受付番号の検査数字が不正なら日付付き受付番号ではない
    expect(parseDatedPublicReference("12022900000008")).toBeNull();
    expect(parseDatedPublicReference("0100000011")).toBeNull();
    expect(parseDatedPublicReference("261129010000001")).toBeNull();
  });
  it("still validates, formats, and parses legacy 8-digit references", () => {
    // 旧形式: 営業1桁 + 連番6桁 + 検査数字（移行前に発行された受付番号の例）
    const legacy = "10000012";
    expect(validatePublicReference(legacy)).toBe(true);
    expect(formatPublicReference(legacy)).toBe("1000-0012");
    expect(parsePublicReference(legacy)).toEqual({ session: 1, sequence: 1, checkDigit: 2 });
    expect(parsePublicReference(formatPublicReference(legacy))).toEqual({ session: 1, sequence: 1, checkDigit: 2 });
  });
});
