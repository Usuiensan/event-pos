import type { PrinterStatusObservation } from "@event-pos/contracts";
import type { PrintJobDto, PrintQueueStatusDto } from "./checkout-api.js";

export type PrintStatusView = { label: string; className: "pending" | "sending" | "completed" | "unknown" | "failed" | "retry" | "canceled" };

export function formatPrintStatus(job: PrintJobDto | null): PrintStatusView {
  if (!job) return { label: "印刷状態を取得中", className: "pending" };
  if (job.state === "completed") return { label: "送信完了", className: "completed" };
  if (job.state === "failed" && job.deliveryCertainty === "unknown") return { label: "結果不明（紙面を確認）", className: "unknown" };
  return ({
    pending: { label: "待機", className: "pending" },
    sending: { label: "送信中", className: "sending" },
    failed: { label: "失敗（未送信）", className: "failed" },
    retry_wait: { label: "再試行待ち", className: "retry" },
    canceled: { label: "取消", className: "canceled" },
  } as const)[job.state];
}

export type PrinterAlert = { kind: "cover_open" | "paper_out"; message: string };

// 実測できたプリンター異常だけをアラートにする。状態が未確認（unknown）の
// 間はアラートを出さない（F-057）。
export function printerAlert(observation: PrinterStatusObservation | null | undefined): PrinterAlert | null {
  if (!observation) return null;
  if (observation.coverOpen.support === "supported" && observation.coverOpen.value) return { kind: "cover_open", message: "プリンターカバーが開いています。閉めてから印刷してください。" };
  if (observation.paper.support === "supported" && observation.paper.value === "empty") return { kind: "paper_out", message: "プリンターの用紙切れです。用紙を補充してください。" };
  return null;
}

// device fault でキューが停止している場合に、理由つきで再開を促す文言を返す。
export function printQueueBlockMessage(queue: PrintQueueStatusDto | null | undefined): string | null {
  if (!queue?.blocked) return null;
  return `印刷キューが停止しています${queue.errorMessage ? `（${queue.errorMessage}）` : ""}。障害を取り除いてから「印刷を再開」を押してください。`;
}
