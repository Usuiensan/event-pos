import { describe, expect, it } from "vitest";
import { createErrorReportMailto, createSystemErrorReport, toPosSystemError } from "./error-report.js";

describe("システムエラー報告", () => {
  it("指定された宛先・件名・技術情報を含むmailtoを作成する", () => {
    const report = createSystemErrorReport("会計サーバーとの通信に失敗しました", new Error("network down"));
    const mailto = createErrorReportMailto(toPosSystemError(report, "会計サーバーとの通信に失敗しました"));
    expect(mailto).toContain("mailto:pos-error-report@usuiensan.dev?");
    expect(decodeURIComponent(mailto ?? "")).toContain(`POSシステムエラー報告[${report.errorId}]`);
    expect(decodeURIComponent(mailto ?? "")).toContain("Stack Trace\nError: network down");
    expect(decodeURIComponent(mailto ?? "")).toContain("Recent Logs\nError: network down");
  });
});
