import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";

const args = new Map();
for (let index = 2; index < process.argv.length; index += 1) {
  const key = process.argv[index];
  if (key === "--run" || key === "--resume") { args.set(key, true); continue; }
  const value = process.argv[index + 1];
  if (!key?.startsWith("--") || !value || value.startsWith("--")) throw new Error(`引数が不正です: ${key ?? ""}`);
  args.set(key, value); index += 1;
}
if (!args.has("--run")) throw new Error("実機へ5枚送信します。内容を確認したうえで --run を指定してください");
if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("紙面確認を対話入力するため、TTY terminalから実行してください");

const operatorId = String(args.get("--operator") ?? "").trim();
if (!operatorId) throw new Error("紙面を確認する操作者を --operator <ID> で指定してください");
const managerId = String(args.get("--manager") ?? operatorId).trim();
const posUrl = String(args.get("--pos-url") ?? "http://127.0.0.1:3000").replace(/\/$/, "");
const outputDirectory = resolve(String(args.get("--output") ?? `./docs/printer-baseline/manual-goal7-${new Date().toISOString().replace(/[:.]/g, "-")}`));
const resume = args.has("--resume");
let runId = randomUUID();
let startedAt = new Date().toISOString();
let records = [];
let jobs = [];
let reviews = [];
let statusBefore = null;
let statusAfter = null;
let result = "in_progress";
let errorMessage = null;
let completedAt = null;

await mkdir(outputDirectory, { recursive: true });
if (resume) {
  const [savedEvidence, savedReview] = await Promise.all([
    readFile(resolve(outputDirectory, "pos-printerhost-evidence.json"), "utf8").then(JSON.parse),
    readFile(resolve(outputDirectory, "operator-paper-review.json"), "utf8").then(JSON.parse),
  ]);
  const resumableError = "再印刷riskが明示承認されなかったため、安全に停止しました";
  const kinds = savedEvidence.jobs?.map((job) => job.kind).join(",");
  if (savedEvidence.result !== "failed" || savedEvidence.error !== resumableError || kinds !== "opening,original") {
    throw new Error("--resume は再印刷承認前に安全停止した opening,original のrunだけに使用できます");
  }
  if (savedReview.runId !== savedEvidence.runId || savedReview.jobs?.map((job) => job.kind).join(",") !== "opening,original") {
    throw new Error("--resume のtransport証跡と紙面証跡が一致しません");
  }
  runId = savedEvidence.runId;
  startedAt = savedEvidence.startedAt;
  records = savedEvidence.requests;
  jobs = savedEvidence.jobs;
  reviews = savedReview.jobs;
  statusBefore = savedEvidence.statusBefore;
}
const suffix = runId.slice(0, 8);
const eventId = `goal7-${suffix}`;
const sessionId = `goal7-cash-${suffix}`;
const registerId = `goal7-register-${suffix}`;
const localNow = new Date();
const businessDate = `${localNow.getFullYear()}-${String(localNow.getMonth() + 1).padStart(2, "0")}-${String(localNow.getDate()).padStart(2, "0")}`;
const reader = createInterface({ input: process.stdin, output: process.stdout });

async function persist() {
  const updatedAt = new Date().toISOString();
  const evidence = {
    schemaVersion: 2,
    runId,
    result,
    error: errorMessage,
    startedAt,
    updatedAt,
    completedAt,
    posUrl,
    environment: { platform: process.platform, architecture: process.arch, node: process.version },
    statusBefore,
    statusAfter,
    jobs,
    requests: records,
  };
  const review = {
    schemaVersion: 2,
    runId,
    warning: "transport受理は紙面完了ではありません。各判定は紙面を見た操作者の入力です",
    jobs: reviews,
  };
  await Promise.all([
    writeFile(resolve(outputDirectory, "pos-printerhost-evidence.json"), `${JSON.stringify(evidence, null, 2)}\n`, "utf8"),
    writeFile(resolve(outputDirectory, "operator-paper-review.json"), `${JSON.stringify(review, null, 2)}\n`, "utf8"),
  ]);
}

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

async function captureJob(kind, jobId) {
  const terminal = await waitForJob(jobId);
  const captured = { kind, jobId, ...terminal };
  jobs.push(captured);
  console.log(`\n[${kind}] jobId=${jobId} state=${terminal.job.state} deliveryCertainty=${terminal.job.deliveryCertainty ?? "unknown"}`);
  console.log(`attempts=${JSON.stringify(terminal.attempts)}`);
  await persist();
  return captured;
}

async function askChoice(message, choices) {
  while (true) {
    const answer = (await reader.question(`${message} [${choices.join("/")}]: `)).trim();
    if (choices.includes(answer)) return answer;
    console.log(`入力値は ${choices.join(" / ")} のいずれかです。`);
  }
}

async function askRequired(message) {
  while (true) {
    const answer = (await reader.question(`${message}: `)).trim();
    if (answer) return answer;
    console.log("空欄にはできません。事象または写真を追跡できるIDを入力してください。");
  }
}

async function reviewPaper(kind, captured) {
  console.log(`\n${kind}の紙面を確認してください。transport/job stateから紙面結果を推測しないでください。`);
  const paperOutcome = await askChoice("物理結果", ["printed", "not_printed", "indeterminate"]);
  let paperPhotoId = null;
  let fullText = "unconfirmed";
  let layout = "unconfirmed";
  let mojibake = "unconfirmed";
  let partialCut = "unconfirmed";
  if (paperOutcome === "printed") {
    paperPhotoId = await askRequired("紙面写真ID");
    fullText = await askChoice("全文", ["ok", "ng"]);
    layout = await askChoice("配置", ["ok", "ng"]);
    mojibake = await askChoice("文字化け", ["none", "present"]);
    partialCut = await askChoice("部分cut", ["ok", "ng"]);
  } else if (paperOutcome === "not_printed") {
    fullText = "not_applicable";
    layout = "not_applicable";
    mojibake = "not_applicable";
    partialCut = "not_applicable";
  }
  const evidenceId = paperOutcome === "printed" ? paperPhotoId : (await askRequired("未印刷または結果不明の事象記録ID"));
  const notes = (await reader.question("補足（空欄可）: ")).trim() || null;
  const reviewed = {
    kind,
    jobId: captured.jobId,
    paperOutcome,
    paperPhotoId,
    evidenceId,
    fullText,
    layout,
    mojibake,
    partialCut,
    notes,
    operator: operatorId,
    reviewedAt: new Date().toISOString(),
  };
  reviews.push(reviewed);
  await persist();
  return reviewed;
}

async function sendAndReview(kind, jobId) {
  const captured = await captureJob(kind, jobId);
  return reviewPaper(kind, captured);
}

async function finishAfterOriginal(transactionId, originalJobId, originalReview) {
  const reprintNeedsRiskApproval = originalReview.paperOutcome !== "not_printed";
  if (reprintNeedsRiskApproval) {
    const confirmation = (await reader.question(`初回紙面は${originalReview.paperOutcome}です。重複印刷riskを受容して再印刷する場合だけ REPRINT と入力してください: `)).trim();
    if (confirmation !== "REPRINT") throw new Error("再印刷riskが明示承認されなかったため、安全に停止しました");
  }
  const approvedAt = new Date().toISOString();
  const reprintBody = {
    sourcePrintJobId: originalJobId,
    reason: "Goal 7.1実機受入",
    physicalOutcome: originalReview.paperOutcome,
    riskAccepted: reprintNeedsRiskApproval,
    ...(reprintNeedsRiskApproval ? { approval: { approverId: managerId, approvedAt } } : {}),
  };
  const reprint = await request("POST", `/api/v1/transactions/${transactionId}/reprints`, reprintBody, { "x-pos-role": "manager", "x-pos-actor-id": managerId });
  await sendAndReview("reprint", reprint.jobId);

  const interim = await request("POST", `/api/v1/cash-sessions/${sessionId}/checks/interim`, { counted: [{ denomination: 1000, quantity: 1 }], actorId: operatorId, terminalId: registerId });
  await sendAndReview("interim", interim.printJobId);
  const closing = await request("POST", `/api/v1/cash-sessions/${sessionId}/checks/closing`, { counted: [{ denomination: 1000, quantity: 1 }], carryoverYen: 1000, actorId: managerId, terminalId: registerId });
  await sendAndReview("closing", closing.printJobId);
}

try {
  result = "in_progress";
  errorMessage = null;
  completedAt = null;
  await persist();
  const info = await request("GET", "/api/v1/info");
  if (info.drawerEnabled !== false) throw new Error("ドロアー未受入のためDRAWER_ENABLED=falseが必要です。送信を開始しません");
  const currentStatus = await request("GET", "/api/v1/printer/status");
  if (currentStatus.observation?.reachable?.support !== "supported" || currentStatus.observation.reachable.value !== true) throw new Error("PrinterHostが実機到達可能と確認できません。送信を開始しません");
  statusBefore ??= currentStatus;
  await persist();

  if (resume) {
    const originalJob = jobs.find((job) => job.kind === "original");
    const originalReview = reviews.find((review) => review.kind === "original");
    await finishAfterOriginal(originalJob.job.transactionId, originalJob.jobId, originalReview);
  } else {
    await request("POST", "/api/v1/cash-sessions", { sessionId, eventId, businessDate, cashboxId: "goal7-box" });
    const opening = await request("POST", `/api/v1/cash-sessions/${sessionId}/checks/opening`, { counted: [{ denomination: 1000, quantity: 1 }], actorId: operatorId, terminalId: registerId });
    await sendAndReview("opening", opening.printJobId);

    await request("PUT", `/api/v1/events/${eventId}/catalog`, { eventId, customerWelcome: { circleName: "Goal 7.1 実機受入" }, products: [{ productCode: "00000001", name: "実機確認新刊", priceInclTax: 500, taxRate: 10, taxCategory: "inclusive_10", saleState: "on_sale" }], quickEntries: [], autoDiscountRules: [] });
    let draft = await request("POST", `/api/v1/registers/${registerId}/sale-drafts`, { eventId, staffId: "staff-001", terminalId: registerId, businessDate, sessionNo: 1 });
    draft = await request("POST", `/api/v1/sale-drafts/${draft.draftId}/lines`, { productCode: "00000001", quantity: 1 }, { "if-match": String(draft.version) });
    draft = await request("POST", `/api/v1/sale-drafts/${draft.draftId}/payments`, { kind: "cash", amountYen: 500, tenderedYen: 1000 }, { "if-match": String(draft.version) });
    const sale = await request("POST", `/api/v1/sale-drafts/${draft.draftId}/finalize`, { version: draft.version }, { "idempotency-key": `goal7-${runId}` });
    const originalReview = await sendAndReview("original", sale.printJobId);
    await finishAfterOriginal(sale.transactionId, sale.printJobId, originalReview);
  }

  statusAfter = await request("GET", "/api/v1/printer/status");
  result = "completed";
  completedAt = new Date().toISOString();
  await persist();
  console.log(`Goal 7.1 evidence saved: ${outputDirectory}`);
} catch (error) {
  result = "failed";
  errorMessage = error instanceof Error ? error.message : String(error);
  completedAt = new Date().toISOString();
  await persist();
  console.error(`Goal 7.1 acceptance stopped: ${errorMessage}`);
  console.error(`途中証跡を保存しました: ${outputDirectory}`);
  process.exitCode = 1;
} finally {
  reader.close();
}
