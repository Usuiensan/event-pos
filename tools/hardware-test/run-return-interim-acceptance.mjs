import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";

const args = new Map();
for (let i = 2; i < process.argv.length; i += 1) {
  const key = process.argv[i];
  if (key === "--run") { args.set(key, true); continue; }
  const value = process.argv[++i];
  if (!key?.startsWith("--") || !value) throw new Error(`引数が不正です: ${key ?? ""}`);
  args.set(key, value);
}
if (!args.has("--run")) throw new Error("返品・中間点検を実機へ送信するため --run が必要です");

const posUrl = String(args.get("--pos-url") ?? "http://127.0.0.1:3000").replace(/\/$/, "");
const output = resolve(String(args.get("--output") ?? `./docs/printer-baseline/windows/${Date.now()}-return-interim`));
const runId = randomUUID();
const suffix = runId.slice(0, 8);
const eventId = `paper-${suffix}`;
const sessionId = `cash-${suffix}`;
const registerId = `register-${suffix}`;
const actorId = "paper-test-operator";
const records = [];
const jobs = [];
await mkdir(output, { recursive: true });

async function request(method, path, body, headers = {}) {
  const response = await fetch(`${posUrl}${path}`, {
    method,
    headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  const parsed = text ? JSON.parse(text) : null;
  records.push({ at: new Date().toISOString(), method, path, status: response.status, response: parsed });
  if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${text}`);
  return parsed;
}

async function waitForJob(kind, jobId) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const job = await request("GET", `/api/v1/print-jobs/${jobId}`);
    if (["completed", "failed", "canceled"].includes(job.state)) {
      const attempts = await request("GET", `/api/v1/print-jobs/${jobId}/attempts`);
      jobs.push({ kind, job, attempts: attempts.attempts });
      return;
    }
    await new Promise((done) => setTimeout(done, 250));
  }
  throw new Error(`${kind} job ${jobId} が30秒以内に完了しません`);
}

const startedAt = new Date().toISOString();
let result = "failed";
let error = null;
let statusBefore = null;
let statusAfter = null;
try {
  const info = await request("GET", "/api/v1/info");
  if (info.drawerEnabled !== false) throw new Error("DRAWER_ENABLED=falseではありません");
  statusBefore = await request("GET", "/api/v1/printer/status");
  if (statusBefore.observation?.reachable?.value !== true) throw new Error("PrinterHostへ到達できません");
  const now = new Date();
  const businessDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  await request("POST", "/api/v1/cash-sessions", { sessionId, eventId, businessDate, cashboxId: `box-${suffix}` });
  await request("POST", `/api/v1/cash-sessions/${sessionId}/checks/opening`, { counted: [{ denomination: 1000, quantity: 2 }], actorId, terminalId: registerId });
  await request("PUT", `/api/v1/events/${eventId}/catalog`, { eventId, customerWelcome: { circleName: "返品・点検紙面試験" }, products: [{ productCode: "00000001", name: "返品試験商品", priceInclTax: 500, taxRate: 10, taxCategory: "inclusive_10", saleState: "on_sale" }], quickEntries: [], autoDiscountRules: [] });
  let draft = await request("POST", `/api/v1/registers/${registerId}/sale-drafts`, { eventId, staffId: actorId, terminalId: registerId, businessDate, sessionNo: 1 });
  draft = await request("POST", `/api/v1/sale-drafts/${draft.draftId}/lines`, { productCode: "00000001", quantity: 1 }, { "if-match": String(draft.version) });
  draft = await request("POST", `/api/v1/sale-drafts/${draft.draftId}/payments`, { kind: "cash", amountYen: 500, tenderedYen: 500 }, { "if-match": String(draft.version) });
  const sale = await request("POST", `/api/v1/sale-drafts/${draft.draftId}/finalize`, { version: draft.version }, { "idempotency-key": `sale-${runId}` });
  await waitForJob("sale-setup", sale.printJobId);
  const returned = await request("POST", `/api/v1/transactions/${sale.transactionId}/full-return`, { cashSessionId: sessionId, terminalId: registerId, reason: "実機紙面試験" }, { "idempotency-key": `return-${runId}`, "x-pos-role": "manager", "x-pos-actor-id": actorId });
  await waitForJob("return", returned.printJobId);
  const interim = await request("POST", `/api/v1/cash-sessions/${sessionId}/checks/interim`, { counted: [{ denomination: 1000, quantity: 2 }], actorId, terminalId: registerId });
  await waitForJob("interim", interim.printJobId);
  statusAfter = await request("GET", "/api/v1/printer/status");
  result = "transport_completed_paper_unconfirmed";
} catch (caught) {
  error = caught instanceof Error ? caught.message : String(caught);
} finally {
  const evidence = { schemaVersion: 1, runId, result, error, startedAt, completedAt: new Date().toISOString(), posUrl, statusBefore, statusAfter, jobs, requests: records, paperReview: { state: "unconfirmed", warning: "transport受理から紙面成功を推測しない" } };
  await writeFile(resolve(output, "return-interim-evidence.json"), `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ output, result, error, jobs: jobs.map(({ kind, job }) => ({ kind, jobId: job.jobId, state: job.state, deliveryCertainty: job.deliveryCertainty })) }, null, 2));
  if (error) process.exitCode = 1;
}
