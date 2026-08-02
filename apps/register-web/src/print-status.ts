import type { PrintJobDto } from "./checkout-api.js";

export type PrintStatusView = { label: string; className: "pending" | "sending" | "completed" | "unknown" | "failed" | "retry" | "canceled" };

export function formatPrintStatus(job: PrintJobDto | null): PrintStatusView {
  if (!job) return { label: "印刷状態を取得中", className: "pending" };
  if (job.state === "completed") return { label: "送信完了（紙面完了は未確認）", className: "completed" };
  if (job.state === "failed" && job.deliveryCertainty === "unknown") return { label: "結果不明（紙面を確認）", className: "unknown" };
  return ({
    pending: { label: "待機", className: "pending" },
    sending: { label: "送信中", className: "sending" },
    failed: { label: "失敗（未送信）", className: "failed" },
    retry_wait: { label: "再試行待ち", className: "retry" },
    canceled: { label: "取消", className: "canceled" },
  } as const)[job.state];
}
