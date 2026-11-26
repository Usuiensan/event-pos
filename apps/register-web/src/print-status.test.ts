import { describe, expect, it } from "vitest";
import type { PrinterStatusObservation } from "@event-pos/contracts";
import { formatPrintStatus, printQueueBlockMessage, printerAlert } from "./print-status.js";

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

const unknown = { support: "unknown", reason: "未取得" } as const;
const observation = (overrides: Partial<PrinterStatusObservation> = {}): PrinterStatusObservation => ({
  observedAt: "2026-08-02T00:00:00.000Z",
  reachable: { support: "supported", value: true },
  online: { support: "supported", value: true },
  coverOpen: { support: "supported", value: false },
  drawerOpen: unknown,
  paper: { support: "supported", value: "ok" },
  error: { support: "supported", value: "none" },
  raw: null,
  ...overrides,
});

describe("printer alert (F-057)", () => {
  it("カバーオープンと用紙切れで、理由の分かるアラートを返す", () => {
    expect(printerAlert(observation({ coverOpen: { support: "supported", value: true } }))).toEqual({ kind: "cover_open", message: "プリンターカバーが開いています。閉めてから印刷してください。" });
    expect(printerAlert(observation({ paper: { support: "supported", value: "empty" } }))).toEqual({ kind: "paper_out", message: "プリンターの用紙切れです。用紙を補充してください。" });
  });

  it("正常時と状態未確認の間はアラートを出さない", () => {
    expect(printerAlert(observation())).toBeNull();
    expect(printerAlert(observation({ coverOpen: unknown, paper: unknown }))).toBeNull();
    expect(printerAlert(observation({ paper: { support: "supported", value: "near_end" } }))).toBeNull();
    expect(printerAlert(null)).toBeNull();
    expect(printerAlert(undefined)).toBeNull();
  });

  it("キュー停止中だけ、理由つきの再開案内を返す", () => {
    expect(printQueueBlockMessage({ blocked: true, blockReason: "device_fault", jobId: "job-1", errorMessage: "用紙切れのため送信できません", waitingJobs: 2 })).toBe("印刷キューが停止しています（用紙切れのため送信できません）。障害を取り除いてから「印刷を再開」を押してください。");
    expect(printQueueBlockMessage({ blocked: true, blockReason: "device_fault", jobId: "job-1", errorMessage: null, waitingJobs: 1 })).toBe("印刷キューが停止しています。障害を取り除いてから「印刷を再開」を押してください。");
    expect(printQueueBlockMessage({ blocked: false, blockReason: null, jobId: null, errorMessage: null, waitingJobs: 0 })).toBeNull();
    expect(printQueueBlockMessage(null)).toBeNull();
    expect(printQueueBlockMessage(undefined)).toBeNull();
  });
});
