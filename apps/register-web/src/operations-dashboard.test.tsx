import { useState } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import type { OperationsDashboardDto } from "./checkout-api.js";
import { OperationsDashboard } from "./operations-dashboard.js";

vi.mock("react", async (importOriginal) => {
  const react = await importOriginal<typeof import("react")>();
  return { ...react, useState: vi.fn(react.useState) };
});

it("同じ現金箱の2回目の準備金を確定すると、その行の開局だけが済になる（F-055）", () => {
  const cashboxId = "register-1";
  const createdAt = "2026-08-03T01:00:00Z";
  const storage = { state: "unknown" as const, path: null, freeBytes: null, totalBytes: null, reason: null };
  const data: Omit<OperationsDashboardDto, "cash"> = {
    observedAt: createdAt,
    database: { state: "ready", reason: null },
    printerHost: { connected: null, observation: { observedAt: createdAt } },
    printJobs: { pending: 0, failed: 0, unknown: 0, lastSuccessfulAt: null },
    storage: { database: storage, artifacts: storage },
    lastBackup: null,
    holds: { closingBlockers: [], confirmationRequired: [] },
    registers: [],
  };
  const first = { sessionId: "first", cashboxId, state: "closed", openingYen: 0, closingYen: 0 };
  const second = { sessionId: "second", cashboxId, state: "preparing", openingYen: null, closingYen: null };
  const firstChecks = ["opening", "interim", "closing"].map((kind) => ({ sessionId: first.sessionId, cashboxId, kind, createdAt }));
  const render = (cash: OperationsDashboardDto["cash"]) => {
    vi.mocked(useState).mockReturnValueOnce([{ ...data, cash }, vi.fn()]);
    return renderToStaticMarkup(<OperationsDashboard
      eventId="event" businessDate="2026-08-03" actorId="002" onClose={vi.fn()}
      backupArtifacts={[]} backupArtifactsLoading={false} backupArtifactsError="" onRegenerateBackupArtifact={vi.fn()}
    />);
  };
  const row = (opening: string, interim: string, closing: string) =>
    `<div><strong>${cashboxId}</strong><span>開局 ${opening}</span><span>中間点検 ${interim}</span><span>精算 ${closing}</span></div>`;

  const preparing = render({ sessions: [first, second], checks: firstChecks });
  expect(preparing).toContain(row("済", "済", "済") + row("未", "未", "未"));

  const opened = render({
    sessions: [first, { ...second, state: "open", openingYen: 0 }],
    checks: [...firstChecks, { sessionId: second.sessionId, cashboxId, kind: "opening", createdAt }],
  });
  expect(opened).toContain(row("済", "済", "済") + row("済", "未", "未"));
});
