export const printJobStates = ["queued", "accepted", "printing", "completed", "failed", "unknown"] as const;
export type PrintJobState = (typeof printJobStates)[number];

export type PrintJob = {
  jobId: string;
  transactionId: string;
  printerId: string;
  documentType: string;
  payload: unknown;
  source?: string;
  sourceEventId?: string;
  rendererVersion?: string;
  bytesSha256?: string;
  createdAt: string;
  state: PrintJobState;
  updatedAt: string;
  errorMessage?: string;
};

export type PrintJobRequest = Pick<PrintJob, "jobId" | "transactionId" | "printerId" | "documentType" | "payload" | "createdAt" | "source" | "sourceEventId" | "rendererVersion" | "bytesSha256">;
export type PrintJobStateUpdate = { state: PrintJobState; errorMessage?: string };

export function isPrintJobState(value: unknown): value is PrintJobState {
  return typeof value === "string" && (printJobStates as readonly string[]).includes(value);
}
