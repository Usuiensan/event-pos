import { ESCPOS_RENDERER_VERSION, ESCPOS_RENDERER_VERSION_ROTATE180, type EscPosRenderOptions } from "@event-pos/escpos";

export function receiptRotate180(): boolean {
  const value = process.env.RECEIPT_ROTATE_180?.trim().toLowerCase();
  return value === "1" || value === "true";
}

export function receiptRenderOptions(): EscPosRenderOptions {
  return { rotate180: receiptRotate180() };
}

export function receiptRendererVersion(): string {
  return receiptRotate180() ? ESCPOS_RENDERER_VERSION_ROTATE180 : ESCPOS_RENDERER_VERSION;
}
