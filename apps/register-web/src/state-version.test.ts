import { describe, expect, it } from "vitest";
import { shouldApplyDraft, shouldApplyProjection } from "./state-version.js";

describe("REST状態の巻き戻り防止", () => {
  it("遅れて届いた古いdraft versionを拒否する", () => {
    const current = { draftId: "draft-1", version: 5, createdAt: "2026-08-02T00:00:00.000Z" } as never;
    expect(shouldApplyDraft(current, { draftId: "draft-1", version: 4, createdAt: "2026-08-02T00:00:00.000Z" } as never)).toBe(false);
    expect(shouldApplyDraft(current, { draftId: "draft-1", version: 6, createdAt: "2026-08-02T00:00:00.000Z" } as never)).toBe(true);
  });

  it("低帯域で前後した顧客projectionをversionで拒否する", () => {
    expect(shouldApplyProjection(8, { version: 7 })).toBe(false);
    expect(shouldApplyProjection(8, { version: 8 })).toBe(true);
    expect(shouldApplyProjection(8, { version: 9 })).toBe(true);
  });
});
