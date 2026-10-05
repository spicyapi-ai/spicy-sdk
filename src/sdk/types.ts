import type { components } from "../generated/openapi.js";

export type ApiModel = components["schemas"]["APIModel"];
export type ApiModelPrice = components["schemas"]["APIModelPrice"];
export type ModelList = components["schemas"]["APIModelList"];
export type Balance = components["schemas"]["Balance"];
export type FundingOverview = components["schemas"]["FundingOverview"];
export type FundingGrant = components["schemas"]["FundingGrantItem"];
export type CreditFacility = components["schemas"]["CreditFacilityItem"];
export type UsageReport = components["schemas"]["APIKeyUsageResponse"];
export type TaskList = components["schemas"]["APIKeyTaskListResponse"];
export type TaskListItem = components["schemas"]["APIKeyTaskItem"];
export type TaskRecord = components["schemas"]["TaskRecord"];
export type TaskState = TaskRecord["state"];
/** One generated file in `output.assets`; on layer decomposition results it also carries `layer`. */
export type TaskOutputAsset = components["schemas"]["TaskOutputAsset"];
/** Timing and language details that speech-to-text models add next to the plain `output.text`. */
export type TaskTranscript = components["schemas"]["TaskTranscript"];
export type CreateTaskResult = components["schemas"]["CreateTaskResponse"];
export type RetryTaskResult = components["schemas"]["RetryTaskResponse"];
export type PurgeTaskResult = components["schemas"]["TaskPurgeResponse"];
/* The server does not break this out as a named component, so it is taken from TaskRecord: the two
   have to be the same union, or "what state is it in after being purged" would be answered one way
   by the SDK and another by the contract. */
export type TaskContentState = NonNullable<TaskRecord["contentState"]>;
export type TaskRetention = components["schemas"]["TaskRetention"];
export type UploadTicket = components["schemas"]["UploadURLResponse"];
export type UploadedFile = components["schemas"]["FileCommitResponse"];
export type DownloadTicket = components["schemas"]["DownloadURLResponse"];
export type UploadContentType = components["schemas"]["UploadURLRequest"]["contentType"];

export interface CreateTaskInput {
  model: string;
  input: Record<string, unknown>;
  callBackUrl?: string | undefined;
  /** Five-minute quote bound to the exact original request; amounts stay USD decimal strings. */
  quoteId?: string;
  expectedCost?: string;
}

export interface ListModelsOptions {
  modality?: "image" | "video" | "audio" | "text" | undefined;
  provider?: string | undefined;
  task?: string | undefined;
  search?: string | undefined;
  includeSchema?: boolean | undefined;
  includeExamples?: boolean | undefined;
  signal?: AbortSignal | undefined;
}

export interface RequestOptions {
  signal?: AbortSignal | undefined;
}

export interface ListTasksOptions extends RequestOptions {
  /** Half-open UTC date range; keep dates fixed while paging. Defaults to 7 days, max 92. */
  from?: string;
  to?: string;
  state?: TaskState;
  model?: string;
  limit?: number;
  /** Pass the server-returned cursor through unchanged; never construct one. */
  cursor?: string;
}

export interface UsageOptions extends RequestOptions {
  from?: string;
  to?: string;
}

export interface ApiResponseMetadata {
  method: string;
  path: string;
  status: number;
  requestId?: string;
  rateLimitLimit?: number;
  rateLimitRemaining?: number;
}

export interface BillableRequestOptions extends RequestOptions {
  idempotencyKey?: string | undefined;
}

export interface CreateTaskOptions extends BillableRequestOptions {
  /**
   * Retention for this one task's generated media, result payload, prompt and other input text, in whole seconds, sent as
   * `X-Spicy-Retention`.
   *
   * It only ever shortens: the server keeps the smallest of this value, the account
   * retention settings and the platform maximum, so a request cannot buy back a longer
   * window than the account allows. `0` removes the outputs as soon as the task reaches a
   * terminal state. An oversized value is clamped by the server rather than rejected, and
   * the accepted deadlines come back in `TaskRecord.retention`.
   */
  retentionSeconds?: number | undefined;

  /**
   * Hold the connection open for up to this many seconds so the first poll is unnecessary,
   * sent as the `wait` query parameter.
   *
   * **It does not guarantee a finished task.** Reaching a terminal state within the budget
   * returns the full task record; running out of budget returns the ordinary accepted
   * response, exactly as if you had not asked. The two have the same shape and differ only
   * in `state`, so branch on {@link isTerminal} rather than on the fact that you passed this.
   *
   * The server clamps anything above 60 and ignores anything that is not a positive integer,
   * so nothing is clamped here. Disconnecting stops the wait and nothing else: the task keeps
   * running and is billed as usual.
   */
  waitSeconds?: number | undefined;
}

export interface WaitForTaskOptions extends RequestOptions {
  /** Fixed interval when set; otherwise backs off from 2s up to 10s. */
  intervalMs?: number;
  timeoutMs?: number;
  onUpdate?: ((task: TaskRecord) => void | Promise<void>) | undefined;
}

export interface RunTaskOptions extends WaitForTaskOptions, CreateTaskOptions {
  /**
   * Persist the task identity as soon as it is accepted; a local wait timeout does not cancel the
   * remote task.
   */
  onAccepted?: ((task: CreateTaskResult) => void | Promise<void>) | undefined;
}

export interface ProbeResult {
  path: "/healthz" | "/readyz";
  /**
   * Whether this particular probe answered 2xx.
   *
   * `/readyz` is always false on the public surface by design, so reading this field on its own
   * leads to the wrong conclusion. To judge whether the service is usable, read
   * {@link ServiceStatus.operational}.
   */
  ok: boolean;
  /**
   * The HTTP status this probe answered with.
   *
   * A 404 on `/readyz` means this deployment does not expose a readiness probe on this surface - a
   * readiness check reveals the state of the database and Redis, so the server registers it only in
   * the admin process. That is not a fault. Genuine unreadiness answers 503.
   */
  status: number;
  body: string;
  error?: string;
}

export interface ServiceStatus {
  /**
   * True when `/healthz` passes and `/readyz` either passes or is absent altogether (404).
   *
   * The public-facing process does not register `/readyz` by design, because it would reveal the
   * state of the database and Redis; a 404 means "that probe does not apply to this deployment"
   * rather than "not ready". Unreadiness answers 503.
   */
  operational: boolean;
  health: ProbeResult;
  readiness: ProbeResult;
  checkedAt: string;
}

export interface SpicyClientOptions {
  apiKey?: string | undefined;
  apiBaseUrl?: string | undefined;
  serviceBaseUrl?: string | undefined;
  /** One API call. 1–120000, default 30000. */
  timeoutMs?: number;
  /**
   * The upload leg that moves the bytes, kept apart from `timeoutMs`.
   *
   * 1–3600000, default 600000. Audio and video go up to 90 MiB, which 30 seconds only covers at a
   * sustained 25 Mbps; the request would be cut mid-transfer and reported as a local timeout.
   */
  uploadTimeoutMs?: number;
  maxRetries?: number;
  retryBaseDelayMs?: number;
  maxRetryDelayMs?: number;
  fetch?: typeof fetch | undefined;
  now?: (() => number) | undefined;
  random?: (() => number) | undefined;
  sleep?: ((milliseconds: number, signal?: AbortSignal) => Promise<void>) | undefined;
  /**
   * Receives status and tracing metadata only — never the key, request body or media. Callback
   * errors don't change the request result.
   */
  onResponse?: ((metadata: ApiResponseMetadata) => void | Promise<void>) | undefined;
}

export interface UploadBytesOptions extends RequestOptions {
  contentType: UploadContentType;
}

export interface UploadFileOptions extends RequestOptions {
  contentType?: UploadContentType | undefined;
}

export type TaskQuote = components["schemas"]["TaskQuoteResponse"];
