import { stockTier } from "./stock.js";

export type StockDisplaySettings = {
  showNumber: boolean;
  showSymbol: boolean;
  colorize: boolean;
};

export const defaultStockDisplaySettings: StockDisplaySettings = {
  showNumber: true,
  showSymbol: true,
  colorize: true,
};

export function stockDisplaySettingsStorageKey(registerNumber: number): string {
  return `event-pos-register-${registerNumber}-stock-display-settings`;
}

export function normalizeStockDisplaySettings(value: Partial<StockDisplaySettings> | null | undefined): StockDisplaySettings {
  return {
    showNumber: typeof value?.showNumber === "boolean" ? value.showNumber : defaultStockDisplaySettings.showNumber,
    showSymbol: typeof value?.showSymbol === "boolean" ? value.showSymbol : defaultStockDisplaySettings.showSymbol,
    colorize: typeof value?.colorize === "boolean" ? value.colorize : defaultStockDisplaySettings.colorize,
  };
}

export function loadStockDisplaySettings(registerNumber: number): StockDisplaySettings {
  try {
    return normalizeStockDisplaySettings(JSON.parse(localStorage.getItem(stockDisplaySettingsStorageKey(registerNumber)) ?? "null") as Partial<StockDisplaySettings> | null);
  } catch {
    return defaultStockDisplaySettings;
  }
}

export function storeStockDisplaySettings(registerNumber: number, settings: StockDisplaySettings): void {
  localStorage.setItem(stockDisplaySettingsStorageKey(registerNumber), JSON.stringify(normalizeStockDisplaySettings(settings)));
}

export function stockIndicatorText(available: number, settings: StockDisplaySettings): string | null {
  const parts: string[] = [];
  if (settings.showSymbol) parts.push(stockTier(available) === "normal" ? "○" : stockTier(available) === "low" ? "△" : "×");
  if (settings.showNumber) parts.push(`残${Math.max(0, available)}`);
  return parts.length > 0 ? parts.join(" ") : null;
}

export function stockToneClass(available: number, settings: StockDisplaySettings): "stock-low" | "stock-out" | null {
  if (!settings.colorize) return null;
  const tier = stockTier(available);
  return tier === "low" ? "stock-low" : tier === "out" ? "stock-out" : null;
}
