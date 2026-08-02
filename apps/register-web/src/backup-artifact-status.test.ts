import { describe, expect, it } from "vitest";
import { formatBackupArtifactStatus } from "./backup-artifact-status.js";

describe("backup artifact status", () => {
  it.each([
    ["pending", "生成待ち", "pending"], ["generating", "生成中", "generating"], ["completed", "成功", "completed"], ["failed", "失敗", "failed"],
  ] as const)("%sを明示的な日本語状態へ変換する", (state, label, className) => {
    expect(formatBackupArtifactStatus({ state })).toMatchObject({ label, className });
  });

  it("失敗理由を表示文へ保持する", () => {
    expect(formatBackupArtifactStatus({ state: "failed", errorMessage: "保存先の空き容量が不足しています" }).description).toBe("保存先の空き容量が不足しています");
  });
});
