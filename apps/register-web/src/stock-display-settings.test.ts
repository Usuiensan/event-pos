import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultStockDisplaySettings, loadStockDisplaySettings, normalizeStockDisplaySettings, stockDisplaySettingsStorageKey, stockIndicatorText, stockToneClass, storeStockDisplaySettings } from "./stock-display-settings.js";

afterEach(() => vi.unstubAllGlobals());

describe("在庫表示設定", () => {
  it("既定値は全てオンで、boolean以外と欠落は既定値へ戻る", () => {
    expect(defaultStockDisplaySettings).toEqual({ showNumber: true, showSymbol: true, colorize: true });
    expect(normalizeStockDisplaySettings({ showNumber: false, showSymbol: "yes" as unknown as boolean })).toEqual({ showNumber: false, showSymbol: true, colorize: true });
    expect(normalizeStockDisplaySettings(null)).toEqual(defaultStockDisplaySettings);
  });

  it("レジ番号別に保存・復元する", () => {
    const values = new Map<string, string>();
    vi.stubGlobal("localStorage", { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) });
    const settings = { showNumber: false, showSymbol: true, colorize: false };
    storeStockDisplaySettings(2, settings);
    expect(values.has(stockDisplaySettingsStorageKey(2))).toBe(true);
    expect(loadStockDisplaySettings(2)).toEqual(settings);
  });

  it("在庫表示の文字列を設定に応じて作る", () => {
    expect(stockIndicatorText(10, { showNumber: true, showSymbol: true, colorize: true })).toBe("○ 残10");
    expect(stockIndicatorText(10, { showNumber: true, showSymbol: false, colorize: true })).toBe("残10");
    expect(stockIndicatorText(10, { showNumber: false, showSymbol: true, colorize: true })).toBe("○");
    expect(stockIndicatorText(10, { showNumber: false, showSymbol: false, colorize: true })).toBeNull();
    expect(stockIndicatorText(3, { showNumber: true, showSymbol: true, colorize: true })).toBe("△ 残3");
    expect(stockIndicatorText(0, { showNumber: true, showSymbol: true, colorize: true })).toBe("× 残0");
    expect(stockIndicatorText(-2, { showNumber: true, showSymbol: true, colorize: true })).toBe("× 残0");
  });

  it("色変更のクラスを設定に応じて作る", () => {
    const colorized = { showNumber: true, showSymbol: true, colorize: true };
    expect(stockToneClass(3, colorized)).toBe("stock-low");
    expect(stockToneClass(0, colorized)).toBe("stock-out");
    expect(stockToneClass(10, colorized)).toBeNull();
    expect(stockToneClass(3, { ...colorized, colorize: false })).toBeNull();
    expect(stockToneClass(0, { ...colorized, colorize: false })).toBeNull();
    expect(stockToneClass(10, { ...colorized, colorize: false })).toBeNull();
  });
});
