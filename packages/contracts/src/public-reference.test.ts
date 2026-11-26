import { describe, expect, it } from "vitest";
import { createPublicReference, formatPublicReference, parsePublicReference, validatePublicReference } from "./public-reference.js";

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
  it("still validates, formats, and parses legacy 8-digit references", () => {
    // 旧形式: 営業1桁 + 連番6桁 + 検査数字（移行前に発行された受付番号の例）
    const legacy = "10000012";
    expect(validatePublicReference(legacy)).toBe(true);
    expect(formatPublicReference(legacy)).toBe("1000-0012");
    expect(parsePublicReference(legacy)).toEqual({ session: 1, sequence: 1, checkDigit: 2 });
    expect(parsePublicReference(formatPublicReference(legacy))).toEqual({ session: 1, sequence: 1, checkDigit: 2 });
  });
});
