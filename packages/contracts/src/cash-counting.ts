export const cashDenominations = [1, 5, 10, 50, 100, 500, 1000, 2000, 5000, 10000] as const;
export type CashDenomination = typeof cashDenominations[number];
export type CashCount = { denomination: CashDenomination; quantity: number };
export type CashCheckKind = "opening" | "interim" | "closing";
export type CashCheck = { sessionId: string; kind: CashCheckKind; counted: CashCount[]; theoreticalYen: number; carryoverYen?: number; countedYen: number; differenceYen: number; createdAt: string };

export function calculateCashActual(counted: CashCount[]): number {
  const seen = new Set<number>();
  return counted.reduce((total, item) => {
    if (!cashDenominations.includes(item.denomination) || !Number.isSafeInteger(item.quantity) || item.quantity < 0 || seen.has(item.denomination)) throw new Error("現金実査の金種または枚数が不正です");
    seen.add(item.denomination); return total + item.denomination * item.quantity;
  }, 0);
}

export function createCashCheck(input: Omit<CashCheck, "countedYen" | "differenceYen" | "createdAt"> & { createdAt?: string }): CashCheck {
  if (!input.sessionId || !Number.isSafeInteger(input.theoreticalYen) || input.theoreticalYen < 0) throw new Error("現金実査のセッションまたは理論有高が不正です");
  const countedYen = calculateCashActual(input.counted);
  const carryoverYen = input.carryoverYen ?? 0;
  if (!Number.isSafeInteger(carryoverYen) || carryoverYen < 0) throw new Error("翌日残し額が不正です");
  if (input.kind === "closing" && carryoverYen > countedYen) throw new Error("翌日残し額が実査額を超えています");
  return { ...input, carryoverYen, countedYen, differenceYen: countedYen - input.theoreticalYen, createdAt: input.createdAt ?? new Date().toISOString() };
}
