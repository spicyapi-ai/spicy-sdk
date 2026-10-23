import { randomUUID } from "node:crypto";
import { basename } from "node:path";

import { requireIdentifier } from "./identifiers.js";
import type {
  Asset,
  AssetCharacter,
  AssetCharacterList,
  AssetDeleted,
  AssetList,
  AssetUsage,
  CreateAssetInput,
  CreateAssetOptions,
  ListAssetCharactersOptions,
  ListAssetsOptions,
  RequestOptions,
  SaveAssetFileOptions,
  UpdateAssetInput,
  UploadedFile,
  UploadFileOptions,
} from "./types.js";

/** Prefix of a saved asset's stable reference, as in `spicy://a/ast_…`. */
export const ASSET_URI_PREFIX = "spicy://a/";

const ASSET_NAME_MAX_CHARS = 80;

/** One authenticated JSON call, as the client performs it. */
export type AssetApiRequest = <T>(
  method: "GET" | "POST" | "PATCH" | "DELETE",
  path: string,
  configuration: {
    body?: unknown;
    headers?: Record<string, string> | undefined;
    retryable?: boolean;
    signal?: AbortSignal | undefined;
  },
) => Promise<T>;

/** What the asset namespace needs from the client that owns it. */
export interface AssetTransport {
  request: AssetApiRequest;
  uploadFile: (filePath: string, options: UploadFileOptions) => Promise<UploadedFile>;
}

/**
 * Accept either the bare id (`ast_…`) or the reference you put in model inputs
 * (`spicy://a/ast_…`), so a value copied from either place works.
 */
function bareAssetId(value: string): string {
  const trimmed = requireIdentifier(value, "assetId");
  return trimmed.startsWith(ASSET_URI_PREFIX)
    ? requireIdentifier(trimmed.slice(ASSET_URI_PREFIX.length), "assetId")
    : trimmed;
}

function assetPath(value: string): string {
  return `/assets/${encodeURIComponent(bareAssetId(value))}`;
}

/**
 * Follow `nextCursor` until the last page. A cursor that comes back twice would loop forever and
 * burn the rate limit for nothing, so it is refused.
 */
async function* everyPage<T>(
  firstCursor: string | undefined,
  fetchPage: (cursor: string | undefined) => Promise<{ items: T[]; nextCursor?: string }>,
  what: string,
): AsyncGenerator<T, void, undefined> {
  const seen = new Set<string>();
  let cursor = firstCursor;
  for (;;) {
    const page = await fetchPage(cursor);
    yield* page.items;
    const next = page.nextCursor;
    if (!next) return;
    if (seen.has(next)) throw new TypeError(`${what} returned a cursor it had already returned`);
    seen.add(next);
    cursor = next;
  }
}

/**
 * The characters of the library the key reaches: named sets of images arranged in the console,
 * read-only through the API. A character references assets instead of copying them, so each image
 * carries its own `spicy://a/<id>` `uri`. To use a character in a generation request, put the
 * `uri` of its images, in order, into the model's reference image field.
 *
 * Personas became characters in the personal library on 2026-10-12. Existing `spicy://p/<id>`
 * references keep resolving to the same images; new code should use the `spicy://a/` references
 * listed here.
 *
 * Reach it as `client.assets.characters`; it is not meant to be constructed directly.
 */
export class SpicyAssetCharacters {
  readonly #transport: AssetTransport;

  constructor(transport: AssetTransport) {
    this.#transport = transport;
  }

  /** One page of characters, newest first. Continue with `nextCursor`, or use {@link listAll}. */
  async list(options: ListAssetCharactersOptions = {}): Promise<AssetCharacterList> {
    const query = new URLSearchParams();
    if (options.assetId !== undefined) query.set("assetId", bareAssetId(options.assetId));
    if (options.cursor !== undefined) query.set("cursor", options.cursor);
    if (options.limit !== undefined) query.set("limit", String(options.limit));
    return await this.#transport.request<AssetCharacterList>(
      "GET",
      `/assets/entities${query.size ? `?${query}` : ""}`,
      { retryable: true, signal: options.signal },
    );
  }

  /** Every character, page by page. `limit` sets the page size, not the total. */
  listAll(
    options: ListAssetCharactersOptions = {},
  ): AsyncGenerator<AssetCharacter, void, undefined> {
    return everyPage(
      options.cursor,
      (cursor) => this.list({ ...options, cursor }),
      "character listing",
    );
  }

  /**
   * One character with its images in order, each with a fresh private `previewUrl`. An unknown
   * character, and one outside the key's library, are both answered with 404.
   */
  async get(characterId: string, options: RequestOptions = {}): Promise<AssetCharacter> {
    const id = requireIdentifier(characterId, "characterId");
    return await this.#transport.request<AssetCharacter>(
      "GET",
      `/assets/entities/${encodeURIComponent(id)}`,
      { retryable: true, signal: options.signal },
    );
  }
}

/** Cut on code points, not UTF-16 units, so a name never ends in half an emoji. */
function defaultAssetName(filePath: string): string | undefined {
  const name = basename(filePath).trim();
  if (!name) return undefined;
  return Array.from(name).slice(0, ASSET_NAME_MAX_CHARS).join("");
}

/**
 * The asset library the key reaches: the personal library for a personal key, the team's shared
 * library for a team key. Files are kept until they are deleted, each with a stable `spicy://a/<id>`
 * reference that works in any media field of model inputs sent with keys of the same workspace. With
 * a team key, the creator's current role decides what may change (see `usage().scope`).
 *
 * Reach it as `client.assets`; it is not meant to be constructed directly. Responses never contain
 * a public or permanent link. `previewUrl` is a private preview signed for at most 20 minutes, so
 * store `uri`, never `previewUrl`.
 *
 * Every method returns a promise; invalid arguments reject it rather than throwing synchronously.
 */
export class SpicyAssets {
  readonly #transport: AssetTransport;
  /** Read-only access to the library's characters. */
  readonly characters: SpicyAssetCharacters;

  constructor(transport: AssetTransport) {
    this.#transport = transport;
    this.characters = new SpicyAssetCharacters(transport);
  }

  /**
   * Save a file to the library. Saving the same source again returns the asset you already have
   * and uses no extra space.
   *
   * The server requires `Idempotency-Key` on every save; one is generated when
   * `options.idempotencyKey` is omitted, which also makes the transport-level retry safe.
   */
  async create(input: CreateAssetInput, options: CreateAssetOptions = {}): Promise<Asset> {
    const idempotencyKey =
      options.idempotencyKey === undefined
        ? randomUUID()
        : requireIdentifier(options.idempotencyKey, "idempotencyKey");
    return await this.#transport.request<Asset>("POST", "/assets", {
      body: input,
      headers: { "Idempotency-Key": idempotencyKey },
      retryable: true,
      signal: options.signal,
    });
  }

  /**
   * One page of ready assets, newest first unless `sort` says otherwise. Continue with
   * `nextCursor` and the same filters and `sort`, or use {@link listAll}.
   */
  async list(options: ListAssetsOptions = {}): Promise<AssetList> {
    const query = new URLSearchParams();
    if (options.kind !== undefined) query.set("kind", options.kind);
    if (options.source !== undefined) {
      const sources: readonly string[] =
        typeof options.source === "string" ? [options.source] : options.source;
      if (sources.length > 0) query.set("source", sources.join(","));
    }
    if (options.q !== undefined) query.set("q", options.q);
    if (options.favorite !== undefined) query.set("favorite", String(options.favorite));
    if (options.collectionId !== undefined) {
      query.set("collectionId", requireIdentifier(options.collectionId, "collectionId"));
    }
    if (options.entityId !== undefined) {
      query.set("entityId", requireIdentifier(options.entityId, "entityId"));
    }
    if (options.sort !== undefined) query.set("sort", options.sort);
    if (options.cursor !== undefined) query.set("cursor", options.cursor);
    if (options.limit !== undefined) query.set("limit", String(options.limit));
    return await this.#transport.request<AssetList>(
      "GET",
      `/assets${query.size ? `?${query}` : ""}`,
      {
        retryable: true,
        signal: options.signal,
      },
    );
  }

  /**
   * Every matching asset, page by page, following `nextCursor` until the last page. `limit` sets
   * the page size, not the total; stop iterating to stop fetching.
   */
  listAll(options: ListAssetsOptions = {}): AsyncGenerator<Asset, void, undefined> {
    return everyPage(
      options.cursor,
      (cursor) => this.list({ ...options, cursor }),
      "asset listing",
    );
  }

  /** One asset with a fresh private `previewUrl`. Accepts `ast_…` or `spicy://a/ast_…`. */
  async get(assetId: string, options: RequestOptions = {}): Promise<Asset> {
    return await this.#transport.request<Asset>("GET", assetPath(assetId), {
      retryable: true,
      signal: options.signal,
    });
  }

  /**
   * Rename an asset, mark or unmark it as a favorite, or both. Only the fields you pass change;
   * the `uri` stays the same and repeating the request is safe.
   */
  async update(id: string, input: UpdateAssetInput, options: RequestOptions = {}): Promise<Asset> {
    const body: { name?: string; favorite?: boolean } = {};
    if (input.name !== undefined) body.name = input.name;
    if (input.favorite !== undefined) body.favorite = input.favorite;
    if (body.name === undefined && body.favorite === undefined) {
      throw new TypeError("update needs a name, a favorite flag, or both");
    }
    return await this.#transport.request<Asset>("PATCH", assetPath(id), {
      body,
      retryable: true,
      signal: options.signal,
    });
  }

  /**
   * Delete an asset. It disappears at once and its `uri` stops working in new requests. Deleting
   * an unknown or already deleted asset returns the same result, so repeating it is safe.
   */
  async delete(assetId: string, options: RequestOptions = {}): Promise<AssetDeleted> {
    return await this.#transport.request<AssetDeleted>("DELETE", assetPath(assetId), {
      retryable: true,
      signal: options.signal,
    });
  }

  /** Your storage plan, what you have stored, the limits and how many assets you saved today. */
  usage(options: RequestOptions = {}): Promise<AssetUsage> {
    return this.#transport.request<AssetUsage>("GET", "/assets/usage", {
      retryable: true,
      signal: options.signal,
    });
  }

  /**
   * Upload a local file and save it to the library in one call.
   *
   * Uploads go through the same flow as `client.uploadFile`, so its type and size limits apply.
   * Every call uploads again, so there is no idempotency key to pass: the save step uses a fresh
   * one for its own retries.
   */
  async uploadFile(filePath: string, options: SaveAssetFileOptions = {}): Promise<Asset> {
    const uploaded = await this.#transport.uploadFile(filePath, {
      ...(options.contentType === undefined ? {} : { contentType: options.contentType }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    const name = options.name ?? defaultAssetName(filePath);
    return this.create(
      { source: "upload", fileId: uploaded.fileId, ...(name === undefined ? {} : { name }) },
      { signal: options.signal },
    );
  }
}
