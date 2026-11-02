export function normalizeResponsibleNumber(input: string): string | null {
  const value = input.trim().replace(/[０-９]/g, (digit) => String.fromCharCode(digit.charCodeAt(0) - 0xfee0));
  return /^\d{1,3}$/.test(value) ? value.padStart(3, "0") : null;
}
