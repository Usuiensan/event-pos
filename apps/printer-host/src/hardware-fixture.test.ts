import { describe, expect, it } from "vitest";
import { buildHardwareFixture } from "./hardware-fixture.js";

describe("TM-T70II parity hardware fixture", () => {
  it("同じcanonical IRとbytesを決定的に生成し、禁止commandを含まない", () => {
    const first = buildHardwareFixture(); const second = buildHardwareFixture();
    expect(first.canonicalIr).toBe(second.canonicalIr);
    expect(first.bytesSha256).toBe(second.bytesSha256);
    expect(first.canonicalIr).toContain("!barcode");
    expect(first.canonicalIr).toContain("!feed 3");
    expect(first.canonicalIr).toContain('!cut "partial"');
    expect(first.canonicalIr).not.toMatch(/^!(drawer|buzzer|nv|setting)\b/m);
    expect(first.canonicalIr).not.toContain('!cut "full"');
  });
});
