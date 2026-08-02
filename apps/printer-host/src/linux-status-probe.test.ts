import { describe, expect, it } from "vitest";
import { probeLinuxDleEot } from "./linux-status-probe.js";

describe("Linux DLE EOT raw status probe", () => {
  it("存在しないdeviceでも応答なしをreadyに変換しない", async () => {
    const result = await probeLinuxDleEot("does-not-exist", 1);
    expect(result).toHaveLength(4);
    expect(result.every((item) => item.normalized === "unknown" && item.responseHex === null && item.requestHex.startsWith("1004"))).toBe(true);
  });
});
