// レシートへ印字する日時は JST（UTC+9）の "YYYY-MM-DD HH:mm" で統一する。
export function formatJstDateTime(iso: string): string {
  return new Date(Date.parse(iso) + 9 * 3600_000).toISOString().slice(0, 16).replace("T", " ");
}
