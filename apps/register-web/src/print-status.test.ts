import { describe, expect, it } from "vitest";
import { formatPrintStatus } from "./print-status.js";

const job = { jobId: "job-1", transactionId: "tx-1" } as const;

describe("print status view", () => {
  it("未送信失敗と結果不明を明確に区別する", () => {
    expect(formatPrintStatus({ ...job, state: "failed", deliveryCertainty: "not_sent" })).toEqual({ label: "失敗（未送信）", className: "failed" });
    expect(formatPrintStatus({ ...job, state: "failed", deliveryCertainty: "unknown" })).toEqual({ label: "結果不明（紙面を確認）", className: "unknown" });
  });

  it("completedを紙面完了と誤表示せず、待機系状態も表示する", () => {
    expect(formatPrintStatus({ ...job, state: "completed", deliveryCertainty: "accepted" }).label).toBe("送信完了");
    expect(formatPrintStatus({ ...job, state: "retry_wait", deliveryCertainty: "not_sent" })).toEqual({ label: "再試行待ち", className: "retry" });
    expect(formatPrintStatus(null).label).toBe("印刷状態を取得中");
  });
});
