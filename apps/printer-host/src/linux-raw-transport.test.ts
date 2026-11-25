import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LinuxRawTransport } from "./linux-raw-transport.js";

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

describe("LinuxRawTransport", () => {
  it("writes bytes to a raw device path and closes it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "event-pos-printer-")); dirs.push(dir);
    const device = join(dir, "lp-test");
    await writeFile(device, new Uint8Array());
    const transport = new LinuxRawTransport(device, async () => "ready");
    expect(await transport.getStatus()).toMatchObject({ reachable: { support: "supported", value: true }, online: { support: "supported", value: true } });
    await expect(transport.send(new TextEncoder().encode("test-bytes"))).resolves.toMatchObject({ acceptedBytes: 10 });
    await transport.close();
    expect(await readFile(device, "utf8")).toBe("test-bytes");
  });

  it.each([
    { acceptedBytes: 0, closeFails: false },
    { acceptedBytes: 2, closeFails: false },
    { acceptedBytes: 2, closeFails: true },
  ])("書き込みが途切れたら結果不明として返す ($acceptedBytes bytes, closeFails=$closeFails)", async ({ acceptedBytes, closeFails }) => {
    const reportWrite = vi.fn();
    const transport = new LinuxRawTransport("unused", undefined, reportWrite);
    const write = vi.fn<() => Promise<{ bytesWritten: number }>>(async () => { throw Object.assign(new Error("USB切断"), { code: "ENODEV" }); });
    if (acceptedBytes) write.mockResolvedValueOnce({ bytesWritten: acceptedBytes });
    const close = vi.fn(async () => { if (closeFails) throw new Error("close failed"); });
    Reflect.get(transport, "session").handle = { write, close };

    await expect(transport.send(Uint8Array.of(1, 2, 3, 4))).rejects.toMatchObject({
      message: "USB切断", acceptedBytes, notSentProven: false, retryable: false,
    });
    expect(reportWrite).toHaveBeenLastCalledWith(acceptedBytes, 0, "ENODEV");
    expect(close).toHaveBeenCalledOnce();
  });

  it("デバイスを開けなかった場合は未送信として返す", async () => {
    const dir = await mkdtemp(join(tmpdir(), "event-pos-printer-")); dirs.push(dir);
    const transport = new LinuxRawTransport(join(dir, "missing-device"));
    await expect(transport.send(Uint8Array.of(1, 2))).rejects.toMatchObject({
      acceptedBytes: 0, notSentProven: true, retryable: true,
    });
  });

  it("converts status probe errors to unknown", async () => {
    const transport = new LinuxRawTransport("unused", async () => { throw new Error("probe failed"); });
    expect(await transport.getStatus()).toMatchObject({ reachable: { support: "unknown" }, online: { support: "unknown" } });
  });

  it("uses the same fixed BC-415M drawer pulse bytes as Windows", async () => {
    const dir = await mkdtemp(join(tmpdir(), "event-pos-printer-")); dirs.push(dir);
    const device = join(dir, "lp-drawer"); await writeFile(device, new Uint8Array()); const transport = new LinuxRawTransport(device, async () => "ready");
    await transport.send(Uint8Array.from([0x1b, 0x70, 0x00, 0x02, 0x14])); await transport.close();
    expect(Array.from(await readFile(device))).toEqual([0x1b, 0x70, 0x00, 0x02, 0x14]);
  });
});
