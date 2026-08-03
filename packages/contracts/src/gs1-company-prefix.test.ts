import { describe, expect, it } from "vitest";
import { gs1ProductCodeInfo, lookupGs1Company, validateGs1CompanyPrefixRegistry } from "./gs1-company-prefix.js";

describe("GS1事業者コード台帳", () => {
  const registry = validateGs1CompanyPrefixRegistry({ schemaVersion: 1, country: "JP", source: "test", sourceUrl: "https://example.invalid", records: [{ prefix: "4901234", companyName: "テスト株式会社", source: "test", lastVerifiedAt: "2026-08-03" }] });
  it("JAN/EAN-13は最長一致で企業情報を返す", () => {
    expect(lookupGs1Company(registry, "4901234567894")?.companyName).toBe("テスト株式会社");
    expect(gs1ProductCodeInfo(registry, "4901234567894")).toMatchObject({ codeType: "ean-13", gs1Prefix: "4901234", companyName: "テスト株式会社" });
  });
  it("台帳にないコードは種別だけ返す", () => expect(gs1ProductCodeInfo(registry, "4909999999999")).toEqual({ codeType: "ean-13" }));
  it("不正な台帳行を拒否する", () => expect(() => validateGs1CompanyPrefixRegistry({ schemaVersion: 1, country: "JP", source: "test", sourceUrl: "x", records: [{ prefix: "490", companyName: "短すぎる", source: "test" }] })).toThrow());
});
