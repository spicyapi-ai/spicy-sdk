import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { SDK_VERSION } from "../generated/package-version.js";
import { decodeBase64Media } from "./base64.js";
import { unusedProxyHint } from "./env-proxy.js";
import { MAX_API_RESPONSE_BYTES, describeForeignBody, readResponseText } from "./response-body.js";
export { MAX_API_RESPONSE_BYTES } from "./response-body.js";

import {
  SpicyApiError,
  SpicyTimeoutError,
  SpicyTransportError,
  SpicyUploadError,
  SpicyWaitTimeoutError,
} from "./errors.js";
import type {
  ApiModel,
  Balance,
  BillableRequestOptions,
  CreateTaskInput,
  CreateTaskOptions,
  CreateTaskResult,
  DownloadTicket,
  ListModelsOptions,
  ListTasksOptions,
  TaskList,
  ModelList,
  ProbeResult,
  PurgeTaskResult,
  RequestOptions,
  RunTaskOptions,
  RetryTaskResult,
  ServiceStatus,
  SpicyClientOptions,
  TaskRecord,
  TaskQuote,
  UploadBytesOptions,
  UploadContentType,
  UploadedFile,
  UploadFileOptions,
  UploadTicket,
  UsageOptions,
  UsageReport,
  WaitForTaskOptions,
} from "./types.js";

export const DEFAULT_API_BASE_URL = "https://api.spicyapi.ai/api/v1";
export const DEFAULT_SERVICE_BASE_URL = "https://api.spicyapi.ai";
export const DEFAULT_TIMEOUT_MS = 30_000;
/**
 * The timeout for the hop that uploads straight to object storage, kept separate from "one API
 * call".
 *
 * `DEFAULT_TIMEOUT_MS` is 30 seconds with a 120-second ceiling, which is reasonable for a JSON
 * request and not for moving bytes: the audio and video limit is 90 MiB, so 30 seconds demands a
 * sustained 25 Mbps upstream, and even the full 120 seconds demands 6.3 Mbps. On a real network
 * this severs the connection halfway through, and the error reads `request exceeded the local
 * 30000ms timeout` - which looks like a network problem when the client did the cutting. Ten
 * minutes is exactly enough for 90 MiB at 1.2 Mbps, and is the same order as the server's
 * 600-second media duration limit.
 *
 * `uploadTimeoutMs` overrides it, and is not bound by that 120-second ceiling, which constrains API
 * calls rather than uploads.
 */
export const DEFAULT_UPLOAD_TIMEOUT_MS = 10 * 60_000;
export const DEFAULT_WAIT_TIMEOUT_MS = 10 * 60_000;
export const DEFAULT_WAIT_INTERVAL_MS = 2_000;

interface Envelope<T> {
  code: number;
  msg: string;
  data: T;
  request_id: string;
}

interface RequestConfiguration {
  body?: unknown;
  headers?: Record<string, string> | undefined;
  retryable?: boolean;
  signal?: AbortSignal | undefined;
  /** Overrides the local timeout for this one call. Needed only when the server holds the
   * connection longer for a given request - see `wait`. */
  timeoutMs?: number | undefined;
}

const TERMINAL_STATES = new Set(["succeeded", "failed", "canceled", "expired"]);

/**
 * Whether this task has reached a terminal state and will not change again.
 *
 * Branch on this whenever a task is created with `waitSeconds`: what comes back may be a terminal
 * record, or it may be the acceptance response returned once the wait budget ran out. The two have
 * the same shape and differ only in `state`, so the assumption "I passed wait, so it must be
 * finished" silently carries a still-running task forward.
 */
export function isTerminal(task: { state?: string }): boolean {
  return task.state !== undefined && TERMINAL_STATES.has(task.state);
}
const RETRYABLE_STATUSES = new Set([408, 429, 500, 502, 503, 504]);
const CONTENT_TYPES_BY_EXTENSION: Record<string, UploadContentType> = {
  ".gif": "image/gif",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
};

function isLoopback(hostname: string): boolean {
  const normalized = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return normalized === "localhost" || normalized === "::1" || normalized.startsWith("127.");
}

function normalizeBaseUrl(value: string, label: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError(`${label} must be an absolute URL`);
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback(url.hostname))) {
    throw new TypeError(`${label} must use HTTPS; HTTP is allowed only for loopback development`);
  }
  if (url.username || url.password) throw new TypeError(`${label} must not contain credentials`);
  if (url.search || url.hash) throw new TypeError(`${label} must not contain a query or fragment`);
  return url.toString().replace(/\/$/, "");
}

function requireIdentifier(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new TypeError(`${label} is required`);
  if (normalized.includes("\r") || normalized.includes("\n")) {
    throw new TypeError(`${label} must not contain line breaks`);
  }
  return normalized;
}

function parseIntegerHeader(value: string | null): number | undefined {
  if (value === null || !/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function parseRetryAfter(value: string | null, now: number): number | undefined {
  if (value === null) return undefined;
  if (/^\d+(?:\.\d+)?$/.test(value)) return Math.max(0, Number(value) * 1_000);
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new SpicyTransportError("operation canceled");
}

function defaultSleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(abortError(signal));
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError(signal!));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function waitSettings(options: WaitForTaskOptions) {
  const intervalMs = options.intervalMs ?? DEFAULT_WAIT_INTERVAL_MS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
  if (!Number.isInteger(intervalMs) || intervalMs < 100 || intervalMs > 60_000) {
    throw new TypeError("intervalMs must be an integer between 100 and 60000");
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 24 * 60 * 60_000) {
    throw new TypeError("timeoutMs must be an integer between 1 and 86400000");
  }
  return { intervalMs, timeoutMs };
}

function deadlineSignal(timeoutMs: number, parent: AbortSignal | undefined, reason: () => Error) {
  const controller = new AbortController();
  const onAbort = () => controller.abort(parent?.reason);
  parent?.addEventListener("abort", onAbort, { once: true });
  if (parent?.aborted) onAbort();
  const timer = setTimeout(() => controller.abort(reason()), timeoutMs);
  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timer);
      parent?.removeEventListener("abort", onAbort);
    },
  };
}

// A user callback may run asynchronously, but must not prevent the local wait from expiring or
// being cancelled; no attempt is made to cancel the callback's own work.
function waitForCallback(callback: () => void | Promise<void>, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(abortError(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve()
      .then(() => {
        signal.throwIfAborted();
        return callback();
      })
      .then(
        () => {
          signal.removeEventListener("abort", onAbort);
          resolve();
        },
        (error: unknown) => {
          signal.removeEventListener("abort", onAbort);
          reject(
            error instanceof Error
              ? error
              : new SpicyTransportError("callback failed", { cause: error }),
          );
        },
      );
  });
}

/**
 * Turns `waitSeconds` into `?wait=N` and works out how long this call's local timeout needs to be.
 *
 * The contract requires the server to clamp anything over 60 down to 60 and to ignore - rather than
 * reject - any value that is not a positive integer, on the stated grounds that a typo in an
 * optimisation parameter should not fail a generation that would otherwise have succeeded. So
 * nothing is clamped or normalised here; only negatives are refused, being an unambiguous caller
 * error rather than a platform ceiling that may later be relaxed.
 *
 * The local timeout keeps 10 seconds of headroom for task creation itself and the round trip.
 */
function waitQuery(waitSeconds: number | undefined): { suffix: string; timeoutMs?: number } {
  if (waitSeconds === undefined) return { suffix: "" };
  if (!Number.isFinite(waitSeconds) || waitSeconds < 0) {
    throw new TypeError("waitSeconds must not be negative");
  }
  return {
    suffix: `?wait=${encodeURIComponent(String(waitSeconds))}`,
    timeoutMs: Math.max(DEFAULT_TIMEOUT_MS, Math.ceil(waitSeconds * 1000) + 10_000),
  };
}

/**
 * Turns `retentionSeconds` into `X-Spicy-Retention`.
 *
 * The contract requires the server to clamp negatives, non-integers and over-the-limit values
 * rather than error on them - a header meant only to be more conservative should not fail an entire
 * generation. That obligation is the server's; what is caught here is a local caller passing the
 * wrong type. The ceiling is not enforced locally, because only the server knows the platform
 * limit and copying it into the client buries a constant that will expire; anything over it is
 * clamped server-side, and the effective value is read back from `TaskRecord.retention`.
 */
function retentionHeaders(
  retentionSeconds: number | undefined,
): Record<string, string> | undefined {
  if (retentionSeconds === undefined) return undefined;
  if (!Number.isSafeInteger(retentionSeconds) || retentionSeconds < 0) {
    throw new TypeError("retentionSeconds must be a non-negative integer number of seconds");
  }
  return { "X-Spicy-Retention": String(retentionSeconds) };
}

/* The extensions listed in the error are derived from the mapping rather than written by hand: it
   used to hard-code five image extensions while the mapping had long accepted mp4, webm, mp3 and
   wav, so somebody uploading a .mov read "images only" and concluded the platform takes no video. */
const SUPPORTED_UPLOAD_EXTENSIONS = Object.keys(CONTENT_TYPES_BY_EXTENSION)
  .map((extension) => extension.slice(1))
  .join(", ");

function inferContentType(filePath: string): UploadContentType {
  const contentType = CONTENT_TYPES_BY_EXTENSION[extname(filePath).toLowerCase()];
  if (!contentType) {
    throw new TypeError(
      `contentType is required unless the file extension is one of: ${SUPPORTED_UPLOAD_EXTENSIONS}`,
    );
  }
  return contentType;
}

export class SpicyClient {
  private readonly apiKey: string | undefined;
  private readonly apiBaseUrl: string;
  private readonly serviceBaseUrl: string;
  private readonly timeoutMs: number;
  private readonly uploadTimeoutMs: number;
  private readonly maxRetries: number;
  private readonly retryBaseDelayMs: number;
  private readonly maxRetryDelayMs: number;
  private readonly transport: typeof fetch;
  /** Whether requests go through the runtime's own fetch, the one that may ignore a proxy. */
  private readonly platformFetch: boolean;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly sleep: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  private readonly onResponse: SpicyClientOptions["onResponse"];

  constructor(options: SpicyClientOptions = {}) {
    this.onResponse = options.onResponse;
    const configuredKey = options.apiKey ?? process.env.SPICY_API_KEY;
    this.apiKey = configuredKey?.trim() || undefined;
    this.apiBaseUrl = normalizeBaseUrl(
      options.apiBaseUrl ?? process.env.SPICY_API_BASE_URL ?? DEFAULT_API_BASE_URL,
      "apiBaseUrl",
    );
    this.serviceBaseUrl = normalizeBaseUrl(
      options.serviceBaseUrl ?? process.env.SPICY_SERVICE_BASE_URL ?? DEFAULT_SERVICE_BASE_URL,
      "serviceBaseUrl",
    );
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.uploadTimeoutMs = options.uploadTimeoutMs ?? DEFAULT_UPLOAD_TIMEOUT_MS;
    this.maxRetries = options.maxRetries ?? 2;
    this.retryBaseDelayMs = options.retryBaseDelayMs ?? 250;
    this.maxRetryDelayMs = options.maxRetryDelayMs ?? 30_000;
    this.transport = options.fetch ?? globalThis.fetch;
    this.platformFetch = this.transport === globalThis.fetch;
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
    this.sleep = options.sleep ?? defaultSleep;

    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 120_000) {
      throw new TypeError("timeoutMs must be an integer between 1 and 120000");
    }
    if (
      !Number.isInteger(this.uploadTimeoutMs) ||
      this.uploadTimeoutMs < 1 ||
      this.uploadTimeoutMs > 60 * 60_000
    ) {
      throw new TypeError("uploadTimeoutMs must be an integer between 1 and 3600000");
    }
    if (!Number.isInteger(this.maxRetries) || this.maxRetries < 0 || this.maxRetries > 5) {
      throw new TypeError("maxRetries must be an integer between 0 and 5");
    }
    if (!Number.isInteger(this.retryBaseDelayMs) || this.retryBaseDelayMs < 1) {
      throw new TypeError("retryBaseDelayMs must be a positive integer");
    }
    if (!Number.isInteger(this.maxRetryDelayMs) || this.maxRetryDelayMs < this.retryBaseDelayMs) {
      throw new TypeError("maxRetryDelayMs must be an integer no smaller than retryBaseDelayMs");
    }
    if (typeof this.transport !== "function")
      throw new TypeError("a fetch implementation is required");
  }

  /**
   * Liveness on the public surface: `/healthz` decides, and a 404 from `/readyz` means "this
   * deployment does not have that probe".
   *
   * A readiness check exposes the state of the database and Redis, so by design the server
   * registers `/readyz` only in the admin process; the public-facing process never registers it at
   * all. Treating that 404 as "not ready" makes `operational` permanently false on the production
   * domain - and this is the first command the README recommends, as well as the only one that
   * needs no key and costs nothing, so it carries the whole burden of demonstrating that the
   * platform is alive. Genuine unreadiness is still caught: `/readyz` then answers 503, not 404.
   */
  async getStatus(options: RequestOptions = {}): Promise<ServiceStatus> {
    const [health, readiness] = await Promise.all([
      this.probe("/healthz", options.signal),
      this.probe("/readyz", options.signal),
    ]);
    return {
      operational: health.ok && (readiness.ok || readiness.status === 404),
      health,
      readiness,
      checkedAt: new Date(this.now()).toISOString(),
    };
  }

  listModels(options: ListModelsOptions = {}): Promise<ModelList> {
    const query = new URLSearchParams();
    if (options.modality !== undefined) query.set("modality", options.modality);
    if (options.provider !== undefined) query.set("provider", options.provider);
    if (options.task !== undefined) query.set("task", options.task);
    if (options.search !== undefined) query.set("search", options.search);
    if (options.includeSchema !== undefined)
      query.set("includeSchema", options.includeSchema ? "1" : "0");
    if (options.includeExamples !== undefined)
      query.set("includeExamples", options.includeExamples ? "1" : "0");
    const suffix = query.size === 0 ? "" : `?${query.toString()}`;
    return this.apiRequest<ModelList>("GET", `/models${suffix}`, {
      retryable: true,
      signal: options.signal,
    });
  }

  getModel(model: string, options: RequestOptions = {}): Promise<ApiModel> {
    const value = encodeURIComponent(requireIdentifier(model, "model"));
    return this.apiRequest<ApiModel>("GET", `/models/${value}`, {
      retryable: true,
      signal: options.signal,
    });
  }

  getBalance(options: RequestOptions = {}): Promise<Balance> {
    return this.apiRequest<Balance>("GET", "/chat/credit", {
      retryable: true,
      signal: options.signal,
    });
  }

  getUsage(options: UsageOptions = {}): Promise<UsageReport> {
    const query = new URLSearchParams();
    if (options.from !== undefined) query.set("from", options.from);
    if (options.to !== undefined) query.set("to", options.to);
    return this.apiRequest<UsageReport>("GET", `/usage${query.size ? `?${query}` : ""}`, {
      retryable: true,
      signal: options.signal,
    });
  }

  listTasks(options: ListTasksOptions = {}): Promise<TaskList> {
    const query = new URLSearchParams();
    for (const field of ["from", "to", "state", "model", "limit", "cursor"] as const) {
      if (options[field] !== undefined) query.set(field, String(options[field]));
    }
    return this.apiRequest<TaskList>("GET", `/jobs${query.size ? `?${query}` : ""}`, {
      retryable: true,
      signal: options.signal,
    });
  }

  getTask(taskId: string, options: RequestOptions = {}): Promise<TaskRecord> {
    const query = new URLSearchParams({ taskId: requireIdentifier(taskId, "taskId") });
    return this.apiRequest<TaskRecord>("GET", `/jobs/recordInfo?${query.toString()}`, {
      retryable: true,
      signal: options.signal,
    });
  }

  quoteTask(payload: CreateTaskInput, options: RequestOptions = {}): Promise<TaskQuote> {
    return this.apiRequest<TaskQuote>("POST", "/jobs/quote", {
      body: {
        model: payload.model,
        input: payload.input,
        ...(payload.callBackUrl === undefined ? {} : { callBackUrl: payload.callBackUrl }),
      },
      retryable: true,
      signal: options.signal,
    });
  }

  createTask(payload: CreateTaskInput, options: CreateTaskOptions = {}): Promise<CreateTaskResult> {
    const idempotency = this.idempotencyHeaders(options.idempotencyKey);
    const retention = retentionHeaders(options.retentionSeconds);
    const headers =
      idempotency === undefined && retention === undefined
        ? undefined
        : { ...idempotency, ...retention };
    const wait = waitQuery(options.waitSeconds);
    return this.apiRequest<CreateTaskResult>("POST", `/jobs/createTask${wait.suffix}`, {
      body: payload,
      headers,
      // Only the idempotency key decides retryability: a retention header does not make a resend
      // safe.
      retryable: idempotency !== undefined,
      signal: options.signal,
      // The local timeout has to accommodate the server-side wait, or this call is cut off locally
      // while the server is still waiting - which looks like the parameter doing nothing when the
      // real cause is two timeouts colliding.
      ...(wait.timeoutMs === undefined ? {} : { timeoutMs: wait.timeoutMs }),
    });
  }

  /**
   * Destroys the content of a terminal task: the output objects, the result payload, and the text in
   * the prompt and input.
   *
   * What is destroyed is content, not the record of spending - the ledger entries, the amount
   * charged, the model identifier, the state, the timestamps and the request_id all stay put. It is
   * idempotent: calling it again after a purge still answers 200. A running task is cancelled first.
   */
  purgeTask(taskId: string, options: RequestOptions = {}): Promise<PurgeTaskResult> {
    return this.apiRequest<PurgeTaskResult>("POST", "/jobs/purge", {
      body: { taskId: requireIdentifier(taskId, "taskId") },
      // The server explicitly guarantees idempotency, so a transport-level retry is safe: a
      // duplicate arrival returns the same record.
      retryable: true,
      signal: options.signal,
    });
  }

  retryTask(taskId: string, options: BillableRequestOptions = {}): Promise<RetryTaskResult> {
    const headers = this.idempotencyHeaders(options.idempotencyKey);
    return this.apiRequest<RetryTaskResult>("POST", "/jobs/retry", {
      body: { taskId: requireIdentifier(taskId, "taskId") },
      headers,
      retryable: headers !== undefined,
      signal: options.signal,
    });
  }

  async waitForTask(taskId: string, options: WaitForTaskOptions = {}): Promise<TaskRecord> {
    const id = requireIdentifier(taskId, "taskId");
    const { intervalMs, timeoutMs } = waitSettings(options);
    const startedAt = this.now();
    let lastTask: TaskRecord | undefined;
    let attempt = 0;
    const deadline = deadlineSignal(
      timeoutMs,
      options.signal,
      () => new SpicyWaitTimeoutError(id, timeoutMs, lastTask),
    );
    try {
      while (this.now() - startedAt < timeoutMs) {
        lastTask = await this.getTask(id, { signal: deadline.signal });
        if (options.onUpdate) {
          const task = lastTask;
          await waitForCallback(() => options.onUpdate!(task), deadline.signal);
        }
        deadline.signal.throwIfAborted();
        const pending =
          lastTask.state === "succeeded" &&
          lastTask.output?.assets?.some((asset) => asset.pending && !asset.unavailable);
        if (TERMINAL_STATES.has(lastTask.state) && !pending) return lastTask;
        const remaining = timeoutMs - (this.now() - startedAt);
        if (remaining <= 0) break;
        const delay =
          options.intervalMs === undefined
            ? Math.min(
                10_000,
                Math.round(intervalMs * 1.5 ** Math.min(attempt++, 5) * (1 + this.random() * 0.2)),
              )
            : intervalMs;
        await this.sleep(Math.min(delay, remaining), deadline.signal);
      }
      throw new SpicyWaitTimeoutError(id, timeoutMs, lastTask);
    } finally {
      deadline.dispose();
    }
  }

  async run(payload: CreateTaskInput, options: RunTaskOptions = {}): Promise<TaskRecord> {
    const { timeoutMs } = waitSettings(options);
    const startedAt = this.now();
    let accepted: CreateTaskResult | undefined;
    const deadline = deadlineSignal(timeoutMs, options.signal, () =>
      accepted
        ? new SpicyWaitTimeoutError(accepted.taskId, timeoutMs)
        : new SpicyTimeoutError(timeoutMs),
    );
    try {
      accepted = await this.createTask(payload, {
        idempotencyKey: options.idempotencyKey,
        ...(options.retentionSeconds === undefined
          ? {}
          : { retentionSeconds: options.retentionSeconds }),
        signal: deadline.signal,
      });
      if (options.onAccepted) {
        const task = accepted;
        await waitForCallback(() => options.onAccepted!(task), deadline.signal);
      }
      deadline.signal.throwIfAborted();
      const remaining = timeoutMs - (this.now() - startedAt);
      if (remaining <= 0) throw new SpicyWaitTimeoutError(accepted.taskId, timeoutMs);
      return await this.waitForTask(accepted.taskId, {
        ...options,
        timeoutMs: remaining,
        signal: deadline.signal,
      });
    } finally {
      deadline.dispose();
    }
  }

  createUploadUrl(
    contentType: UploadContentType,
    bytes: number,
    options: RequestOptions = {},
  ): Promise<UploadTicket> {
    return this.apiRequest<UploadTicket>("POST", "/common/upload-url", {
      body: { contentType, bytes },
      signal: options.signal,
    });
  }

  commitUploadedFile(fileId: string, options: RequestOptions = {}): Promise<UploadedFile> {
    const id = encodeURIComponent(requireIdentifier(fileId, "fileId"));
    return this.apiRequest<UploadedFile>("POST", `/files/${id}/commit`, {
      retryable: true,
      signal: options.signal,
    });
  }

  async uploadBytes(data: Uint8Array, options: UploadBytesOptions): Promise<UploadedFile> {
    const ticket = await this.createUploadUrl(options.contentType, data.byteLength, options);
    if (data.byteLength > ticket.maxBytes)
      throw new SpicyUploadError("file exceeds the upload ticket size limit", 413);
    const { response } = await this.fetchWithRetry(
      ticket.uploadUrl,
      {
        method: ticket.method,
        headers: ticket.headers,
        body: Uint8Array.from(data).buffer,
      },
      false,
      options.signal,
      // Moving bytes uses the upload timeout, not the 30 seconds meant for one API call.
      this.uploadTimeoutMs,
    );
    if (!response.ok) {
      throw new SpicyUploadError(
        `presigned upload failed with HTTP ${response.status}`,
        response.status,
      );
    }
    return this.commitUploadedFile(ticket.fileId, options);
  }

  async uploadFile(filePath: string, options: UploadFileOptions = {}): Promise<UploadedFile> {
    const data = await readFile(filePath);
    return this.uploadBytes(data, {
      contentType: options.contentType ?? inferContentType(filePath),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  }

  async uploadBase64(value: string, options: UploadFileOptions = {}): Promise<UploadedFile> {
    const media = decodeBase64Media(value, options.contentType);
    return this.uploadBytes(media.data, { contentType: media.contentType, signal: options.signal });
  }

  createDownloadUrl(
    taskId: string,
    key?: string,
    options: RequestOptions = {},
  ): Promise<DownloadTicket> {
    return this.apiRequest<DownloadTicket>("POST", "/common/download-url", {
      body: {
        taskId: requireIdentifier(taskId, "taskId"),
        ...(key === undefined ? {} : { key }),
      },
      signal: options.signal,
    });
  }

  private idempotencyHeaders(
    idempotencyKey: string | undefined,
  ): Record<string, string> | undefined {
    if (idempotencyKey === undefined) return undefined;
    return { "Idempotency-Key": requireIdentifier(idempotencyKey, "idempotencyKey") };
  }

  private async probe(path: ProbeResult["path"], signal?: AbortSignal): Promise<ProbeResult> {
    try {
      const { response, text } = await this.fetchWithRetry(
        `${this.serviceBaseUrl}${path}`,
        { method: "GET", headers: { Accept: "application/json, text/plain;q=0.9" } },
        true,
        signal,
      );
      const body = text.trim().slice(0, 512);
      return { path, ok: response.ok, status: response.status, body };
    } catch (error) {
      if (signal?.aborted) throw error;
      return {
        path,
        ok: false,
        status: 0,
        body: "",
        error: error instanceof Error ? error.message : "unknown probe error",
      };
    }
  }

  private async apiRequest<T>(
    method: "GET" | "POST",
    path: string,
    configuration: RequestConfiguration = {},
  ): Promise<T> {
    if (!this.apiKey)
      throw new TypeError("SPICY_API_KEY is required for authenticated API operations");
    const { response, text } = await this.fetchWithRetry(
      `${this.apiBaseUrl}${path}`,
      {
        method,
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${this.apiKey}`,
          "User-Agent": `SpicyAPI-Devkit/${SDK_VERSION}`,
          ...(configuration.body === undefined ? {} : { "Content-Type": "application/json" }),
          ...configuration.headers,
        },
        ...(configuration.body === undefined ? {} : { body: JSON.stringify(configuration.body) }),
      },
      configuration.retryable ?? false,
      configuration.signal,
      configuration.timeoutMs,
    );

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw notFromTheApi("API response was not valid JSON", response, text, this.proxyHint());
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw notFromTheApi("API response was not a JSON object", response, text, this.proxyHint());
    }

    const envelope = parsed as Partial<Envelope<T>>;
    const code = typeof envelope.code === "number" ? envelope.code : undefined;
    const requestId = typeof envelope.request_id === "string" ? envelope.request_id : undefined;
    const rateLimitLimit = parseIntegerHeader(response.headers.get("x-ratelimit-limit"));
    const rateLimitRemaining = parseIntegerHeader(response.headers.get("x-ratelimit-remaining"));
    try {
      void Promise.resolve(
        this.onResponse?.({
          method,
          path,
          status: response.status,
          ...(requestId === undefined ? {} : { requestId }),
          ...(rateLimitLimit === undefined ? {} : { rateLimitLimit }),
          ...(rateLimitRemaining === undefined ? {} : { rateLimitRemaining }),
        }),
      ).catch(() => {
        /* An asynchronous observability failure must not interrupt the business request either. */
      });
    } catch {
      /* Observability code must never hide an accepted task or trigger a duplicate call. */
    }
    /* Parsing is not the test; authorship is. An intermediary that speaks JSON - Cloudflare does,
       whenever the request asks for it - gets this far with a perfectly valid object that simply
       is not ours. Without this line it falls through to the generic status message below, which
       is the same dead end by a different route. Both markers are checked because an envelope
       missing `code` yet carrying `msg` is a platform response worth reporting as written. This
       sits after the observability hook so that a request stopped at the edge is still counted:
       the status is exactly what would let a caller notice the pattern on their own. */
    if (code === undefined && typeof envelope.msg !== "string") {
      throw notFromTheApi(
        "API response was not a SpicyAPI envelope",
        response,
        text,
        this.proxyHint(),
      );
    }
    if (!response.ok || code !== 200) {
      const retryAfterMs = parseRetryAfter(response.headers.get("retry-after"), this.now());
      throw new SpicyApiError(
        typeof envelope.msg === "string" && envelope.msg
          ? envelope.msg
          : `request failed with HTTP ${response.status}`,
        {
          status: response.status,
          ...(code === undefined ? {} : { code }),
          ...(requestId === undefined ? {} : { requestId }),
          ...(retryAfterMs === undefined ? {} : { retryAfterSeconds: retryAfterMs / 1_000 }),
          ...(rateLimitLimit === undefined ? {} : { rateLimitLimit }),
          ...(rateLimitRemaining === undefined ? {} : { rateLimitRemaining }),
        },
      );
    }
    if (!("data" in envelope)) {
      throw new SpicyApiError("successful API response omitted data", {
        status: response.status,
        ...(code === undefined ? {} : { code }),
        ...(requestId === undefined ? {} : { requestId }),
      });
    }
    return envelope.data;
  }

  private async fetchWithRetry(
    url: string,
    init: RequestInit,
    retryable: boolean,
    signal?: AbortSignal,
    timeoutMs?: number,
  ): Promise<{ response: Response; text: string }> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      try {
        const result = await this.fetchAttempt(url, init, signal, timeoutMs);
        const { response } = result;
        if (!retryable || !RETRYABLE_STATUSES.has(response.status) || attempt === this.maxRetries) {
          return result;
        }
        const retryAfter = parseRetryAfter(response.headers.get("retry-after"), this.now());
        // When the waiting ceiling is too low, hand the server's error back rather than retrying
        // early into the same rate-limit window.
        if (retryAfter !== undefined && retryAfter > this.maxRetryDelayMs) return result;
        await this.sleep(this.retryDelay(attempt, retryAfter), signal);
      } catch (error) {
        if (signal?.aborted) throw error;
        lastError = error;
        if (!retryable || attempt === this.maxRetries) throw error;
        await this.sleep(this.retryDelay(attempt), signal);
      }
    }
    throw new SpicyTransportError(this.networkFailureMessage(), {
      cause: lastError instanceof Error ? lastError : undefined,
    });
  }

  private async fetchAttempt(
    url: string,
    init: RequestInit,
    signal?: AbortSignal,
    timeoutMs: number = this.timeoutMs,
  ): Promise<{ response: Response; text: string }> {
    const controller = new AbortController();
    const onAbort = (): void => controller.abort(signal?.reason);
    signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(new SpicyTimeoutError(timeoutMs)), timeoutMs);
    try {
      if (signal?.aborted) controller.abort(signal.reason);
      controller.signal.throwIfAborted();
      const response = await this.transport(url, { ...init, signal: controller.signal });
      const text = await readResponseText(
        response,
        controller.signal,
        () => new SpicyTransportError(`API response exceeded ${MAX_API_RESPONSE_BYTES} bytes`),
      );
      return { response, text };
    } catch (error) {
      if (signal?.aborted) {
        throw signal.reason instanceof Error
          ? signal.reason
          : new SpicyTransportError("operation canceled");
      }
      if (controller.signal.reason instanceof SpicyTimeoutError) throw controller.signal.reason;
      if (error instanceof SpicyTransportError) throw error;
      throw new SpicyTransportError(this.networkFailureMessage(), {
        cause: error instanceof Error ? error : undefined,
      });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }

  /**
   * Only the runtime's own fetch can be ignoring a proxy. A caller that passed its own fetch may
   * route through one already, and would be told to fix something that is not broken.
   */
  private proxyHint(): string | undefined {
    return this.platformFetch ? unusedProxyHint() : undefined;
  }

  private networkFailureMessage(): string {
    const hint = this.proxyHint();
    return hint === undefined ? "network request failed" : `network request failed. ${hint}`;
  }

  private retryDelay(attempt: number, retryAfter?: number): number {
    if (retryAfter !== undefined) return retryAfter;
    const exponential = this.retryBaseDelayMs * 2 ** attempt;
    const jitter = 0.75 + this.random() * 0.5;
    return Math.min(Math.round(exponential * jitter), this.maxRetryDelayMs);
  }
}

/** Kept well under the envelope limit: a diagnostic, not a copy of whatever the edge served. */
const RETAINED_BODY_LIMIT = 512;

/**
 * Build the error for a reply that was not written by the platform.
 *
 * The lead sentence is the one the reader can act on. A caller behind a blocking edge gets `403`
 * and used to be told only that the response was not valid JSON, which reads as "the API is
 * broken" and sends everyone - including the caller's own assistant - to debug an endpoint that
 * never received the request. What they actually need to know first is that the service is not
 * offered everywhere; the evidence for that claim comes after it, not before.
 */
function notFromTheApi(
  reason: string,
  response: Response,
  text: string,
  proxyHint?: string,
): SpicyApiError {
  const described = describeForeignBody(text);
  /* The stop goes outside the quote unless the quoted text brought its own. */
  const quoted = `${described}${/[.!?]"?$/.test(described) ? "" : "."}`;
  const sentences =
    response.status === 403
      ? [
          "Refused before reaching SpicyAPI (HTTP 403). The service is not offered in every" +
            " region: https://spicyapi.ai/legal/terms.",
          `A proxy, gateway or CDN edge answered instead - ${quoted}`,
          /* Last, because it is a reason the request took the route it did, not the refusal. */
          ...(proxyHint === undefined ? [] : [proxyHint]),
        ]
      : [
          `${reason} (HTTP ${response.status}): ${quoted}`,
          "Every SpicyAPI response is a JSON envelope, so something between this client and the" +
            " API answered instead.",
        ];
  const body = text.trim().slice(0, RETAINED_BODY_LIMIT);
  return new SpicyApiError(sentences.join(" "), {
    status: response.status,
    ...(body === "" ? {} : { responseBody: body }),
  });
}
