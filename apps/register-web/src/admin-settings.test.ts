import { describe, expect, it } from "vitest";
import { validGtin, validateGs1CompanyPrefixRegistry } from "@event-pos/contracts";
import { buildProductNameCandidates, createNewProductDraft, ensureEventDetails, newDepartment, newProductTab, nextDepartmentId, nextProductTabId, nextProductCode, productFromNewProductDraft, syncProductGs1, validateNewProductDraft } from "./admin-settings.js";

describe("商品名候補の整理", () => {
  it("重複語と販売者ノイズを除き、短い候補を生成する", () => {
    const candidates = buildProductNameCandidates([{ name: "パイロット 万年筆用インキ INK-30BB ブルーブラック 30ml ハンズ", source: "test", strength: "strong", reason: "test" }, { name: "PILOT 万年筆専用インク INK30BB ブルーブラック", source: "test", strength: "medium", reason: "test" }], "4902505140518");
    expect(candidates[0]).toContain("INK");
    expect(candidates.join(" ")).not.toContain("ハンズ");
    expect(candidates.length).toBeLessThanOrEqual(3);
  });
});

describe("管理画面の部門採番", () => {
  it("未使用の3桁連番を採番する", () => {
    expect(nextDepartmentId([])).toBe("001");
    expect(nextDepartmentId([{ departmentId: "001", code: "001", name: "青果", settlementOwnerId: "001", enabled: true }, { departmentId: "003", code: "003", name: "書籍", settlementOwnerId: "003", enabled: true }])).toBe("002");
  });

  it("新規部門は内部IDを表示名から分離する", () => {
    expect(newDepartment([])).toEqual({ departmentId: "001", code: "001", name: "新しい部門", settlementOwnerId: "001", enabled: true });
  });
});

describe("管理画面の商品タブ採番", () => {
  it("未使用のtab連番を採番する", () => {
    expect(nextProductTabId([])).toBe("tab-1");
    expect(nextProductTabId([{ id: "tab-1", label: "新刊" }, { id: "tab-3", label: "既刊" }])).toBe("tab-2");
  });

  it("tab形式でない既存IDとも重複しない", () => {
    expect(nextProductTabId([{ id: "books", label: "書籍" }])).toBe("tab-1");
  });

  it("新規商品タブを既定値で生成する", () => {
    expect(newProductTab([])).toEqual({ id: "tab-1", label: "新しいタブ" });
  });
});

describe("管理画面のイベント情報補完", () => {
  it("旧DBにeventがなくても編集可能な初期値を用意する", () => {
    const result = ensureEventDetails({ eventId: "event-1", products: [], quickEntries: [] });
    expect(result.event).toEqual({ name: "event-1", businessDate: "1970-01-01", seller: { circleName: "", space: "", receiptIssuerName: "" }, locale: { language: "ja-JP", currency: "JPY", timezone: "Asia/Tokyo" } });
  });
});

describe("商品データ新規登録", () => {
  const catalog = { eventId: "event-1", products: [], quickEntries: [], productTabs: [{ id: "tab-1", label: "新刊" }], departments: [{ departmentId: "001", code: "001", name: "書籍", settlementOwnerId: "001", enabled: true }] };

  it("既存コードと必須項目を検証する", () => {
    const draft = createNewProductDraft(catalog);
    expect(validateNewProductDraft([], draft)).toBe("商品コードを入力してください。");
    draft.productCode = "A001";
    draft.name = "新刊";
    expect(validateNewProductDraft([{ productCode: "A001", name: "既存", priceInclTax: 100, taxRate: 10, taxCategory: "inclusive_10", saleState: "on_sale" }], draft)).toBe("商品コード「A001」は登録済みです。");
  });

  it("税込・税抜価格と初期のタブ、部門を商品定義へ変換する", () => {
    const product = productFromNewProductDraft({ ...createNewProductDraft(catalog), productCode: "A002", name: "新刊", priceInput: 100, priceMode: "excluded", taxRate: 10 });
    expect(product).toMatchObject({ productCode: "A002", name: "新刊", priceInclTax: 110, priceExclTax: 100, taxCategory: "exclusive_10", tabId: "tab-1", departmentId: "001" });
  });
});

describe("000始まりの商品コード自動付番", () => {
  it("先頭000の8桁コードを発行し、GTINチェックデジットが有効", () => {
    const code = nextProductCode([]);
    expect(code).toBe("00000017");
    expect(code).toMatch(/^000\d{5}$/);
    expect(validGtin(code)).toBe(true);
  });

  it("使用済みコードを飛ばす", () => {
    expect(nextProductCode([{ productCode: "00000017", name: "商品", priceInclTax: 0, taxRate: 0, taxCategory: "exempt", saleState: "on_sale" }])).toBe("00000024");
  });
});

describe("商品コードとGS1情報の同期", () => {
  const registry = validateGs1CompanyPrefixRegistry({ schemaVersion: 1, country: "JP", source: "test", sourceUrl: "https://example.invalid", records: [{ prefix: "4901234", companyName: "テスト株式会社", source: "test" }] });

  it("有効なコードではGS1情報を設定し、不正なコードでは削除する", () => {
    const product = { productCode: "old", name: "商品", priceInclTax: 0, taxRate: 0, taxCategory: "exempt" as const, saleState: "on_sale" as const, gs1: { codeType: "ean-13" as const } };
    syncProductGs1(product, registry, "4901234567894");
    expect(product.gs1).toMatchObject({ codeType: "ean-13", gs1Prefix: "4901234", companyName: "テスト株式会社" });
    syncProductGs1(product, registry, "invalid");
    expect(product.gs1).toBeUndefined();
  });
});
