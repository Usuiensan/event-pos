export function ageSkipRemainingSeconds(requestedAt: string, nowMs = Date.now()): number {
  return Math.max(0, Math.ceil((10_000 - (nowMs - Date.parse(requestedAt))) / 1_000));
}

export function canSkipCustomerAgeConfirmation(customerAvailable: boolean, requestedAt: string | null, nowMs = Date.now()): boolean {
  if (!customerAvailable) return true;
  return requestedAt !== null && ageSkipRemainingSeconds(requestedAt, nowMs) === 0;
}
