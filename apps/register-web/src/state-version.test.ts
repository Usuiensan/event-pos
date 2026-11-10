import { describe, expect, it } from "vitest";
import { shouldApplyDraft, shouldApplyProjection } from "./state-version.js";

describe("REST状態の巻き戻り防止", () => {
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

  it("低帯域で前後した顧客projectionをversionで拒否する", () => {
    expect(shouldApplyProjection(8, { version: 7 })).toBe(false);
    expect(shouldApplyProjection(8, { version: 8 })).toBe(true);
    expect(shouldApplyProjection(8, { version: 9 })).toBe(true);
  });
});
