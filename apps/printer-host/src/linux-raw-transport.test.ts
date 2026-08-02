import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LinuxRawTransport } from "./linux-raw-transport.js";

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

describe("LinuxRawTransport", () => {
  it("writes bytes to a raw device path and closes it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "event-pos-printer-")); dirs.push(dir);
    const device = join(dir, "lp-test");
    const transport = new LinuxRawTransport(device, async () => "ready");
    expect(await transport.getStatus()).toMatchObject({ reachable: { support: "supported", value: true }, online: { support: "supported", value: true } });
    await transport.send(new TextEncoder().encode("test-bytes"));
    await transport.close();
    expect(await readFile(device, "utf8")).toBe("test-bytes");
  });

  it("converts status probe errors to unknown", async () => {
    const transport = new LinuxRawTransport("unused", async () => { throw new Error("probe failed"); });
    expect(await transport.getStatus()).toMatchObject({ reachable: { support: "unknown" }, online: { support: "unknown" } });
  });
});
