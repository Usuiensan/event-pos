import { describe, expect, it } from "vitest";
import { classifyScan, nextInputBuffer, scanRouteFor } from "./scan-routing.js";

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

  it("受付番号10桁化後の16桁バーコード（日付6桁+受付番号10桁）も取引として取り込む", () => {
    expect(classifyScan(type("PS142608021000000015"))).toEqual({ kind: "transaction", reference: "1000000015", businessDate: "2026-08-02" });
    expect(classifyScan(type("2608021000000015"))).toEqual({ kind: "transaction", reference: "1000000015", businessDate: "2026-08-02" });
  });

  it("文字で始まるコードは記号も含めてそのまま取り込む", () => {
    expect(type("ABC-1234")).toBe("ABC-1234");
    expect(classifyScan(type("ABC-1234"))).toEqual({ kind: "product", raw: "ABC-1234" });
    expect(type("cpn:XYZ/2026")).toBe("cpn:XYZ/2026");
  });

  it("通常の数字入力はそのまま貯める", () => {
    expect(type("1000")).toBe("1000");
    expect(type("4901002004")).toBe("4901002004");
  });

  it("数字入力中の文字は無視して金額を守る", () => {
    expect(type("100A0")).toBe("1000");
    expect(type("50-0")).toBe("500");
  });
});

describe("scanRouteFor", () => {
  it("コードは会計途中でもスキャンとして処理する", () => {
    expect(scanRouteFor("PS1310000012", { checkoutLocked: false, total: 500 })).toBe("barcode");
    expect(scanRouteFor("ABC-1234", { checkoutLocked: false, total: 500 })).toBe("barcode");
  });

  it("短いコード入力は誤入力として捨てる", () => {
    expect(scanRouteFor("AB", { checkoutLocked: false, total: 500 })).toBe("discard");
    expect(scanRouteFor("P", { checkoutLocked: false, total: 0 })).toBe("discard");
  });

  it("数字だけの入力は従来どおり振り分ける", () => {
    expect(scanRouteFor("1000", { checkoutLocked: false, total: 500 })).toBe("payment");
    expect(scanRouteFor("1000", { checkoutLocked: false, total: 0 })).toBe("barcode");
    expect(scanRouteFor("1000", { checkoutLocked: true, total: 500 })).toBe("barcode");
    expect(scanRouteFor("4901002004", { checkoutLocked: false, total: 500 })).toBe("barcode");
  });
});
