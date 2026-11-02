import { describe, expect, it } from "vitest";
import { classifyScan, nextInputBuffer } from "./scan-routing.js";

const type = (keys: string) => [...keys].reduce((buffer, key) => nextInputBuffer(buffer, key), "");

describe("nextInputBuffer", () => {
  it("PS13スキャンを文字ごと取り込む", () => {
    expect(type("PS1310000012")).toBe("PS1310000012");
    expect(classifyScan(type("PS1310000012"))).toEqual({ kind: "parked-draft", parkReference: "10000012" });
  });

  it("PS12・PS14スキャンも取り込む", () => {
    expect(classifyScan(type("PS1210000012"))).toEqual({ kind: "hold", reference: "10000012" });
    expect(classifyScan(type("PS1426080210000015"))).toEqual({ kind: "transaction", reference: "10000015", businessDate: "2026-08-02" });
  });

  it("通常の数字入力はそのまま貯める", () => {
    expect(type("1000")).toBe("1000");
    expect(type("4901002004")).toBe("4901002004");
  });

  it("Pの後に数字が来たら金額入力として再解釈する", () => {
    expect(type("P1000")).toBe("1000");
    expect(type("PS500")).toBe("500");
    expect(type("PS15")).toBe("5");
  });

  it("関係ない文字は無視する", () => {
    expect(type("A")).toBe("");
    expect(type("100A0")).toBe("1000");
  });

  it("PSコードの途中で文字が来たら破棄する", () => {
    expect(type("PS13A")).toBe("");
  });
});
