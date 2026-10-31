export type StockTier = "normal" | "low" | "out";

export function stockTier(available: number): StockTier {
  if (available <= 0) return "out";
  if (available <= 5) return "low";
  return "normal";
}
