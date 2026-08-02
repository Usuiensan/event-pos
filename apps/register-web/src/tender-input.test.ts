import { describe, expect, it } from "vitest";
import { convertToTenThousands } from "./tender-input.js";

describe("convertToTenThousands", () => {
  it.each([["", "10000"], ["1", "10000"], ["10", "100000"]])("入力%sを万円単位へ変換する", (input, expected) => {
    expect(convertToTenThousands(input)).toBe(expected);
  });
});
