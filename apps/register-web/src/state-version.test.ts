import { describe, expect, it } from "vitest";
import type { CheckoutDraft } from "./checkout-api.js";
import { draftMatchesBusiness, projectionSessionSwitch, shouldApplyDraft, shouldApplyProjection } from "./state-version.js";

describe("REST状態の巻き戻り防止", () => {
  it("開局中の同じイベント・営業日・セッション番号の下書きだけを引き継ぐ", () => {
    const draft = { eventId: "event", businessDate: "2026-08-03", sessionNo: 1 };
    const business = { ...draft, state: "open" } as const;
    expect(draftMatchesBusiness(draft, business)).toBe(true);
    for (const change of [{ eventId: "other" }, { businessDate: "2026-08-04" }, { sessionNo: 2 }, { state: "closed" }] as const) {
      expect(draftMatchesBusiness(draft, { ...business, ...change })).toBe(false);
    }
    expect(draftMatchesBusiness(draft, null)).toBe(false);
  });
  it("終端状態から古いアクティブdraftへの呼戻しを適用する", () => {
    const current = { draftId: "draft-current", state: "canceled", createdAt: "2026-08-03T00:00:00.000Z" } as never;
    const incoming = { draftId: "draft-parked", state: "editing", createdAt: "2026-08-02T00:00:00.000Z" } as never;
    expect(shouldApplyDraft(current, incoming)).toBe(true);
  });

  it("古い別draftは従来どおり拒否する", () => {
    const current = { draftId: "draft-current", state: "editing", createdAt: "2026-08-03T00:00:00.000Z" } as never;
    const incoming = { draftId: "draft-old", state: "editing", createdAt: "2026-08-02T00:00:00.000Z" } as never;
    expect(shouldApplyDraft(current, incoming)).toBe(false);
  });

  it("遅れて届いた古いdraft versionを拒否する", () => {
    const current = { draftId: "draft-1", state: "editing", version: 5, createdAt: "2026-08-02T00:00:00.000Z" } as never;
    expect(shouldApplyDraft(current, { draftId: "draft-1", state: "editing", version: 4, createdAt: "2026-08-02T00:00:00.000Z" } as never)).toBe(false);
    expect(shouldApplyDraft(current, { draftId: "draft-1", state: "editing", version: 6, createdAt: "2026-08-02T00:00:00.000Z" } as never)).toBe(true);
  });

  it.each(["canceled", "completed"] as const)("呼戻した会計の確定前後に別下書き (%s) が届いても表示を維持する", (state) => {
    const payment = { draftId: "recalled", state: "payment", version: 6, createdAt: "2026-08-02T00:00:00.000Z" } as CheckoutDraft;
    const completed = { ...payment, state: "completed", version: 7 } as const;
    const other = { draftId: "other", state, version: 3, createdAt: "2026-08-03T00:00:00.000Z" } as CheckoutDraft;

    expect(shouldApplyDraft(payment, other)).toBe(false);
    expect(shouldApplyDraft(payment, completed)).toBe(true);
    expect(shouldApplyDraft(completed, other)).toBe(false);
  });

  it("会計完了後に届いた同じ下書きの支払中応答を拒否する", () => {
    const payment = { draftId: "recalled", state: "payment", version: 6, createdAt: "2026-08-02T00:00:00.000Z" } as CheckoutDraft;
    const completed = { ...payment, state: "completed", version: 7 } as const;

    expect(shouldApplyDraft(completed, payment)).toBe(false);
  });

  it("低帯域で前後した顧客projectionをversionで拒否する", () => {
    expect(shouldApplyProjection(8, { version: 7 })).toBe(false);
    expect(shouldApplyProjection(8, { version: 8 })).toBe(true);
    expect(shouldApplyProjection(8, { version: 9 })).toBe(true);
  });

  it("顧客projectionは営業の切り替えで基準をリセットし、遅れた前営業の応答を捨てる (F-087)", () => {
    const first = { cashSessionId: "checkout:event:2026-08-02:register-1", sessionOrder: "2026-08-02:000001" };
    const second = { cashSessionId: "checkout:event:2026-08-02:2:register-1", sessionOrder: "2026-08-02:000002" };
    expect(projectionSessionSwitch(null, first)).toBe("newer");
    expect(projectionSessionSwitch(first, first)).toBe("same");
    expect(projectionSessionSwitch(first, second)).toBe("newer");
    expect(projectionSessionSwitch(second, first)).toBe("older");
    expect(projectionSessionSwitch(first, {})).toBe("unknown");
    expect(projectionSessionSwitch(null, {})).toBe("unknown");
  });
});
