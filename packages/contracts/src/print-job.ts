export const durablePrintJobStates = ["pending", "sending", "completed", "failed", "retry_wait", "canceled"] as const;
export const legacyPrintJobStates = ["queued", "accepted", "printing", "unknown"] as const;
export const printJobStates = [...durablePrintJobStates, ...legacyPrintJobStates] as const;
export type DurablePrintJobState = (typeof durablePrintJobStates)[number];
export type LegacyPrintJobState = (typeof legacyPrintJobStates)[number];
export type PrintJobState = (typeof printJobStates)[number];
export type DeliveryCertainty = "not_sent" | "accepted" | "unknown";
export type AttemptPhase = "prepared" | "dispatch_started" | "transport_accepted" | "postcheck_completed";
export type Capability<T> = { support: "supported"; value: T } | { support: "unsupported" } | { support: "unknown"; reason: string };
export type PrinterStatusObservation = {
  observedAt: string;
  reachable: Capability<boolean>;
  online: Capability<boolean>;
  coverOpen: Capability<boolean>;
  drawerOpen: Capability<boolean>;
  paper: Capability<"ok" | "near_end" | "empty">;
  error: Capability<"none" | "recoverable" | "unrecoverable">;
  raw: unknown;
};

export type PrintJob = {
  jobId: string;
  operationId?: string;
  kind?: "original" | "reprint" | "opening" | "interim" | "closing" | "test" | "drawer";
  sourceJobId?: string;
  reprintNo?: number;
  transactionId: string;
  printerId: string;
  documentType: string;
  payload: unknown;
  source?: string;
  sourceEventId?: string;
  rendererVersion?: string;
  bytesSha256?: string;
  canonicalIr?: string;
  irSha256?: string;
  expectedBytesLength?: number;
  templateKey?: string;
  templateVersion?: number;
  templateSourceSha256?: string;
  assets?: Array<{ assetId: string; version: number; sha256: string; widthDots: number; heightDots: number; rasterBase64: string }>;
  fontId?: string;
  fontVersion?: number;
  fontSha256?: string;
  finishingPolicyId?: string;
  finishingPolicyVersion?: number;
  createdAt: string;
  state: PrintJobState;
  deliveryCertainty?: DeliveryCertainty;
  completionEvidence?: "transport_accepted" | "device_postcheck_ok" | "operator_verified";
  updatedAt: string;
  errorMessage?: string;
};

export type PrintJobRequest = Pick<PrintJob, "jobId" | "transactionId" | "printerId" | "documentType" | "kind" | "payload" | "createdAt" | "source" | "sourceEventId" | "rendererVersion" | "bytesSha256" | "canonicalIr" | "irSha256" | "expectedBytesLength" | "templateKey" | "templateVersion" | "templateSourceSha256" | "assets" | "fontId" | "fontVersion" | "fontSha256" | "finishingPolicyId" | "finishingPolicyVersion">;
export type PrintJobStateUpdate = { state: PrintJobState; deliveryCertainty?: DeliveryCertainty; completionEvidence?: PrintJob["completionEvidence"]; errorMessage?: string };

export type PrinterDispatchResult = {
  jobId: string;
  acceptedBytes: number;
  payloadLength: number;
  bytesSha256: string;
  completionEvidence: "transport_accepted" | "device_postcheck_ok";
  transportEvidence?: Record<string, string | number | boolean>;
  statusObservation?: PrinterStatusObservation;
  duplicate: boolean;
};

export type PrinterDispatchFailure = {
  code: string;
  message: string;
  acceptedBytes: number;
  notSentProven: boolean;
  retryable: boolean;
  deviceFault: boolean;
  transportEvidence?: Record<string, string | number | boolean>;
  statusObservation?: PrinterStatusObservation;
};

export function isPrintJobState(value: unknown): value is PrintJobState {
  return typeof value === "string" && (printJobStates as readonly string[]).includes(value);
}

export function normalizePrintJobState(state: PrintJobState): { state: DurablePrintJobState; deliveryCertainty?: DeliveryCertainty } {
  if (state === "queued") return { state: "pending" };
  if (state === "accepted" || state === "printing") return { state: "sending" };
  if (state === "unknown") return { state: "failed", deliveryCertainty: "unknown" };
  return { state };
}
