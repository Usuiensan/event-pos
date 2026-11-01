import { describe, expect, it } from "vitest";
import { classifyScan } from "./scan-routing.js";
import { stockTier } from "./stock.js";

describe("stockTier", () => {
  it.each([[0, "out"], [1, "low"], [5, "low"], [6, "normal"]] as const)("available=%s", (available, expected) => {
    expect(stockTier(available)).toBe(expected);
  });
});

describe("classifyScan", () => {
  it.each([
    ["PS12ABC", { kind: "hold", reference: "ABC" }],
    ["PS13ABC", { kind: "parked-draft", parkReference: "ABC" }],
    ["PS14ABC", { kind: "transaction", reference: "ABC" }],
    ["4901234567890", { kind: "product", raw: "4901234567890" }],
    ["", { kind: "product", raw: "" }],
  ] as const)("%s", (raw, expected) => {
    expect(classifyScan(raw)).toEqual(expected);
  });
});
