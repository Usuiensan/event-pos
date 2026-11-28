import type { EventCatalog } from "@event-pos/contracts";
import { useState } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
import { AdminSettings, ensureEventDetails } from "./admin-settings.js";
import type { AuthActor } from "./checkout-api.js";

vi.mock("react", async (importOriginal) => {
  const react = await importOriginal<typeof import("react")>();
  return { ...react, useState: vi.fn(react.useState) };
});

afterEach(() => vi.unstubAllGlobals());

const actor: AuthActor = {
  authSessionId: "session-1",
  staffId: "staff-1",
  eventId: "event-1",
  responsibleNumber: "001",
  displayName: "担当者",
  role: "admin",
  terminalId: "management-console",
  csrfToken: "test-token",
};

const catalog: EventCatalog = ensureEventDetails({
  eventId: actor.eventId,
  departments: [{ departmentId: "001", code: "001", name: "書籍", settlementOwnerId: "001", enabled: true }],
  staffMembers: [{ staffId: actor.staffId, responsibleNumber: actor.responsibleNumber, displayName: actor.displayName, role: actor.role }],
  products: [{ productCode: "A001", name: "新刊", priceInclTax: 110, taxRate: 10, taxCategory: "inclusive_10", saleState: "on_sale", tabId: "books" }],
  productTabs: [{ id: "books", label: "書籍タブ", color: "#123456" }],
  quickEntries: [{ id: "quick-1", label: "新刊セット", tabId: "books", components: [{ productCode: "A001", quantity: 2 }] }],
  autoDiscountRules: [{ id: "discount-1", label: "セット値引き", discountYen: 10, priority: 1, requiredProducts: [{ productCode: "A001", quantity: 2 }] }],
  customerWelcome: { circleName: "サークル", space: "A-01", message: "いらっしゃいませ" },
});

function render(section: string, businessOpen: boolean) {
  vi.stubGlobal("window", { location: { search: "", port: "" } });
  // 読み込み後の表示に必要な先頭の状態だけを差し替える。
  vi.mocked(useState)
    .mockReturnValueOnce([actor, vi.fn()])
    .mockReturnValueOnce(["", vi.fn()])
    .mockReturnValueOnce([catalog, vi.fn()])
    .mockReturnValueOnce([section, vi.fn()])
    .mockReturnValueOnce(["", vi.fn()])
    .mockReturnValueOnce([businessOpen, vi.fn()]);
  return renderToStaticMarkup(<AdminSettings eventId={actor.eventId} />);
}

function labelledControl(label: string, tag = "input") {
  return new RegExp(`<label>${label}(?:<span[^>]*>)?(<${tag}\\b[^>]*>)`);
}

const cases = [
  { section: "event", title: "イベント・部門", fields: {
    イベント名: labelledControl("イベント名"),
    営業日: labelledControl("営業日"),
    サークル名: labelledControl("サークル名"),
    スペース: labelledControl("スペース"),
    部門名: labelledControl("部門名"),
    有効: /<label>(<input\b[^>]*\btype="checkbox"[^>]*>)有効<\/label>/,
  } },
  { section: "staff", title: "スタッフ・権限", fields: {
    責任者番号: /(<input\b[^>]*\baria-label="責任者番号"[^>]*>)/,
    表示名: /(<input\b[^>]*\bvalue="担当者"[^>]*>)/,
    レシート表示: /(<select\b[^>]*\baria-label="レシート表示"[^>]*>)/,
    権限: /(<select\b[^>]*>)<option value="operator"/,
  } },
  { section: "screen", title: "商品タブ・クイック登録", fields: {
    タブID: labelledControl("タブID"),
    商品タブの表示名: /(<input\b[^>]*\bvalue="書籍タブ"[^>]*>)/,
    色: labelledControl("色"),
    クイック登録の表示名: /(<input\b[^>]*\bvalue="新刊セット"[^>]*>)/,
    表示タブ: labelledControl("表示タブ", "select"),
    構成商品の数量: labelledControl("数量"),
  } },
  { section: "discounts", title: "自動値引き", fields: {
    名称: labelledControl("名称"),
    値引額: labelledControl("値引額"),
    優先度: labelledControl("優先度"),
    対象商品の数量: labelledControl("数量"),
  } },
  { section: "customer", title: "顧客表示", fields: {
    サークル名: labelledControl("サークル名"),
    スペース: labelledControl("スペース"),
    メッセージ: labelledControl("メッセージ", "textarea"),
  } },
  { section: "products", title: "商品マスタ", fields: {
    商品コード: labelledControl("商品コード"),
    商品名: labelledControl("商品名編集"),
    価格: labelledControl("税込価格"),
    価格区分: labelledControl("価格区分", "select"),
    税率: labelledControl("税率", "select"),
    タブ: labelledControl("タブ", "select"),
    販売状態: labelledControl("販売状態", "select"),
  } },
] satisfies Array<{ section: string; title: string; fields: Record<string, RegExp> }>;

it.each(cases)("$title の各編集欄は営業中に無効、未開局時に有効になる", ({ section, fields }) => {
  const markup = [render(section, true), render(section, false)];
  for (const [name, control] of Object.entries(fields)) {
    const disabled = markup.map((html) => {
      const tag = html.match(control)?.[1];
      return tag && /\sdisabled(?:[=\s/>])/.test(tag);
    });
    expect.soft(disabled, name).toEqual([true, false]);
  }
});
