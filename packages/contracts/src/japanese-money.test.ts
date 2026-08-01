import { describe, expect, it } from "vitest";
import { formatJapaneseYenSpeech, readJapaneseYen } from "./japanese-money.js";

describe("Japanese yen speech", () => {
  it("reads 15740 with separated natural parts", () => {
    expect(readJapaneseYen(15740)).toEqual(["いち", "まん", "ごせん", "ななひゃく", "よんじゅう", "えん"]);
    expect(formatJapaneseYenSpeech(15740)).toBe("いち まん ごせん ななひゃく よんじゅう えん");
  });
  it.each([[0, "ぜろえん"], [100, "ひゃく えん"], [10000, "いち まん えん"]])("reads %s", (amount, expected) => {
    expect(formatJapaneseYenSpeech(amount)).toBe(expected);
  });
});
