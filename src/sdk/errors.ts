import type { components } from "../generated/openapi.js";
import type { TaskRecord } from "./types.js";

/** The reasons the bundled contract lists for a failure envelope's `data.reason`. */
type ContractErrorReason = NonNullable<components["schemas"]["ErrorEnvelope"]["data"]>["reason"];

/**
 * Machine-readable reasons the asset library attaches to a failed response as `data.reason`.
 *
 * - `asset_library_locked` (400): the library opens after the owner's first top-up.
 * - `asset_library_full` (400): the allowance's storage or item count is used up.
 * - `asset_file_too_large` (400): the file is above the plan's per-file limit.
 * - `asset_daily_limit` (429): today's (UTC) allowance of new assets is used up; see `Retry-After`.
 * - `asset_storage_full` (503): storage is temporarily full across the platform.
 * - `asset_permission_denied` (403): the key's team role does not allow this change.
 * - `asset_workspace_forbidden` (403): this key or workspace cannot reach that library.
 * - `asset_entity_name_taken` (409): the library already has a character with that name, ignoring
 *   case. Characters are named in the console, so the read-only API does not return it today.
 *
 * The list matches the bundled contract (a test compares them). The server may add reasons later,
 * so treat the set as open: {@link SpicyApiError.reason} carries any string the server sends,
 * unchanged, and an unknown one is best handled like an absent reason.
 */
export const ASSET_ERROR_REASONS = [
  "asset_library_locked",
  "asset_library_full",
  "asset_file_too_large",
  "asset_daily_limit",
  "asset_storage_full",
  "asset_permission_denied",
  "asset_workspace_forbidden",
  "asset_entity_name_taken",
] as const satisfies readonly ContractErrorReason[];

export type AssetErrorReason = (typeof ASSET_ERROR_REASONS)[number];

/** A known reason, or any other string the server sends (kept verbatim, never dropped). */
export type SpicyErrorReason = AssetErrorReason | (string & {});

export function isAssetErrorReason(value: unknown): value is AssetErrorReason {
  return typeof value === "string" && (ASSET_ERROR_REASONS as readonly string[]).includes(value);
}

export interface SpicyApiErrorOptions {
  status: number;
  code?: number | undefined;
  requestId?: string | undefined;
  retryAfterSeconds?: number | undefined;
  rateLimitLimit?: number | undefined;
  rateLimitRemaining?: number | undefined;
  reason?: SpicyErrorReason | undefined;
  /**
   * The raw reply, truncated, and only when it was not the platform's JSON envelope - which means
   * it was not written by the platform. It names the layer that answered instead.
   */
  responseBody?: string | undefined;
}

export class SpicyApiError extends Error {
  readonly status: number;
  readonly code: number | undefined;
  readonly requestId: string | undefined;
  readonly retryAfterSeconds: number | undefined;
  readonly rateLimitLimit: number | undefined;
  readonly rateLimitRemaining: number | undefined;
  /**
   * The failure envelope's `data.reason`, when the server sent one. Branch on this rather than
   * on `message`, which follows the account's error language. See {@link ASSET_ERROR_REASONS}
   * for the values in use today; an unknown value is passed through as-is.
   */
  readonly reason: SpicyErrorReason | undefined;
  readonly responseBody: string | undefined;

  constructor(message: string, options: SpicyApiErrorOptions) {
    super(message);
    this.name = "SpicyApiError";
    this.status = options.status;
    this.code = options.code;
    this.requestId = options.requestId;
    this.retryAfterSeconds = options.retryAfterSeconds;
    this.rateLimitLimit = options.rateLimitLimit;
    this.rateLimitRemaining = options.rateLimitRemaining;
    this.reason = options.reason;
    this.responseBody = options.responseBody;
  }
}

export class SpicyTransportError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SpicyTransportError";
  }
}

export class SpicyTimeoutError extends SpicyTransportError {
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(`request exceeded the local ${timeoutMs}ms timeout`);
    this.name = "SpicyTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

export class SpicyWaitTimeoutError extends Error {
  readonly taskId: string;
  readonly timeoutMs: number;
  readonly lastTask: TaskRecord | undefined;

  constructor(taskId: string, timeoutMs: number, lastTask?: TaskRecord) {
    super(`task ${taskId} did not reach a terminal state within ${timeoutMs}ms`);
    this.name = "SpicyWaitTimeoutError";
    this.taskId = taskId;
    this.timeoutMs = timeoutMs;
    this.lastTask = lastTask;
  }
}

export class SpicyUploadError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "SpicyUploadError";
    this.status = status;
  }
}
