import { open } from "node:fs/promises";

export type RawStatusObservation = {
  requestHex: string;
  responseHex: string | null;
  normalized: "unknown";
  timeoutMs: number;
  error?: string;
};

/**
 * Sends only DLE EOT n (n=1..4), which is the ESC/POS real-time status request.
 * This is intentionally a probe: no response, transport error, or a response we have
 * not hardware-validated remains unknown and is never converted to ready.
 */
export async function probeLinuxDleEot(devicePath: string, timeoutMs = 1_000): Promise<RawStatusObservation[]> {
  const requests = [1, 2, 3, 4].map((n) => Uint8Array.from([0x10, 0x04, n]));
  const observations: RawStatusObservation[] = [];
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(devicePath, "r+");
    for (const request of requests) {
      try {
        await handle.write(request);
        const response = Buffer.alloc(1);
        const result = await Promise.race([
          handle.read(response, 0, 1, null),
          new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("timeout")), timeoutMs)),
        ]);
        observations.push({ requestHex: Buffer.from(request).toString("hex"), responseHex: result.bytesRead ? response.subarray(0, result.bytesRead).toString("hex") : null, normalized: "unknown", timeoutMs });
      } catch (error) {
        observations.push({ requestHex: Buffer.from(request).toString("hex"), responseHex: null, normalized: "unknown", timeoutMs, error: error instanceof Error ? error.message : String(error) });
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    for (const request of requests) observations.push({ requestHex: Buffer.from(request).toString("hex"), responseHex: null, normalized: "unknown", timeoutMs, error: message });
  } finally {
    await handle?.close();
  }
  return observations;
}
