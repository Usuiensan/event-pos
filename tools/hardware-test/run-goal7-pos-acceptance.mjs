import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";

const args = new Map();
for (let index = 2; index < process.argv.length; index += 1) {
  const key = process.argv[index];
  if (key === "--run") { args.set(key, true); continue; }
  const value = process.argv[index + 1];
  if (!key?.startsWith("--") || !value || value.startsWith("--")) throw new Error(`引数が不正です: ${key ?? ""}`);
  args.set(key, value); index += 1;
}
if (!args.has("--run")) throw new Error("実機へ5枚送信します。内容を確認したうえで --run を指定してください");

const posUrl = String(args.get("--pos-url") ?? "http://127.0.0.1:3000").replace(/\/$/, "");
const outputDirectory = resolve(String(args.get("--output") ?? `./docs/printer-baseline/manual-goal7-${new Date().toISOString().replace(/[:.]/g, "-")}`));
const runId = randomUUID();
const suffix = runId.slice(0, 8);
const eventId = `goal7-${suffix}`;
const sessionId = `goal7-cash-${suffix}`;
const registerId = `goal7-register-${suffix}`;
const businessDate = new Date().toISOString().slice(0, 10);
const records = [];

async function request(method, path, body, headers = {}) {
  const response = await fetch(`${posUrl}${path}`, { method, headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await response.text();
  let parsed;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = { raw: text }; }
  records.push({ at: new Date().toISOString(), method, path, status: response.status, response: parsed });
  if (!response.ok) throw new Error(`${method} ${path} failed (${response.status}): ${text}`);
  return parsed;
}

async function waitForJob(jobId) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const job = await request("GET", `/api/v1/print-jobs/${jobId}`);
    if (["completed", "failed", "canceled"].includes(job.state)) {
      const attempts = await request("GET", `/api/v1/print-jobs/${jobId}/attempts`);
      return { job, attempts: attempts.attempts };
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  }
  throw new Error(`job ${jobId} が30秒以内に終端状態へ到達しません`);
}

await mkdir(outputDirectory, { recursive: true });
const info = await request("GET", "/api/v1/info");
if (info.drawerEnabled !== false) throw new Error("ドロアー未受入のためDRAWER_ENABLED=falseが必要です。送信を開始しません");
const statusBefore = await request("GET", "/api/v1/printer/status");
if (statusBefore.observation?.reachable?.support !== "supported" || statusBefore.observation.reachable.value !== true) throw new Error("PrinterHostが実機到達可能と確認できません。送信を開始しません");

await request("POST", "/api/v1/cash-sessions", { sessionId, eventId, businessDate, cashboxId: "goal7-box" });
const opening = await request("POST", `/api/v1/cash-sessions/${sessionId}/checks/opening`, { counted: [{ denomination: 1000, quantity: 1 }], actorId: "goal7-operator", terminalId: registerId });
await request("PUT", `/api/v1/events/${eventId}/catalog`, { eventId, customerWelcome: { circleName: "Goal 7.1 実機受入" }, products: [{ productCode: "00000001", name: "実機確認新刊", priceInclTax: 500, taxRate: 10, taxCategory: "inclusive_10", saleState: "on_sale" }], quickEntries: [], autoDiscountRules: [] });
let draft = await request("POST", `/api/v1/registers/${registerId}/sale-drafts`, { eventId, staffId: "staff-001", terminalId: registerId, businessDate, sessionNo: 1 });
draft = await request("POST", `/api/v1/sale-drafts/${draft.draftId}/lines`, { productCode: "00000001", quantity: 1 }, { "if-match": String(draft.version) });
draft = await request("POST", `/api/v1/sale-drafts/${draft.draftId}/payments`, { kind: "cash", amountYen: 500, tenderedYen: 1000 }, { "if-match": String(draft.version) });
const sale = await request("POST", `/api/v1/sale-drafts/${draft.draftId}/finalize`, { version: draft.version }, { "idempotency-key": `goal7-${runId}` });
const reprint = await request("POST", `/api/v1/transactions/${sale.transactionId}/reprints`, { sourcePrintJobId: sale.printJobId, reason: "Goal 7.1実機受入", physicalOutcome: "printed", riskAccepted: true, approval: { approverId: "goal7-manager", approvedAt: new Date().toISOString() } }, { "x-pos-role": "manager", "x-pos-actor-id": "goal7-manager" });
const interim = await request("POST", `/api/v1/cash-sessions/${sessionId}/checks/interim`, { counted: [{ denomination: 1000, quantity: 1 }], actorId: "goal7-operator", terminalId: registerId });
const closing = await request("POST", `/api/v1/cash-sessions/${sessionId}/checks/closing`, { counted: [{ denomination: 1000, quantity: 1 }], carryoverYen: 1000, actorId: "goal7-manager", terminalId: registerId });

const requestedJobs = [
  ["opening", opening.printJobId],
  ["original", sale.printJobId],
  ["reprint", reprint.jobId],
  ["interim", interim.printJobId],
  ["closing", closing.printJobId],
];
const jobs = [];
for (const [kind, jobId] of requestedJobs) jobs.push({ kind, jobId, ...(await waitForJob(jobId)) });
const statusAfter = await request("GET", "/api/v1/printer/status");
const evidence = { schemaVersion: 1, runId, executedAt: new Date().toISOString(), posUrl, environment: { platform: process.platform, architecture: process.arch, node: process.version }, statusBefore, statusAfter, jobs, requests: records };
const review = { schemaVersion: 1, runId, warning: "transport受理は紙面完了ではありません。操作者が各欄を更新してください", jobs: requestedJobs.map(([kind, jobId]) => ({ kind, jobId, paperPhotoId: null, fullText: "未確認", layout: "未確認", mojibake: "未確認", partialCut: "未確認", operator: null, reviewedAt: null })) };
await writeFile(resolve(outputDirectory, "pos-printerhost-evidence.json"), `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
await writeFile(resolve(outputDirectory, "operator-paper-review.json"), `${JSON.stringify(review, null, 2)}\n`, "utf8");
console.log(`Goal 7.1 evidence saved: ${outputDirectory}`);
