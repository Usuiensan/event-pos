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
});
