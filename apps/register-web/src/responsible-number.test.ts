import { describe, expect, it } from "vitest";
import { normalizeResponsibleNumber } from "./responsible-number.js";

describe("normalizeResponsibleNumber", () => {
  it.each([["1", "001"], ["12", "012"], ["123", "123"]])("%sを3桁に正規化する", (input, expected) => {
    expect(normalizeResponsibleNumber(input)).toBe(expected);
  });

  it.each(["", "1234", "A1"])("不正な入力%sを拒否する", (input) => {
    expect(normalizeResponsibleNumber(input)).toBeNull();
  });
});
