export function normalizeResponsibleNumber(input: string): string | null {
  const value = input.trim();
  return /^\d{1,3}$/.test(value) ? value.padStart(3, "0") : null;
}
