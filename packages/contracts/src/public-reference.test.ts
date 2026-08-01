import { describe, expect, it } from "vitest";
import { createPublicReference, formatPublicReference, parsePublicReference, validatePublicReference } from "./public-reference.js";

describe("public reference", () => {
  it("creates, formats, validates, and parses the 8-digit reference", () => {
    const reference = createPublicReference(1, 123456);
    expect(reference).toMatch(/^1\d{6}\d$/);
    expect(validatePublicReference(reference)).toBe(true);
    expect(formatPublicReference(reference)).toBe(`${reference.slice(0, 4)}-${reference.slice(4)}`);
    expect(parsePublicReference(formatPublicReference(reference))).toEqual({ session: 1, sequence: 123456, checkDigit: Number(reference[7]) });
  });
  it("rejects a changed digit and invalid session", () => {
    const reference = createPublicReference(2, 42);
    const changed = `${reference.slice(0, 7)}${(Number(reference[7]) + 1) % 10}`;
    expect(validatePublicReference(changed)).toBe(false);
    expect(() => createPublicReference(0, 1)).toThrow();
  });
});
