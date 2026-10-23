import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import YAML from "yaml";

import {
  ASSET_ERROR_REASONS,
  ASSET_URI_PREFIX,
  SpicyApiError,
  SpicyClient,
  isAssetErrorReason,
  readOpenApiContract,
  type Asset,
  type AssetCharacter,
  type AssetUsage,
} from "../src/index.js";

interface FetchCall {
  url: string;
  method: string;
  headers: Headers;
  body: unknown;
}

const API = "http://127.0.0.1:4011/api/v1";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function envelope(data: unknown): Response {
  return Response.json({ code: 200, msg: "success", data, request_id: "req_asset" });
}

function failure(
  status: number,
  extra: Record<string, unknown> = {},
  headers: Record<string, string> = {},
): Response {
  return Response.json(
    { code: status, msg: "refused by the asset library", request_id: "req_fail", ...extra },
    { status, headers },
  );
}

function scripted(responses: Array<Response | ((call: FetchCall) => Response)>): {
  calls: FetchCall[];
  fetch: typeof fetch;
} {
  const calls: FetchCall[] = [];
  const implementation: typeof fetch = (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const raw = init?.body;
    const call: FetchCall = {
      url,
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      body: typeof raw === "string" ? JSON.parse(raw) : raw,
    };
    calls.push(call);
    const next = responses.shift();
    assert.ok(next, `unexpected request to ${url}`);
    return Promise.resolve(typeof next === "function" ? next(call) : next);
  };
  return { calls, fetch: implementation };
}

function client(fetchImplementation: typeof fetch, maxRetries = 0): SpicyClient {
  return new SpicyClient({
    apiKey: "sk_assets_secret",
    apiBaseUrl: API,
    serviceBaseUrl: "http://127.0.0.1:4011",
    fetch: fetchImplementation,
    maxRetries,
    sleep: () => Promise.resolve(),
  });
}

function asset(id = "ast_hero", overrides: Partial<Asset> = {}): Asset {
  return {
    id,
    uri: `${ASSET_URI_PREFIX}${id}`,
    name: "Hero portrait",
    kind: "image",
    contentType: "image/png",
    bytes: 1843201,
    width: 1536,
    height: 1024,
    source: "task_output",
    sourceId: "job_1",
    createdAt: "2026-10-11T08:20:11Z",
    updatedAt: "2026-10-11T08:20:11Z",
    previewUrl: "https://preview.example/private",
    favorite: false,
    model: "bytedance/seedream-5.0-pro/text-to-image",
    modelName: "Seedream 5.0 Pro",
    ...overrides,
  };
}

function character(id = "ety_mia", overrides: Partial<AssetCharacter> = {}): AssetCharacter {
  const images = [asset("ast_front"), asset("ast_side")];
  return {
    id,
    kind: "character",
    name: "Mia",
    note: "",
    coverAssetId: "ast_front",
    cover: images[0] ?? null,
    assets: images,
    count: images.length,
    createdAt: "2026-10-12T08:00:00Z",
    updatedAt: "2026-10-12T08:00:00Z",
    ...overrides,
  };
}

void test("create posts the source and generates an Idempotency-Key when none is given", async () => {
  const mock = scripted([envelope(asset()), envelope(asset())]);
  const assets = client(mock.fetch).assets;

  const saved = await assets.create({ source: "task_output", taskId: "job_1", index: 0 });
  await assets.create({ source: "task_output", taskId: "job_1", index: 0 });

  assert.equal(saved.uri, "spicy://a/ast_hero");
  assert.equal(mock.calls[0]?.url, `${API}/assets`);
  assert.equal(mock.calls[0]?.method, "POST");
  assert.deepEqual(mock.calls[0]?.body, { source: "task_output", taskId: "job_1", index: 0 });
  const first = mock.calls[0]?.headers.get("idempotency-key") ?? "";
  const second = mock.calls[1]?.headers.get("idempotency-key") ?? "";
  assert.match(first, UUID);
  assert.match(second, UUID);
  // Counter-proof: a generated key is per call, never a constant that would replay the first save.
  assert.notEqual(first, second);
});

void test("create sends a caller-supplied Idempotency-Key unchanged and refuses a blank one", async () => {
  const mock = scripted([envelope(asset())]);
  const assets = client(mock.fetch).assets;

  await assets.create(
    { source: "url", url: "https://cdn.example/still.png", name: "Still" },
    { idempotencyKey: "save-still-1" },
  );
  assert.equal(mock.calls[0]?.headers.get("idempotency-key"), "save-still-1");
  assert.deepEqual(mock.calls[0]?.body, {
    source: "url",
    url: "https://cdn.example/still.png",
    name: "Still",
  });

  await assert.rejects(
    assets.create({ source: "upload", fileId: "fil_1" }, { idempotencyKey: "   " }),
    /idempotencyKey is required/,
  );
  assert.equal(mock.calls.length, 1, "a blank key must fail before any request is sent");
});

void test("a transport retry of create replays the same Idempotency-Key", async () => {
  const mock = scripted([failure(503), envelope(asset())]);
  await client(mock.fetch, 1).assets.create({ source: "upload", fileId: "fil_1" });

  assert.equal(mock.calls.length, 2);
  const keys = mock.calls.map((call) => call.headers.get("idempotency-key"));
  assert.match(keys[0] ?? "", UUID);
  assert.equal(keys[0], keys[1], "a retry with a new key could save the file twice");
});

void test("list encodes every filter and joins several sources with commas", async () => {
  const mock = scripted([
    envelope({ items: [asset()], nextCursor: "c2" }),
    envelope({ items: [] }),
  ]);
  const assets = client(mock.fetch).assets;

  const page = await assets.list({
    kind: "image",
    source: ["task_output", "url"],
    q: "hero portrait",
    cursor: "c1",
    limit: 20,
  });
  await assets.list();

  assert.equal(page.nextCursor, "c2");
  const url = new URL(mock.calls[0]?.url ?? "");
  assert.equal(url.pathname, "/api/v1/assets");
  assert.equal(url.searchParams.get("kind"), "image");
  assert.equal(url.searchParams.get("source"), "task_output,url");
  assert.equal(url.searchParams.get("q"), "hero portrait");
  assert.equal(url.searchParams.get("cursor"), "c1");
  assert.equal(url.searchParams.get("limit"), "20");
  assert.equal(mock.calls[1]?.url, `${API}/assets`, "no filters means no query string");
});

void test("list sends the favorite, folder, character and sort filters in the query string", async () => {
  const mock = scripted([
    envelope({ items: [asset("ast_hero", { favorite: true })] }),
    envelope({ items: [] }),
  ]);
  const assets = client(mock.fetch).assets;

  const page = await assets.list({
    favorite: true,
    collectionId: " col_moodboard ",
    entityId: "ety_mia",
    sort: "name",
    q: "hero",
  });
  await assets.list({ favorite: false, sort: "size" });

  assert.equal(page.items[0]?.favorite, true);
  const first = new URL(mock.calls[0]?.url ?? "");
  assert.equal(first.searchParams.get("favorite"), "true");
  assert.equal(first.searchParams.get("collectionId"), "col_moodboard");
  assert.equal(first.searchParams.get("entityId"), "ety_mia");
  assert.equal(first.searchParams.get("sort"), "name");
  assert.equal(first.searchParams.get("q"), "hero");
  // Counter-proof: `false` is a filter of its own ("not favorites"), so it must be sent, not dropped.
  const second = new URL(mock.calls[1]?.url ?? "");
  assert.equal(second.searchParams.get("favorite"), "false");
  assert.equal(second.searchParams.get("sort"), "size");
  assert.equal(second.searchParams.has("collectionId"), false);
});

void test("a blank folder id is refused locally and an unknown folder's 404 is thrown as-is", async () => {
  const mock = scripted([failure(404, { msg: "collection not found" })]);
  const assets = client(mock.fetch, 2).assets;

  await assert.rejects(assets.list({ collectionId: "  " }), /collectionId is required/);
  assert.equal(mock.calls.length, 0, "a blank folder id must fail before any request is sent");

  await assert.rejects(assets.list({ collectionId: "col_elsewhere" }), (error: unknown) => {
    assert.ok(error instanceof SpicyApiError);
    assert.equal(error.status, 404);
    return true;
  });
  assert.equal(mock.calls.length, 1, "a 404 is not retried");
});

void test("listAll keeps the sort on every page, and a cursor from another sort fails with 400", async () => {
  const mock = scripted([
    envelope({ items: [asset("ast_a")], nextCursor: "name-c2" }),
    envelope({ items: [asset("ast_b")] }),
  ]);
  const ids: string[] = [];
  for await (const item of client(mock.fetch).assets.listAll({ sort: "name", favorite: true })) {
    ids.push(item.id);
  }
  assert.deepEqual(ids, ["ast_a", "ast_b"]);
  assert.ok(
    mock.calls.every((call) => {
      const query = new URL(call.url).searchParams;
      return query.get("sort") === "name" && query.get("favorite") === "true";
    }),
    "every page must repeat the sort and filters the cursor was issued for",
  );

  const stale = scripted([failure(400, { msg: "cursor is invalid" })]);
  await assert.rejects(
    client(stale.fetch, 2).assets.list({ sort: "oldest", cursor: "name-c2" }),
    (error: unknown) => {
      assert.ok(error instanceof SpicyApiError);
      assert.equal(error.status, 400);
      assert.equal(error.code, 400);
      assert.equal(error.requestId, "req_fail");
      return true;
    },
  );
  assert.equal(stale.calls.length, 1, "a rejected cursor is not retried");
  const sent = new URL(stale.calls[0]?.url ?? "").searchParams;
  assert.equal(sent.get("sort"), "oldest");
  assert.equal(sent.get("cursor"), "name-c2");
});

void test("listAll follows nextCursor to the last page and keeps the filters", async () => {
  const mock = scripted([
    envelope({ items: [asset("ast_1"), asset("ast_2")], nextCursor: "c2" }),
    envelope({ items: [asset("ast_3")], nextCursor: "c3" }),
    envelope({ items: [asset("ast_4")] }),
  ]);

  const ids: string[] = [];
  for await (const item of client(mock.fetch).assets.listAll({ kind: "video", limit: 2 })) {
    ids.push(item.id);
  }

  assert.deepEqual(ids, ["ast_1", "ast_2", "ast_3", "ast_4"]);
  const cursors = mock.calls.map((call) => new URL(call.url).searchParams.get("cursor"));
  assert.deepEqual(cursors, [null, "c2", "c3"]);
  assert.ok(mock.calls.every((call) => new URL(call.url).searchParams.get("kind") === "video"));
});

void test("listAll stops when the caller stops and refuses a cursor that repeats", async () => {
  const early = scripted([envelope({ items: [asset("ast_1"), asset("ast_2")], nextCursor: "c2" })]);
  for await (const item of client(early.fetch).assets.listAll()) {
    assert.equal(item.id, "ast_1");
    break;
  }
  assert.equal(early.calls.length, 1, "breaking out must not fetch the next page");

  const looping = scripted([
    envelope({ items: [asset("ast_1")], nextCursor: "same" }),
    envelope({ items: [asset("ast_2")], nextCursor: "same" }),
  ]);
  const seen: string[] = [];
  await assert.rejects(async () => {
    for await (const item of client(looping.fetch).assets.listAll()) seen.push(item.id);
  }, /cursor it had already returned/);
  assert.deepEqual(seen, ["ast_1", "ast_2"]);
});

void test("get, update and delete address one asset by id or by its spicy://a/ reference", async () => {
  const mock = scripted([
    envelope(asset()),
    envelope(asset("ast_hero", { name: "Hero v2" })),
    envelope({ id: "ast_hero", deleted: true }),
  ]);
  const assets = client(mock.fetch).assets;

  await assets.get("ast_hero");
  const renamed = await assets.update("spicy://a/ast_hero", { name: "Hero v2" });
  const deleted = await assets.delete("  ast_hero  ");

  assert.equal(renamed.name, "Hero v2");
  assert.deepEqual(deleted, { id: "ast_hero", deleted: true });
  assert.deepEqual(
    mock.calls.map((call) => `${call.method} ${call.url}`),
    [`GET ${API}/assets/ast_hero`, `PATCH ${API}/assets/ast_hero`, `DELETE ${API}/assets/ast_hero`],
  );
  assert.deepEqual(mock.calls[1]?.body, { name: "Hero v2" });
  // Rename and delete are safe to repeat, so they carry no Idempotency-Key.
  assert.equal(mock.calls[1]?.headers.has("idempotency-key"), false);
  assert.equal(mock.calls[2]?.headers.has("idempotency-key"), false);
});

void test("update sends only the fields given, so a favorite toggle leaves the name alone", async () => {
  const mock = scripted([
    envelope(asset("ast_hero", { favorite: true })),
    envelope(asset("ast_hero", { favorite: false, name: "Hero v3" })),
  ]);
  const assets = client(mock.fetch).assets;

  const starred = await assets.update("spicy://a/ast_hero", { favorite: true });
  await assets.update("ast_hero", { name: "Hero v3", favorite: false });

  assert.equal(starred.favorite, true);
  assert.deepEqual(mock.calls[0]?.body, { favorite: true });
  assert.equal(
    Object.hasOwn(mock.calls[0]?.body as object, "name"),
    false,
    "a favorite-only update must not send a name",
  );
  assert.deepEqual(mock.calls[1]?.body, { name: "Hero v3", favorite: false });

  // A JavaScript caller can still pass neither; the server would answer with a misleading
  // "invalid name", so the SDK refuses it before sending anything.
  await assert.rejects(
    assets.update("ast_hero", {} as unknown as { favorite: boolean }),
    /needs a name, a favorite flag, or both/,
  );
  assert.equal(mock.calls.length, 2);
});

void test("characters.list reads one page and characters.get one character with its images", async () => {
  const mock = scripted([
    envelope({ items: [character()], nextCursor: "ec2" }),
    envelope(character()),
    envelope({ items: [] }),
  ]);
  const characters = client(mock.fetch).assets.characters;

  const page = await characters.list({ assetId: "spicy://a/ast_front", limit: 10, cursor: "ec1" });
  const one = await characters.get(" ety_mia ");
  await characters.list();

  assert.equal(page.nextCursor, "ec2");
  assert.deepEqual(
    one.assets.map((image) => image.uri),
    ["spicy://a/ast_front", "spicy://a/ast_side"],
  );
  const listed = new URL(mock.calls[0]?.url ?? "");
  assert.equal(listed.pathname, "/api/v1/assets/entities");
  assert.equal(
    listed.searchParams.get("assetId"),
    "ast_front",
    "a spicy://a/ reference is unwrapped",
  );
  assert.equal(listed.searchParams.get("limit"), "10");
  assert.equal(listed.searchParams.get("cursor"), "ec1");
  assert.equal(mock.calls[1]?.url, `${API}/assets/entities/ety_mia`);
  assert.equal(mock.calls[1]?.method, "GET");
  assert.equal(mock.calls[2]?.url, `${API}/assets/entities`, "no filters means no query string");
});

void test("characters.listAll follows nextCursor and refuses a cursor that repeats", async () => {
  const mock = scripted([
    envelope({ items: [character("ety_1")], nextCursor: "ec2" }),
    envelope({ items: [character("ety_2")] }),
  ]);
  const ids: string[] = [];
  for await (const item of client(mock.fetch).assets.characters.listAll({ limit: 1 })) {
    ids.push(item.id);
  }
  assert.deepEqual(ids, ["ety_1", "ety_2"]);
  assert.deepEqual(
    mock.calls.map((call) => new URL(call.url).searchParams.get("cursor")),
    [null, "ec2"],
  );

  const looping = scripted([
    envelope({ items: [character("ety_1")], nextCursor: "same" }),
    envelope({ items: [character("ety_2")], nextCursor: "same" }),
  ]);
  await assert.rejects(async () => {
    for await (const item of client(looping.fetch).assets.characters.listAll()) void item;
  }, /character listing returned a cursor it had already returned/);
});

void test("an unknown character is a 404 thrown as-is, and a blank id is refused locally", async () => {
  const mock = scripted([failure(404, { msg: "character not found" })]);
  const characters = client(mock.fetch, 2).assets.characters;

  await assert.rejects(characters.get("ety_gone"), (error: unknown) => {
    assert.ok(error instanceof SpicyApiError);
    assert.equal(error.status, 404);
    assert.equal(error.code, 404);
    return true;
  });
  assert.equal(mock.calls.length, 1, "a 404 is not retried");
  assert.equal(mock.calls[0]?.url, `${API}/assets/entities/ety_gone`);

  await assert.rejects(characters.get("   "), /characterId is required/);
  assert.equal(mock.calls.length, 1);
});

void test("asset ids are path-encoded and an empty reference is refused locally", async () => {
  const mock = scripted([envelope(asset())]);
  const assets = client(mock.fetch).assets;

  await assets.get("ast_a/../b");
  assert.equal(mock.calls[0]?.url, `${API}/assets/ast_a%2F..%2Fb`);

  await assert.rejects(assets.get("spicy://a/"), /assetId is required/);
  await assert.rejects(assets.delete(" "), /assetId is required/);
  assert.equal(mock.calls.length, 1);
});

void test("usage reads the plan, limits and today's count", async () => {
  const plan = {
    id: "plus",
    name: "Plus",
    minTopupUsd: "10",
    maxBytes: 524288000,
    maxCount: 200,
    maxFileBytes: 104857600,
  };
  const mock = scripted([
    envelope({
      tier: plan,
      usage: { count: 3, bytes: 4096 },
      limits: {
        tier: "plus",
        maxCount: 200,
        maxBytes: 524288000,
        maxFileBytes: 104857600,
        globalMaxBytes: 0,
        nameMaxChars: 80,
      },
      full: false,
      nextTier: null,
      tiers: [plan],
      dailyCreateLimit: 200,
      createdToday: 1,
      lifetimeTopupUsd: "25",
      scope: {
        workspaceId: "ws_me",
        personal: true,
        role: "owner",
        canWrite: true,
        canTopUp: true,
      },
    }),
  ]);

  const usage = await client(mock.fetch).assets.usage();

  assert.equal(mock.calls[0]?.url, `${API}/assets/usage`);
  assert.equal(usage.tier.name, "Plus");
  assert.equal(usage.lifetimeTopupUsd, "25");
  assert.equal(usage.nextTier, null);
  assert.equal(usage.scope.personal, true);
});

void test("usage from a team key without top-up rights omits the two amounts", async () => {
  const plan = {
    id: "plus",
    name: "Plus",
    minTopupUsd: "10",
    maxBytes: 524288000,
    maxCount: 200,
    maxFileBytes: 104857600,
  };
  const mock = scripted([
    envelope({
      tier: plan,
      usage: { count: 3, bytes: 4096 },
      limits: {
        tier: "plus",
        maxCount: 200,
        maxBytes: 524288000,
        maxFileBytes: 104857600,
        globalMaxBytes: 0,
        nameMaxChars: 80,
      },
      full: false,
      nextTier: { ...plan, id: "pro", name: "Pro", minTopupUsd: "100" },
      tiers: [plan],
      dailyCreateLimit: 200,
      createdToday: 0,
      scope: {
        workspaceId: "ws_team",
        personal: false,
        role: "developer",
        canWrite: true,
        canTopUp: false,
      },
    }),
  ]);

  const usage: AssetUsage = await client(mock.fetch).assets.usage();

  assert.equal(usage.scope.canTopUp, false);
  assert.equal(usage.scope.role, "developer");
  assert.equal(usage.lifetimeTopupUsd, undefined);
  assert.equal(usage.topupToNextTierUsd, undefined);
});

void test("the exported reasons match the bundled contract's enum exactly", async () => {
  const contract = YAML.parse(await readOpenApiContract()) as {
    components: {
      schemas: {
        ErrorEnvelope: {
          allOf: Array<{
            properties?: { data?: { properties?: { reason?: { enum?: string[] } } } };
          }>;
        };
      };
    };
  };
  const listed = contract.components.schemas.ErrorEnvelope.allOf
    .map((part) => part.properties?.data?.properties?.reason?.enum)
    .find((values) => values !== undefined);
  assert.ok(listed, "the contract no longer declares data.reason");
  assert.deepEqual([...ASSET_ERROR_REASONS].sort(), [...listed].sort());
});

void test("a failure's data.reason becomes SpicyApiError.reason, unknown values included", async () => {
  const mock = scripted([
    failure(400, { data: { reason: "asset_library_full" } }),
    failure(400, { data: { reason: "asset_reason_from_the_future" } }),
    failure(400),
    failure(400, { data: { reason: 42 } }),
  ]);
  const assets = client(mock.fetch).assets;
  const reasons: unknown[] = [];
  for (let index = 0; index < 4; index += 1) {
    await assert.rejects(assets.create({ source: "upload", fileId: "fil_1" }), (error: unknown) => {
      assert.ok(error instanceof SpicyApiError);
      assert.equal(error.status, 400);
      assert.equal(error.code, 400);
      assert.equal(error.requestId, "req_fail");
      reasons.push(error.reason);
      return true;
    });
  }

  assert.deepEqual(reasons, [
    "asset_library_full",
    "asset_reason_from_the_future",
    undefined,
    undefined,
  ]);
  assert.equal(isAssetErrorReason("asset_library_full"), true);
  assert.equal(isAssetErrorReason("asset_reason_from_the_future"), false);
  assert.equal(ASSET_ERROR_REASONS.length, 8);
});

void test("a 403 for a key that may not use the library is thrown as-is and never retried", async () => {
  const mock = scripted([failure(403, { data: { reason: "asset_workspace_forbidden" } })]);

  await assert.rejects(client(mock.fetch, 2).assets.list(), (error: unknown) => {
    assert.ok(error instanceof SpicyApiError);
    assert.equal(error.status, 403);
    assert.equal(error.code, 403);
    assert.equal(error.reason, "asset_workspace_forbidden");
    assert.equal(error.message, "refused by the asset library");
    return true;
  });
  assert.equal(mock.calls.length, 1, "a 403 is a decision, not a transient failure");
});

void test("the daily limit carries both its reason and Retry-After", async () => {
  const mock = scripted([
    failure(429, { data: { reason: "asset_daily_limit" } }, { "Retry-After": "3600" }),
  ]);

  await assert.rejects(
    client(mock.fetch).assets.create({ source: "upload", fileId: "fil_1" }),
    (error: unknown) =>
      error instanceof SpicyApiError &&
      error.reason === "asset_daily_limit" &&
      error.retryAfterSeconds === 3600,
  );
});

void test("uploadFile uploads, commits and saves under the file name", async () => {
  const directory = await mkdtemp(join(tmpdir(), "spicy-assets-"));
  const filePath = join(directory, "hero portrait.png");
  await writeFile(filePath, Uint8Array.from([137, 80, 78, 71]));
  const mock = scripted([
    envelope({
      fileId: "fil_9",
      key: "pending",
      uploadUrl: "https://storage.example/upload/fil_9",
      method: "PUT",
      headers: { "Content-Type": "image/png" },
      expiresAt: "2026-10-12T00:10:00Z",
      maxBytes: 10_485_760,
    }),
    (call) => {
      assert.equal(call.headers.has("authorization"), false);
      return new Response(null, { status: 204 });
    },
    envelope({
      fileId: "fil_9",
      status: "ready",
      bytes: 4,
      contentType: "image/png",
      sha256: "a".repeat(64),
      uri: "spicy://f/fil_9",
      expiresAt: "2026-10-13T00:00:00Z",
    }),
    envelope(asset("ast_up", { source: "upload", name: "hero portrait.png" })),
  ]);
  try {
    const saved = await client(mock.fetch).assets.uploadFile(filePath);

    assert.equal(saved.id, "ast_up");
    const save = mock.calls[3];
    assert.equal(save?.url, `${API}/assets`);
    assert.deepEqual(save?.body, {
      source: "upload",
      fileId: "fil_9",
      name: "hero portrait.png",
    });
    assert.match(save?.headers.get("idempotency-key") ?? "", UUID);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test("uploadFile takes an explicit name and does not save when the upload fails", async () => {
  const directory = await mkdtemp(join(tmpdir(), "spicy-assets-"));
  const filePath = join(directory, "clip.mp4");
  await writeFile(filePath, Uint8Array.from([0, 0, 0, 24]));
  const ticket = envelope({
    fileId: "fil_5",
    key: "pending",
    uploadUrl: "https://storage.example/upload/fil_5",
    method: "PUT",
    headers: {},
    expiresAt: "2026-10-12T00:10:00Z",
    maxBytes: 94_371_840,
  });
  const committed = envelope({
    fileId: "fil_5",
    status: "ready",
    bytes: 4,
    contentType: "video/mp4",
    sha256: "b".repeat(64),
    uri: "spicy://f/fil_5",
    expiresAt: "2026-10-13T00:00:00Z",
  });
  const named = scripted([
    ticket,
    new Response(null, { status: 204 }),
    committed,
    envelope(asset("ast_clip", { kind: "video", source: "upload", name: "Opening shot" })),
  ]);
  const failing = scripted([
    envelope({
      fileId: "fil_6",
      key: "pending",
      uploadUrl: "https://storage.example/upload/fil_6",
      method: "PUT",
      headers: {},
      expiresAt: "2026-10-12T00:10:00Z",
      maxBytes: 94_371_840,
    }),
    new Response("denied", { status: 403 }),
  ]);
  try {
    await client(named.fetch).assets.uploadFile(filePath, { name: "Opening shot" });
    assert.deepEqual(named.calls[3]?.body, {
      source: "upload",
      fileId: "fil_5",
      name: "Opening shot",
    });

    await assert.rejects(client(failing.fetch).assets.uploadFile(filePath), /presigned upload/);
    assert.equal(failing.calls.length, 2, "nothing is saved when the bytes never arrived");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
