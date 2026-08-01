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
  it.each([[300, "さんびゃく えん"], [600, "ろっぴゃく えん"], [800, "はっぴゃく えん"], [3000, "さんぜん えん"], [8000, "はっせん えん"]])("uses natural Japanese sound changes for %s", (amount, expected) => {
    expect(formatJapaneseYenSpeech(amount)).toBe(expected);
  });
});
