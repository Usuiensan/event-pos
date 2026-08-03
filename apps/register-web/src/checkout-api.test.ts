import { afterEach, describe, expect, it, vi } from "vitest";
import { CheckoutApiError, checkoutApi } from "./checkout-api.js";

afterEach(() => vi.unstubAllGlobals());

describe("checkout API client", () => {
  it("sends draft version and idempotency headers", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ transactionId: "tx-1" }) });
    vi.stubGlobal("fetch", fetchMock);
    await checkoutApi.finalize("draft-1", 7, "key-1");
    expect(fetchMock).toHaveBeenCalledWith("/api/v1/sale-drafts/draft-1/finalize", expect.objectContaining({ method: "POST", headers: expect.objectContaining({ "idempotency-key": "key-1" }), body: JSON.stringify({ version: 7 }) }));
  });

  it("preserves the server error code for the existing error modal", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 422, json: async () => ({ error: { code: "PAYMENT_INSUFFICIENT", message: "預り金が不足しています", details: { expectedYen: 500 } } }) }));
    await expect(checkoutApi.addPayment("draft-1", 2, { kind: "cash", amountYen: 500, tenderedYen: 100 })).rejects.toMatchObject({ code: "PAYMENT_INSUFFICIENT", message: "預り金が不足しています" } satisfies Partial<CheckoutApiError>);
  });

  it("成果物再生成へ責任者と冪等キーを送る", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ artifactId: "artifact-2" }) });
    vi.stubGlobal("fetch", fetchMock);
    await checkoutApi.regenerateBackupArtifact("artifact-1", "001", "retry-1");
    expect(fetchMock).toHaveBeenCalledWith("/api/v1/backup-artifacts/artifact-1/regenerate", expect.objectContaining({ method: "POST", headers: expect.objectContaining({ "x-pos-role": "manager", "x-pos-actor-id": "001", "idempotency-key": "retry-1" }) }));
  });

  it("現金点検へ責任者と冪等キーを送る", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ check: { kind: "closing" }, printJobId: "job-1" }) });
    vi.stubGlobal("fetch", fetchMock);
    await checkoutApi.saveCashCheck("checkout:event:2026-08-03:register-1", "closing", { counted: [{ denomination: 1000, quantity: 3 }], carryoverYen: 1000, terminalId: "register-1" }, "001", "closing-1");
    expect(fetchMock).toHaveBeenCalledWith("/api/v1/cash-sessions/checkout%3Aevent%3A2026-08-03%3Aregister-1/checks/closing", expect.objectContaining({ method: "POST", headers: expect.objectContaining({ "x-pos-role": "manager", "x-pos-actor-id": "001", "idempotency-key": "closing-1" }) }));
  });

  it("全部返品へ扱い者と冪等キーを送りroleでは制限しない", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ transactionId: "return-1" }) }); vi.stubGlobal("fetch", fetchMock);
    await checkoutApi.createFullReturn("sale-1", { cashSessionId: "cash-1", terminalId: "register-1", reason: "商品不良" }, "001", "return-key-1");
    expect(fetchMock).toHaveBeenCalledWith("/api/v1/transactions/sale-1/full-return", expect.objectContaining({ method: "POST", headers: expect.objectContaining({ "x-pos-actor-id": "001", "idempotency-key": "return-key-1" }) }));
    expect(fetchMock.mock.calls[0]?.[1]?.headers).not.toHaveProperty("x-pos-role");
  });
});
