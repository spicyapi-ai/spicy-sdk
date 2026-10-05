import assert from "node:assert/strict";
import { test } from "node:test";
import { getEventListeners } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  SpicyApiError,
  SpicyClient,
  SpicyUploadError,
  isTerminal,
  type TaskRecord,
} from "../src/index.js";

interface FetchCall {
  url: string;
  init: RequestInit | undefined;
}

function envelope(data: unknown, overrides: Record<string, unknown> = {}): Response {
  return Response.json(
    { code: 200, msg: "success", data, request_id: "req_test", ...overrides },
    { status: 200 },
  );
}

function scriptedFetch(
  responses: Array<Response | ((call: FetchCall) => Response | Promise<Response>)>,
): { calls: FetchCall[]; fetch: typeof fetch } {
  const calls: FetchCall[] = [];
  const implementation: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const call = { url, init };
    calls.push(call);
    const next = responses.shift();
    assert.ok(next, `unexpected fetch call to ${call.url}`);
    return typeof next === "function" ? await next(call) : next;
  };
  return { calls, fetch: implementation };
}

function clientWith(
  fetchImplementation: typeof fetch,
  extra: ConstructorParameters<typeof SpicyClient>[0] = {},
): SpicyClient {
  return new SpicyClient({
    apiKey: "sk_test_secret",
    apiBaseUrl: "http://127.0.0.1:4010/api/v1",
    serviceBaseUrl: "http://127.0.0.1:4010",
    fetch: fetchImplementation,
    maxRetries: 0,
    ...extra,
  });
}

void test("balance keeps optional funding sources and a negative net, stays compatible with older responses and loses no nanodollars", async () => {
  const legacy = { available: "1", held: "0", total: "1" };
  const current = {
    available: "-10.000000001",
    held: "2",
    total: "-8.000000001",
    funding: {
      balanceUsd: "-10.000000001",
      heldUsd: "2",
      prepaidAvailableUsd: "0",
      grantAvailableUsd: "0.000000001",
      cashShortfallUsd: "0",
      credit: {
        enabled: true,
        limitUsd: "100",
        availableUsd: "87.999999999",
        usedUsd: "10.000000001",
        heldUsd: "2",
        status: "active",
        version: 3,
        expiresAt: "2027-01-01T00:00:00Z",
      },
      grants: [
        {
          id: "fng_fixture",
          name: "Example grant",
          amountUsd: "1",
          availableUsd: "0.000000001",
          heldUsd: "0",
          spentUsd: "0.999999999",
          status: "active",
          startsAt: "2026-01-01T00:00:00Z",
          expiresAt: null,
          modelSlugs: ["example/1/text-to-image"],
          customerMemo: "Example purpose",
          createdAt: "2026-01-01T00:00:00Z",
        },
      ],
      grantsHasMore: false,
    },
  };
  const mock = scriptedFetch([envelope(legacy), envelope(current)]);
  const client = clientWith(mock.fetch);
  assert.deepEqual(await client.getBalance(), legacy);
  const balance = await client.getBalance();
  assert.deepEqual(balance, current);
  assert.equal(balance.funding?.grants[0]?.availableUsd, "0.000000001");
  assert.equal(balance.available, "-10.000000001");
  assert.equal(mock.calls.length, 2);
});

void test("the deadline still applies and cancels the read when the body never ends", async () => {
  let canceled = false;
  const body = new ReadableStream<Uint8Array>({
    cancel: () => {
      canceled = true;
    },
  });
  const client = clientWith(() => Promise.resolve(new Response(body)), { timeoutMs: 25 });
  await assert.rejects(client.getBalance(), { name: "SpicyTimeoutError" });
  assert.equal(canceled, true);
});

void test("the caller can still cancel reading the body after the headers have arrived", async () => {
  const controller = new AbortController();
  const reason = new Error("caller canceled");
  let canceled = false;
  const client = clientWith(() =>
    Promise.resolve(
      new Response(
        new ReadableStream<Uint8Array>({
          cancel: () => {
            canceled = true;
          },
        }),
      ),
    ),
  );
  const request = client.getBalance({ signal: controller.signal });
  setTimeout(() => controller.abort(reason), 10);
  await assert.rejects(request, (error) => error === reason);
  assert.equal(canceled, true);
});

void test("an oversized body of undeclared length is stopped while reading rather than checked after it all arrives", async () => {
  let chunks = 0;
  let canceled = false;
  const client = clientWith(() =>
    Promise.resolve(
      new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            chunks += 1;
            controller.enqueue(new Uint8Array(64 * 1024));
            if (chunks === 1000) controller.close();
          },
          cancel() {
            canceled = true;
          },
        }),
      ),
    ),
  );
  await assert.rejects(client.getBalance(), /exceeded 4194304 bytes/);
  assert.equal(canceled, true);
  assert.ok(chunks <= 66, `only the block that crosses the limit and the stream prefetch are allowed; ${chunks} blocks were read`);
});

void test("health and readiness probes do not require an API key", async () => {
  const mock = scriptedFetch([
    new Response("ok", { status: 200 }),
    new Response("ready", { status: 200 }),
  ]);
  const client = new SpicyClient({
    apiBaseUrl: "http://127.0.0.1:4010/api/v1",
    serviceBaseUrl: "http://127.0.0.1:4010",
    fetch: mock.fetch,
    maxRetries: 0,
    now: () => Date.parse("2026-08-31T00:00:00.000Z"),
  });

  const status = await client.getStatus();

  assert.equal(status.operational, true);
  assert.equal(status.checkedAt, "2026-08-31T00:00:00.000Z");
  assert.deepEqual(
    mock.calls.map((call) => call.url),
    ["http://127.0.0.1:4010/healthz", "http://127.0.0.1:4010/readyz"],
  );
  assert.equal(new Headers(mock.calls[0]?.init?.headers).has("authorization"), false);
});

void test("an absent /readyz (404) means not applicable to this deployment, not unready", async () => {
  const mock = scriptedFetch([
    new Response('{"status":"ok"}', { status: 200 }),
    new Response("404 page not found", { status: 404 }),
  ]);
  const client = new SpicyClient({
    apiBaseUrl: "http://127.0.0.1:4010/api/v1",
    serviceBaseUrl: "http://127.0.0.1:4010",
    fetch: mock.fetch,
    maxRetries: 0,
  });

  const status = await client.getStatus();

  // The public-facing process does not register /readyz by design, so it is always a 404 on the
  // production domain; reading that as "unready" would make operational permanently false.
  assert.equal(status.operational, true);
  assert.equal(status.readiness.ok, false);
  assert.equal(status.readiness.status, 404);
});

void test("genuine unreadiness (503) is still judged unusable", async () => {
  const mock = scriptedFetch([
    new Response('{"status":"ok"}', { status: 200 }),
    new Response("not ready", { status: 503 }),
  ]);
  const client = new SpicyClient({
    apiBaseUrl: "http://127.0.0.1:4010/api/v1",
    serviceBaseUrl: "http://127.0.0.1:4010",
    fetch: mock.fetch,
    maxRetries: 0,
  });

  assert.equal((await client.getStatus()).operational, false);
});

void test("when /healthz itself fails the service is unusable whatever /readyz says", async () => {
  const mock = scriptedFetch([
    new Response("down", { status: 502 }),
    new Response("404 page not found", { status: 404 }),
  ]);
  const client = new SpicyClient({
    apiBaseUrl: "http://127.0.0.1:4010/api/v1",
    serviceBaseUrl: "http://127.0.0.1:4010",
    fetch: mock.fetch,
    maxRetries: 0,
  });

  assert.equal((await client.getStatus()).operational, false);
});

void test("model, balance, task and download calls match the public routes", async () => {
  const mock = scriptedFetch([
    envelope({ total: 0, items: [] }),
    envelope({ model: "provider/family" }),
    envelope({ available: "10.00", held: "1.00", total: "11.00" }),
    envelope({
      taskId: "job_1",
      model: "provider/family",
      state: "running",
      cost: "1.00",
      settled: false,
      createdAt: "2026-08-31T00:00:00Z",
    }),
    envelope({
      key: "out.png",
      url: "https://storage.example/out",
      expiresAt: "2026-08-31T00:10:00Z",
    }),
  ]);
  const client = clientWith(mock.fetch);

  await client.listModels({ modality: "image", search: "a/b", includeSchema: true });
  await client.getModel("provider/family");
  await client.getBalance();
  await client.getTask("job_1");
  await client.createDownloadUrl("job_1", "out.png");

  assert.equal(
    mock.calls[0]?.url,
    "http://127.0.0.1:4010/api/v1/models?modality=image&search=a%2Fb&includeSchema=1",
  );
  assert.equal(mock.calls[1]?.url, "http://127.0.0.1:4010/api/v1/models/provider%2Ffamily");
  assert.equal(mock.calls[2]?.url, "http://127.0.0.1:4010/api/v1/chat/credit");
  assert.equal(mock.calls[3]?.url, "http://127.0.0.1:4010/api/v1/jobs/recordInfo?taskId=job_1");
  assert.equal(mock.calls[4]?.url, "http://127.0.0.1:4010/api/v1/common/download-url");
  for (const call of mock.calls) {
    assert.equal(new Headers(call.init?.headers).get("authorization"), "Bearer sk_test_secret");
  }
});

void test("task creation forwards model input, carries idempotency without a content-mode flag", async () => {
  const mock = scriptedFetch([
    envelope({ taskId: "job_1", state: "queued", estimatedCost: "0.25" }),
  ]);
  const client = clientWith(mock.fetch);

  const result = await client.createTask(
    { model: "provider/model", input: { prompt: "hello", unknownFutureField: true } },
    { idempotencyKey: "idem_1" },
  );

  assert.equal(result.taskId, "job_1");
  assert.equal(new Headers(mock.calls[0]?.init?.headers).get("idempotency-key"), "idem_1");
  const body = mock.calls[0]?.init?.body;
  assert.ok(typeof body === "string");
  assert.deepEqual(JSON.parse(body), {
    model: "provider/model",
    input: { prompt: "hello", unknownFutureField: true },
  });
});

void test("billable POST retries only when an idempotency key is present", async () => {
  const unavailable = (): Response =>
    Response.json({ code: 50301, msg: "unavailable", request_id: "req_503" }, { status: 503 });
  const withoutKey = scriptedFetch([unavailable()]);
  await assert.rejects(
    clientWith(withoutKey.fetch, { maxRetries: 2, sleep: () => Promise.resolve() }).createTask({
      model: "provider/model",
      input: {},
    }),
    SpicyApiError,
  );
  assert.equal(withoutKey.calls.length, 1);

  const withKey = scriptedFetch([
    unavailable(),
    envelope({ taskId: "job_retry", state: "queued", estimatedCost: "0.25" }),
  ]);
  const result = await clientWith(withKey.fetch, {
    maxRetries: 2,
    sleep: () => Promise.resolve(),
    random: () => 0.5,
  }).createTask({ model: "provider/model", input: {} }, { idempotencyKey: "idem_retry" });
  assert.equal(result.taskId, "job_retry");
  assert.equal(withKey.calls.length, 2);
});

void test("structured API errors preserve correlation and rate-limit metadata without the key", async () => {
  const mock = scriptedFetch([
    Response.json(
      { code: 429, msg: "slow down", request_id: "req_rate" },
      {
        status: 429,
        headers: {
          "Retry-After": "2",
          "X-RateLimit-Limit": "60",
          "X-RateLimit-Remaining": "0",
        },
      },
    ),
  ]);

  await assert.rejects(clientWith(mock.fetch).getBalance(), (error: unknown) => {
    assert.ok(error instanceof SpicyApiError);
    assert.equal(error.status, 429);
    assert.equal(error.code, 429);
    assert.equal(error.requestId, "req_rate");
    assert.equal(error.retryAfterSeconds, 2);
    assert.equal(error.rateLimitLimit, 60);
    assert.equal(error.rateLimitRemaining, 0);
    assert.equal(error.message.includes("sk_test_secret"), false);
    return true;
  });
});

void test("waitForTask polls until a terminal state and reports every update", async () => {
  let clock = 0;
  const states: TaskRecord["state"][] = ["queued", "running", "succeeded"];
  const mock = scriptedFetch(
    states.map((state) =>
      envelope({
        taskId: "job_wait",
        model: "provider/model",
        state,
        cost: "0.25",
        settled: state === "succeeded",
        createdAt: "2026-08-31T00:00:00Z",
      }),
    ),
  );
  const observed: TaskRecord["state"][] = [];
  const client = clientWith(mock.fetch, {
    now: () => clock,
    sleep: (milliseconds) => {
      clock += milliseconds;
      return Promise.resolve();
    },
  });

  const task = await client.waitForTask("job_wait", {
    intervalMs: 100,
    timeoutMs: 1_000,
    onUpdate: (update) => {
      observed.push(update.state);
    },
  });

  assert.equal(task.state, "succeeded");
  assert.deepEqual(observed, states);
});

void test("run submits exactly once and waits for the stored output, without pre-flighting or exchanging download tickets", async () => {
  const accepted = { taskId: "job_run", state: "queued", estimatedCost: "0.25" };
  const result = {
    ...accepted,
    state: "succeeded",
    output: { assets: [{ key: "tasks/result.png", url: "https://cdn.example/result.png" }] },
  };
  const mock = scriptedFetch([
    envelope(accepted),
    envelope({ ...result, output: { assets: [{ key: "", pending: true }] } }),
    envelope(result),
  ]);
  let clock = 0;
  let saved = "";
  const client = clientWith(mock.fetch, {
    now: () => clock,
    sleep: (ms) => {
      clock += ms;
      return Promise.resolve();
    },
  });
  const task = await client.run(
    { model: "publisher/model/edit", input: { image_url: "https://cdn.example/input.png" } },
    {
      idempotencyKey: "run-once",
      intervalMs: 100,
      onAccepted: (value) => {
        saved = value.taskId;
        assert.equal(mock.calls.length, 1);
      },
    },
  );
  assert.equal(saved, "job_run");
  assert.equal(task.output?.assets?.[0]?.url, "https://cdn.example/result.png");
  assert.equal(mock.calls.length, 3);
  assert.ok(mock.calls.slice(1).every((call) => call.url.includes("/jobs/recordInfo")));
  assert.equal(new Headers(mock.calls[0]?.init?.headers).get("idempotency-key"), "run-once");
  await assert.rejects(client.run({ model: "model", input: {} }, { timeoutMs: 0 }), TypeError);
  assert.equal(mock.calls.length, 3, "an invalid wait option must not create a billable task first");
});

void test("polling backs off within a ceiling by default, and neither an explicit failure nor an unavailable asset is waited on forever", async () => {
  let clock = 0;
  const delays: number[] = [];
  const mock = scriptedFetch([
    ...Array.from({ length: 5 }, () => envelope({ taskId: "job_backoff", state: "running" })),
    envelope({
      taskId: "job_backoff",
      state: "succeeded",
      output: { assets: [{ pending: true, unavailable: true }] },
    }),
  ]);
  const client = clientWith(mock.fetch, {
    now: () => clock,
    random: () => 0,
    sleep: (ms) => {
      delays.push(ms);
      clock += ms;
      return Promise.resolve();
    },
  });
  const task = await client.waitForTask("job_backoff", { timeoutMs: 60_000 });
  assert.equal(task.state, "succeeded");
  assert.deepEqual(delays, [2000, 3000, 4500, 6750, 10000]);
});

void test("the overall wait deadline interrupts a stalled HTTP body while preserving the task identity", async () => {
  let canceled = false;
  const controller = new AbortController();
  const client = clientWith(
    () =>
      Promise.resolve(
        new Response(
          new ReadableStream({
            cancel() {
              canceled = true;
            },
          }),
        ),
      ),
    { timeoutMs: 30_000 },
  );
  await assert.rejects(
    client.waitForTask("job_stalled", { timeoutMs: 25, signal: controller.signal }),
    { name: "SpicyWaitTimeoutError", taskId: "job_stalled", timeoutMs: 25 },
  );
  assert.equal(canceled, true);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});

void test("a stalled acceptance or status callback still times out, preserving the task identity and never resubmitting", { timeout: 1000 }, async () => {
  for (const stage of ["accepted", "update"] as const) {
    const mock = scriptedFetch([
      envelope({ taskId: "job_callback", state: "queued" }),
      envelope({ taskId: "job_callback", state: "running" }),
    ]);
    const controller = new AbortController();
    let rejectCallback!: (error: Error) => void;
    const blocked = new Promise<void>((_resolve, reject) => {
      rejectCallback = reject;
    });
    await assert.rejects(
      clientWith(mock.fetch).run(
        { model: "model", input: {} },
        {
          timeoutMs: 25,
          signal: controller.signal,
          ...(stage === "accepted" ? { onAccepted: () => blocked } : { onUpdate: () => blocked }),
        },
      ),
      { name: "SpicyWaitTimeoutError", taskId: "job_callback" },
    );
    assert.equal(mock.calls.filter((call) => call.url.endsWith("/jobs/createTask")).length, 1);
    assert.equal(mock.calls.length, stage === "accepted" ? 1 : 2);
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
    rejectCallback(new Error("the callback failed after the deadline"));
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
});

void test("waiting on a status callback can be cancelled, stopping only the local wait", { timeout: 1000 }, async () => {
  const mock = scriptedFetch([envelope({ taskId: "job_callback_abort", state: "running" })]);
  const controller = new AbortController();
  const reason = new Error("caller canceled");
  await assert.rejects(
    clientWith(mock.fetch).waitForTask("job_callback_abort", {
      signal: controller.signal,
      onUpdate: () => {
        controller.abort(reason);
        return new Promise<void>(() => {});
      },
    }),
    (error) => error === reason,
  );
  assert.equal(mock.calls.length, 1);
  assert.ok(mock.calls[0]?.url.includes("/jobs/recordInfo"));
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});

void test("an asynchronous observability failure raises no unhandled rejection and never retries an accepted task", async () => {
  const mock = scriptedFetch([envelope({ taskId: "job_observer", state: "queued" })]);
  const result = await clientWith(mock.fetch, {
    onResponse: () => Promise.reject(new Error("async logger unavailable")),
  }).createTask({ model: "model", input: {} }, { idempotencyKey: "observer-once" });
  assert.equal(result.taskId, "job_observer");
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(mock.calls.length, 1);
});

void test("an ordinary sleep between network retries cleans up its cancellation listener", async () => {
  const controller = new AbortController();
  const mock = scriptedFetch([
    new Response("busy", { status: 503 }),
    new Response("busy", { status: 503 }),
    envelope({ available: "1.00" }),
  ]);
  const client = clientWith(mock.fetch, { maxRetries: 2, retryBaseDelayMs: 1, random: () => 0 });
  await client.getBalance({ signal: controller.signal });
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});

void test("a server Retry-After beyond the automatic waiting budget returns the error instead of retrying early", async () => {
  const mock = scriptedFetch([
    Response.json(
      { code: 42901, msg: "Rate limit exceeded", request_id: "req_rate" },
      { status: 429, headers: { "Retry-After": "60" } },
    ),
  ]);
  const client = clientWith(mock.fetch, {
    maxRetries: 2,
    maxRetryDelayMs: 30_000,
    sleep: () => {
      assert.fail("it must not be truncated to 30 seconds and retried");
    },
  });
  await assert.rejects(client.getBalance(), {
    name: "SpicyApiError",
    status: 429,
    retryAfterSeconds: 60,
  });
  assert.equal(mock.calls.length, 1);
});

void test("usage queries keep USD as strings, and response observability neither exposes the body nor can break a successful result", async () => {
  const usage = {
    from: "2026-09-01",
    to: "2026-09-02",
    currency: "USD",
    totalCalls: 1,
    totalSpend: "0.000000001",
    days: [],
    models: [],
  };
  const mock = scriptedFetch([envelope(usage)]);
  let metadata: unknown;
  const client = clientWith(mock.fetch, {
    onResponse: (value) => {
      metadata = value;
      throw new Error("logger unavailable");
    },
  });
  const result = await client.getUsage({ from: usage.from, to: usage.to });
  assert.equal(result.totalSpend, "0.000000001");
  assert.equal(mock.calls.length, 1);
  assert.ok(mock.calls[0]?.url.endsWith("/usage?from=2026-09-01&to=2026-09-02"));
  assert.deepEqual(metadata, {
    method: "GET",
    path: "/usage?from=2026-09-01&to=2026-09-02",
    status: 200,
    requestId: "req_test",
  });
});

void test("direct upload never forwards the Spicy API key to presigned storage", async () => {
  const mock = scriptedFetch([
    envelope({
      fileId: "file_1",
      key: "spicy://pending/file_1",
      uploadUrl: "https://storage.example/upload/file_1",
      method: "PUT",
      headers: { "Content-Type": "image/png", "X-Upload-Token": "upload_only" },
      expiresAt: "2026-08-31T00:10:00Z",
      maxBytes: 10_485_760,
    }),
    (call) => {
      const headers = new Headers(call.init?.headers);
      assert.equal(call.url, "https://storage.example/upload/file_1");
      assert.equal(headers.has("authorization"), false);
      assert.equal(headers.get("x-upload-token"), "upload_only");
      return new Response(null, { status: 204 });
    },
    envelope({
      fileId: "file_1",
      status: "ready",
      bytes: 4,
      contentType: "image/png",
      sha256: "abcd",
      uri: "spicy://files/file_1",
      expiresAt: "2026-09-01T00:00:00Z",
    }),
  ]);
  const client = clientWith(mock.fetch);

  const uploaded = await client.uploadBytes(Uint8Array.from([1, 2, 3, 4]), {
    contentType: "image/png",
  });

  assert.equal(uploaded.uri, "spicy://files/file_1");
  assert.equal(mock.calls[0]?.url, "http://127.0.0.1:4010/api/v1/common/upload-url");
  assert.equal(mock.calls[2]?.url, "http://127.0.0.1:4010/api/v1/files/file_1/commit");
});

void test("presigned upload HTTP failures are distinct from API-envelope failures", async () => {
  const mock = scriptedFetch([
    envelope({
      fileId: "file_1",
      key: "spicy://pending/file_1",
      uploadUrl: "https://storage.example/upload/file_1",
      method: "PUT",
      headers: {},
      expiresAt: "2026-08-31T00:10:00Z",
      maxBytes: 10,
    }),
    new Response("forbidden", { status: 403 }),
  ]);

  await assert.rejects(
    clientWith(mock.fetch).uploadBytes(Uint8Array.from([1]), { contentType: "image/png" }),
    (error: unknown) => error instanceof SpicyUploadError && error.status === 403,
  );
});

void test("when the type cannot be inferred, the error lists every extension in the mapping and no request goes out", async () => {
  const directory = await mkdtemp(join(tmpdir(), "spicy-sdk-infer-"));
  try {
    const filePath = join(directory, "clip.mov");
    await writeFile(filePath, "not really a movie");
    const mock = scriptedFetch([]);
    await assert.rejects(clientWith(mock.fetch).uploadFile(filePath), (error: unknown) => {
      assert.ok(error instanceof TypeError);
      // The audio and video extensions have to appear: the message used to list images only, and
      // readers concluded the platform takes no video.
      const expected = ["jpg", "png", "gif", "mp4", "webm", "mp3", "wav", "pdf", "docx", "md"];
      for (const extension of expected) {
        assert.match(error.message, new RegExp(`\\b${extension}\\b`), extension);
      }
      return true;
    });
    assert.equal(mock.calls.length, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test("a reference document uploads with its type inferred from the extension", async () => {
  const directory = await mkdtemp(join(tmpdir(), "spicy-sdk-document-"));
  try {
    const cases = [
      ["brief.pdf", "application/pdf"],
      ["Deck.PPTX", "application/vnd.openxmlformats-officedocument.presentationml.presentation"],
      ["notes.md", "text/markdown"],
    ] as const;
    for (const [name, contentType] of cases) {
      const filePath = join(directory, name);
      await writeFile(filePath, "%PDF-1.7");
      const mock = scriptedFetch([
        (call) => {
          assert.deepEqual(JSON.parse(call.init?.body as string), { contentType, bytes: 8 });
          return envelope({
            fileId: "fil_doc",
            key: "spicy://f/fil_doc",
            uploadUrl: "https://storage.example/upload/fil_doc",
            method: "PUT",
            headers: { "Content-Type": contentType },
            expiresAt: "2026-10-05T00:10:00Z",
            maxBytes: 94_371_840,
          });
        },
        new Response(null, { status: 204 }),
        envelope({
          fileId: "fil_doc",
          status: "ready",
          bytes: 8,
          contentType,
          sha256: "a".repeat(64),
          uri: "spicy://f/fil_doc",
          expiresAt: "2026-10-06T00:00:00Z",
        }),
      ]);
      const uploaded = await clientWith(mock.fetch).uploadFile(filePath);
      assert.equal(uploaded.contentType, contentType, name);
      assert.equal(uploaded.uri, "spicy://f/fil_doc");
      assert.equal(mock.calls.length, 3);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test("non-loopback HTTP base URLs are rejected", () => {
  assert.throws(
    () => new SpicyClient({ apiBaseUrl: "http://api.example.test/api/v1" }),
    /must use HTTPS/,
  );
});

void test("quote and confirmed create preserve exact request and decimal prices", async () => {
  const quote = {
    quoteId: "quote_exact",
    model: "family/version/task",
    estimatedCost: "0.000000123",
    maxCharge: "0.000000123",
    currency: "USD",
    quantity: "1.5",
    unit: "per_second",
    expiresAt: "2026-09-05T12:05:00Z",
  };
  const mock = scriptedFetch([
    envelope(quote),
    envelope({ taskId: "job_quote", state: "queued", estimatedCost: quote.estimatedCost }),
  ]);
  const client = clientWith(mock.fetch);
  const payload = {
    model: "family/version/task",
    input: { prompt: "offline", duration_seconds: 1.5 },
    callBackUrl: "https://app.example/hook",
  };
  const received = await client.quoteTask(payload);
  assert.deepEqual(received, quote);
  assert.ok(mock.calls[0]?.url.endsWith("/jobs/quote"));
  assert.deepEqual(JSON.parse(mock.calls[0]?.init?.body as string), payload);
  await client.createTask(
    { ...payload, quoteId: received.quoteId, expectedCost: received.estimatedCost },
    { idempotencyKey: "idem_quote" },
  );
  assert.deepEqual(JSON.parse(mock.calls[1]?.init?.body as string), {
    ...payload,
    quoteId: quote.quoteId,
    expectedCost: quote.estimatedCost,
  });
  assert.equal(new Headers(mock.calls[1]?.init?.headers).get("Idempotency-Key"), "idem_quote");
});

void test("upload enforces the ticket maximum before sending storage bytes", async () => {
  const mock = scriptedFetch([
    envelope({
      fileId: "file_small",
      uploadUrl: "https://storage.example/upload",
      method: "PUT",
      headers: {},
      maxBytes: 2,
    }),
  ]);
  await assert.rejects(
    clientWith(mock.fetch).uploadBytes(new Uint8Array(3), { contentType: "video/mp4" }),
    SpicyUploadError,
  );
  assert.equal(mock.calls.length, 1);
});

void test("price drift requires a new confirmation and never silently accepts a new price", async () => {
  const mock = scriptedFetch([
    Response.json(
      { code: 40901, msg: "quote expired or price changed", request_id: "req_drift" },
      { status: 409 },
    ),
  ]);
  const payload = {
    model: "family/version/task",
    input: { prompt: "offline" },
    quoteId: "quote_original",
    expectedCost: "0.10",
  };
  await assert.rejects(
    clientWith(mock.fetch, { maxRetries: 2 }).createTask(payload, {
      idempotencyKey: "idem_original",
    }),
    (error) =>
      error instanceof SpicyApiError && error.code === 40901 && error.requestId === "req_drift",
  );
  assert.equal(mock.calls.length, 1);
});

void test("recovering an accepted request preserves the old quote and idempotency key", async () => {
  const mock = scriptedFetch([
    Response.json({ code: 50301, msg: "unavailable", request_id: "req_lost" }, { status: 503 }),
    envelope({ taskId: "job_accepted", state: "queued", estimatedCost: "0.10" }),
  ]);
  const payload = {
    model: "family/version/task",
    input: { prompt: "offline" },
    quoteId: "expired_but_already_accepted",
    expectedCost: "0.10",
  };
  const task = await clientWith(mock.fetch, {
    maxRetries: 1,
    sleep: () => Promise.resolve(),
  }).createTask(payload, { idempotencyKey: "idem_recover" });
  assert.equal(task.taskId, "job_accepted");
  assert.equal(mock.calls.length, 2);
  for (const call of mock.calls) {
    assert.deepEqual(JSON.parse(call.init?.body as string), payload);
    assert.equal(new Headers(call.init?.headers).get("Idempotency-Key"), "idem_recover");
  }
});

void test("task results carry directly usable media URLs without a download-ticket call", async () => {
  const asset = {
    key: "tasks/fixture/result.png",
    url: "https://media.example.com/result.png?signature=fixture",
    expiresAt: "2026-09-06T00:20:00Z",
    mime: "image/png",
    width: 1024,
    height: 1024,
  };
  const mock = scriptedFetch([
    envelope({
      taskId: "job_media",
      model: "fixture/image",
      state: "succeeded",
      cost: "0.01",
      settled: true,
      createdAt: "2026-09-06T00:00:00Z",
      output: { assets: [asset] },
    }),
  ]);
  const record = await clientWith(mock.fetch).getTask("job_media");
  assert.deepEqual(record.output?.assets?.[0], asset);
  assert.equal(mock.calls.length, 1);
  assert.ok(mock.calls[0]?.url.includes("/jobs/recordInfo?taskId=job_media"));
});

void test("listing tasks reads one page, keeps the date cursor and amount precision, and does not expand per-row detail", async () => {
  const page = {
    items: [
      {
        taskId: "task_1",
        model: "example/model/edit",
        state: "succeeded",
        cost: "0.000000001",
        settled: true,
        createdAt: "2026-09-01T00:00:00Z",
        deadlineAt: "2026-09-01T00:10:00Z",
        completedAt: "2026-09-01T00:01:00Z",
      },
    ],
    hasMore: true,
    nextCursor: "opaque+/= cursor",
  };
  const mock = scriptedFetch([envelope(page), envelope({ items: [], hasMore: false })]);
  const client = clientWith(mock.fetch);
  assert.deepEqual(await client.listTasks(), page);
  assert.equal(mock.calls[0]?.url, "http://127.0.0.1:4010/api/v1/jobs");
  assert.deepEqual(
    await client.listTasks({
      from: "2026-09-01",
      to: "2026-09-07",
      state: "succeeded",
      model: "example/model/edit",
      limit: 100,
      cursor: page.nextCursor,
    }),
    { items: [], hasMore: false },
  );
  assert.equal(mock.calls.length, 2);
  const call = mock.calls[1];
  assert.ok(call);
  assert.equal(call.init?.method, "GET");
  assert.equal(call.init?.body, undefined);
  assert.equal(new Headers(call.init?.headers).get("authorization"), "Bearer sk_test_secret");
  assert.deepEqual(Object.fromEntries(new URL(call.url).searchParams), {
    from: "2026-09-01",
    to: "2026-09-07",
    state: "succeeded",
    model: "example/model/edit",
    limit: "100",
    cursor: page.nextCursor,
  });
});

void test("purgeTask is idempotent: purging the same task again still answers 200, with the request shape unchanged", async () => {
  const purged = {
    taskId: "job_purge",
    contentState: "purged",
    purgedAt: "2026-09-13T10:00:00Z",
    contentRemovedBy: "user",
    billingRetained: true,
  };
  const mock = scriptedFetch([envelope(purged), envelope(purged)]);
  const client = clientWith(mock.fetch);

  const first = await client.purgeTask("job_purge");
  const second = await client.purgeTask("job_purge");

  assert.deepEqual(first, purged);
  // Idempotency does not mean "the second call sends nothing"; it means "the second call sends the
  // same request, gets the same answer and does not error". The client caches no purge result,
  // because only the server knows how far the sweeper has got.
  assert.deepEqual(second, first);
  assert.equal(mock.calls.length, 2);
  for (const call of mock.calls) {
    assert.equal(call.url, "http://127.0.0.1:4010/api/v1/jobs/purge");
    assert.equal(call.init?.method, "POST");
    assert.equal(call.init?.body, JSON.stringify({ taskId: "job_purge" }));
  }
});

void test("purgeTask is safe to retry at the transport layer and carries no idempotency key", async () => {
  const mock = scriptedFetch([
    Response.json({ code: 50301, msg: "unavailable", request_id: "req_503" }, { status: 503 }),
    envelope({ taskId: "job_purge", contentState: "purged", billingRetained: true }),
  ]);
  const client = clientWith(mock.fetch, { maxRetries: 2, sleep: () => Promise.resolve() });

  const result = await client.purgeTask("job_purge");

  assert.equal(result.contentState, "purged");
  assert.equal(mock.calls.length, 2);
  // Purging costs nothing and creates no resource, and the server guarantees idempotency, so this
  // call needs no Idempotency-Key to earn the right to be retried.
  assert.equal(new Headers(mock.calls[0]?.init?.headers).get("idempotency-key"), null);
});

void test("waitSeconds becomes ?wait=N, is sent verbatim, lifts the local timeout, and is absent when unset", async () => {
  // Three separate things can make this parameter fail silently:
  // 1. clamping again locally - the server clamps anything over 60 and ignores, rather than
  //    rejects, non-positive integers, so clamping in the client revokes that leniency and would
  //    reject a working value once the platform relaxes;
  // 2. not lifting the local timeout - the default 30-second request timeout cuts the call off
  //    while the server still holds the connection, which looks like "the parameter does nothing"
  //    when the real cause is two timeouts colliding;
  // 3. still emitting `?wait=` when unset - the contract states plainly that empty parameters are
  //    rejected.
  const mock = scriptedFetch([
    envelope({ taskId: "job_w", state: "queued", estimatedCost: "0.25" }),
    envelope({ taskId: "job_w2", state: "queued", estimatedCost: "0.25" }),
    envelope({ taskId: "job_none", state: "queued", estimatedCost: "0.25" }),
  ]);
  const client = clientWith(mock.fetch);

  await client.createTask({ model: "m", input: {} }, { waitSeconds: 45 });
  assert.ok(mock.calls[0]?.url.endsWith("/jobs/createTask?wait=45"), String(mock.calls[0]?.url));

  // Values over 60 go out verbatim too - clamping is the server's job.
  await client.createTask({ model: "m", input: {} }, { waitSeconds: 600 });
  assert.ok(mock.calls[1]?.url.endsWith("/jobs/createTask?wait=600"), String(mock.calls[1]?.url));

  // Unset means it must not appear at all, not even the question mark.
  await client.createTask({ model: "m", input: {} });
  assert.ok(mock.calls[2]?.url.endsWith("/jobs/createTask"), String(mock.calls[2]?.url));
  assert.ok(!mock.calls[2]?.url.includes("?"), String(mock.calls[2]?.url));

  // Thrown synchronously rather than as a rejected promise, the same stance as retentionSeconds:
  // this class of thing is a programming error that never reaches the wire, and should not
  // masquerade as a failed request.
  assert.throws(() => client.createTask({ model: "m", input: {} }, { waitSeconds: -1 }), TypeError);
  assert.equal(mock.calls.length, 3, "the rejected call must not actually go out");
});

void test("passing waitSeconds does not guarantee a terminal record; isTerminal is the test", async () => {
  // Once the wait budget runs out what comes back is an acceptance response, identical in shape to
  // a terminal record and differing only in state. The assumption "I passed wait, so it must be
  // finished" carries a still-running task forward, and nothing raises.
  const mock = scriptedFetch([
    envelope({ taskId: "job_w", state: "running", estimatedCost: "0.25" }),
  ]);
  const accepted = await clientWith(mock.fetch).createTask(
    { model: "m", input: {} },
    { waitSeconds: 30 },
  );
  assert.equal(isTerminal(accepted as { state?: string }), false);
  assert.equal(isTerminal({ state: "succeeded" }), true);
  assert.equal(isTerminal({ state: "failed" }), true);
  assert.equal(isTerminal({}), false);
});

void test("retentionSeconds becomes X-Spicy-Retention, 0 is valid, and negatives and fractions are rejected locally", async () => {
  const mock = scriptedFetch([
    envelope({ taskId: "job_r", state: "queued", estimatedCost: "0.25" }),
    envelope({ taskId: "job_r0", state: "queued", estimatedCost: "0.25" }),
    envelope({ taskId: "job_none", state: "queued", estimatedCost: "0.25" }),
  ]);
  const client = clientWith(mock.fetch);

  await client.createTask({ model: "m", input: {} }, { retentionSeconds: 3_600 });
  assert.equal(new Headers(mock.calls[0]?.init?.headers).get("x-spicy-retention"), "3600");
  // A retention header without an idempotency key must not make this request retryable; it is
  // still a task creation.
  assert.equal(new Headers(mock.calls[0]?.init?.headers).get("idempotency-key"), null);

  await client.createTask({ model: "m", input: {} }, { retentionSeconds: 0 });
  assert.equal(new Headers(mock.calls[1]?.init?.headers).get("x-spicy-retention"), "0");

  await client.createTask({ model: "m", input: {} });
  assert.equal(new Headers(mock.calls[2]?.init?.headers).get("x-spicy-retention"), null);

  // Anything over the limit is clamped server-side; locally the only thing caught is "this cannot
  // become a number of seconds at all". Consistent with the rest of this client's argument
  // validation, that class is a programming error thrown synchronously rather than a request that
  // goes out.
  for (const invalid of [-1, 1.5, Number.NaN]) {
    assert.throws(
      () => client.createTask({ model: "m", input: {} }, { retentionSeconds: invalid }),
      TypeError,
    );
  }
  assert.equal(mock.calls.length, 3);
});

void test("a task record carries contentState and the effective retention, telling expiry from a deliberate purge", async () => {
  const record: TaskRecord = {
    taskId: "job_state",
    model: "example/model/edit",
    state: "succeeded",
    cost: "0.25",
    settled: true,
    createdAt: "2026-09-13T00:00:00Z",
    /* `purgedAt` and `contentRemovedBy` are top-level fields on TaskRecord rather than members of
       `retention`. `retention` describes the policy for keeping content; these two describe what
       has already happened to it, which puts them alongside `contentState`. Besides, a historical
       task with no per-task retention decision omits `retention` entirely, and burying them there
       would make the purge time unreportable. */
    contentState: "purged",
    purgedAt: "2026-09-13T10:00:00Z",
    contentRemovedBy: "user",
    retention: {
      // `retention` may be omitted entirely (historical tasks carry no per-task retention
      // decision), but once present both expiry instants are required - they are not optional in
      // the contract.
      outputsExpireAt: "2026-09-13T01:00:00Z",
      promptsExpireAt: "2026-09-13T01:00:00Z",
      source: "header",
    },
  };
  const mock = scriptedFetch([envelope(record)]);
  const task = await clientWith(mock.fetch).getTask("job_state");

  assert.equal(task.contentState, "purged");
  assert.equal(task.contentRemovedBy, "user");
  assert.equal(task.purgedAt, "2026-09-13T10:00:00Z");
  assert.equal(task.retention?.source, "header");
});const CLOUDFLARE_BLOCK_PAGE =
  '<!DOCTYPE html><html lang="en-US"><head><title>Attention Required! | Cloudflare</title>' +
  "</head><body><h1>Sorry, you have been blocked</h1></body></html>";

void test("a 403 carrying an edge block page says the request never reached the API", async () => {
  const mock = scriptedFetch([
    new Response(CLOUDFLARE_BLOCK_PAGE, {
      status: 403,
      headers: { "content-type": "text/html" },
    }),
  ]);

  await assert.rejects(clientWith(mock.fetch).getBalance(), (error: unknown) => {
    assert.ok(error instanceof SpicyApiError);
    assert.equal(error.status, 403);
    // What answered has to survive into the error: the page's own title is the identifying line.
    // The regions sentence leads: it is the only part the reader can act on.
    assert.match(error.message, /^Refused before reaching SpicyAPI \(HTTP 403\)\. The service is not offered in every region: https:\/\/spicyapi\.ai\/legal\/terms\./);
    assert.match(error.message, /proxy, gateway or CDN edge answered instead/);
    // What answered still has to survive into the error, after the part that matters.
    assert.match(error.message, /Attention Required! \| Cloudflare"\.$/);
    assert.ok(error.responseBody?.includes("you have been blocked"));
    return true;
  });
});

void test("a short non-JSON body is quoted verbatim rather than described", async () => {
  const mock = scriptedFetch([new Response("error code: 1010", { status: 403 })]);

  await assert.rejects(clientWith(mock.fetch).getBalance(), (error: unknown) => {
    assert.ok(error instanceof SpicyApiError);
    assert.match(error.message, /answered instead - the body was "error code: 1010"\.$/);
    return true;
  });
});

void test("an empty body is reported as empty and retains nothing", async () => {
  const mock = scriptedFetch([new Response("", { status: 502 })]);

  await assert.rejects(clientWith(mock.fetch).getBalance(), (error: unknown) => {
    assert.ok(error instanceof SpicyApiError);
    assert.match(error.message, /the body was empty\./);
    assert.equal(error.responseBody, undefined);
    // Only 403 is an edge refusal; a 502 must not send the reader to the regions page.
    assert.doesNotMatch(error.message, /legal\/terms/);
    return true;
  });
});

/* The counter-example. Without it the assertions above would still pass if the new wording were
   glued onto every failure, and the platform's own errors - which do reach the origin and do
   carry a request id - would start blaming a proxy that was never involved. */
void test("a genuine API error envelope keeps its own message and blames no intermediary", async () => {
  const mock = scriptedFetch([
    Response.json(
      { code: 401, msg: "Credentials are invalid or expired", request_id: "req_real" },
      { status: 401 },
    ),
  ]);

  await assert.rejects(clientWith(mock.fetch).getBalance(), (error: unknown) => {
    assert.ok(error instanceof SpicyApiError);
    assert.equal(error.message, "Credentials are invalid or expired");
    assert.equal(error.requestId, "req_real");
    assert.equal(error.responseBody, undefined);
    assert.doesNotMatch(error.message, /proxy, gateway or CDN edge/);
    return true;
  });
});

/* Captured verbatim from cdn.spicyapi.ai on 2026-09-21 by sending the Accept header this client
   always sends. Cloudflare answers its own block pages in JSON when asked to, which is why a
   check for "does it parse" is not a check for "did the API write it". */
const CLOUDFLARE_JSON_BLOCK = JSON.stringify({
  type: "https://developers.cloudflare.com/support/troubleshooting/http-status-codes/cloudflare-1xxx-errors/error-1010/",
  title: "Error 1010: Access denied",
  status: 403,
  detail: "The site owner has blocked access based on your browser's signature.",
  error_code: 1010,
  ray_id: "a3e29537e88ef51a",
  zone: "cdn.spicyapi.ai",
  cloudflare_error: true,
});

void test("an edge block that parses as JSON is still reported as not ours", async () => {
  const mock = scriptedFetch([
    new Response(CLOUDFLARE_JSON_BLOCK, {
      status: 403,
      headers: { "content-type": "application/json" },
    }),
  ]);

  await assert.rejects(clientWith(mock.fetch).getBalance(), (error: unknown) => {
    assert.ok(error instanceof SpicyApiError);
    assert.equal(error.status, 403);
    // The generic fallback is exactly the dead end this exists to prevent.
    // The generic fallback is exactly the dead end this exists to prevent.
    assert.doesNotMatch(error.message, /request failed with HTTP/);
    assert.match(error.message, /^Refused before reaching SpicyAPI \(HTTP 403\)\./);
    // The intermediary's own words, not a dump of its JSON, and no doubled full stop.
    assert.match(error.message, /instead - the body said "Error 1010: Access denied - The site owner has blocked access based on your browser's signature\."$/);
    return true;
  });
});

void test("a platform envelope missing only its code is still read as the platform's own words", async () => {
  const mock = scriptedFetch([
    Response.json(
      { msg: "Credentials are invalid or expired", request_id: "req_x" },
      { status: 401 },
    ),
  ]);

  await assert.rejects(clientWith(mock.fetch).getBalance(), (error: unknown) => {
    assert.ok(error instanceof SpicyApiError);
    assert.equal(error.message, "Credentials are invalid or expired");
    assert.doesNotMatch(error.message, /proxy, gateway or CDN edge/);
    return true;
  });
});

/* Node.js fetch ignores HTTPS_PROXY unless NODE_USE_ENV_PROXY=1, while curl in the same shell
   honors it. These pin the diagnosis the SDK adds when that mismatch is the likely story. */

const PROXY_ENV_NAMES = [
  "https_proxy",
  "HTTPS_PROXY",
  "http_proxy",
  "HTTP_PROXY",
  "NODE_USE_ENV_PROXY",
  "NODE_OPTIONS",
] as const;

/* Runs `body` with exactly the given proxy variables, whatever the shell running the tests has. */
async function withProxyEnv(
  values: Partial<Record<(typeof PROXY_ENV_NAMES)[number], string>>,
  body: () => Promise<void>,
): Promise<void> {
  const saved = new Map(PROXY_ENV_NAMES.map((name) => [name, process.env[name]]));
  for (const name of PROXY_ENV_NAMES) delete process.env[name];
  Object.assign(process.env, values);
  try {
    await body();
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

/* The hint only applies to the runtime's own fetch, so these swap it rather than inject one. */
async function withPlatformFetch(
  implementation: typeof fetch,
  body: (client: SpicyClient) => Promise<void>,
): Promise<void> {
  const original = globalThis.fetch;
  globalThis.fetch = implementation;
  try {
    await body(
      new SpicyClient({
        apiKey: "sk_test_secret",
        apiBaseUrl: "http://127.0.0.1:4010/api/v1",
        serviceBaseUrl: "http://127.0.0.1:4010",
        maxRetries: 0,
      }),
    );
  } finally {
    globalThis.fetch = original;
  }
}

function edgeBlock(): Response {
  return new Response(CLOUDFLARE_BLOCK_PAGE, {
    status: 403,
    headers: { "content-type": "text/html" },
  });
}

void test("an edge 403 names a proxy variable that Node.js fetch ignored", async () => {
  await withProxyEnv({ HTTPS_PROXY: "http://127.0.0.1:7890" }, async () => {
    await withPlatformFetch(scriptedFetch([edgeBlock()]).fetch, async (client) => {
      await assert.rejects(client.getBalance(), (error: unknown) => {
        assert.ok(error instanceof SpicyApiError);
        // The refusal still leads; the proxy explains the route, it is not the headline.
        assert.match(error.message, /^Refused before reaching SpicyAPI \(HTTP 403\)\./);
        assert.match(
          error.message,
          /HTTPS_PROXY is set, but this request did not use it: Node\.js fetch ignores proxy variables unless NODE_USE_ENV_PROXY=1 is also set \(Node\.js 22\.21\+ or 24\+\)\.$/,
        );
        return true;
      });
    });
  });
});

void test("the lowercase proxy variable is the one named, as Node.js reads it first", async () => {
  await withProxyEnv(
    { https_proxy: "http://127.0.0.1:7890", HTTPS_PROXY: "http://127.0.0.1:7891" },
    async () => {
      await withPlatformFetch(scriptedFetch([edgeBlock()]).fetch, async (client) => {
        await assert.rejects(client.getBalance(), /https_proxy is set, but this request/);
      });
    },
  );
});

void test("a network failure through an ignored proxy says so", async () => {
  const refused: typeof fetch = () => Promise.reject(new TypeError("fetch failed"));
  await withProxyEnv({ HTTP_PROXY: "http://proxy.internal:3128" }, async () => {
    await withPlatformFetch(refused, async (client) => {
      await assert.rejects(client.getBalance(), (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(error.name, "SpicyTransportError");
        assert.match(error.message, /^network request failed\. HTTP_PROXY is set, but/);
        return true;
      });
    });
  });
});

/* Counter-examples: each is a situation where the sentence above would send the reader to fix
   something that is not broken. */

void test("no proxy hint once Node.js is told to use the proxy", async () => {
  for (const enabled of [
    { NODE_USE_ENV_PROXY: "1" },
    { NODE_OPTIONS: "--max-old-space-size=512 --use-env-proxy" },
  ]) {
    await withProxyEnv({ HTTPS_PROXY: "http://127.0.0.1:7890", ...enabled }, async () => {
      await withPlatformFetch(scriptedFetch([edgeBlock()]).fetch, async (client) => {
        await assert.rejects(client.getBalance(), (error: unknown) => {
          assert.ok(error instanceof SpicyApiError);
          assert.doesNotMatch(error.message, /NODE_USE_ENV_PROXY/);
          assert.match(error.message, /Attention Required! \| Cloudflare"\.$/);
          return true;
        });
      });
    });
  }
});

void test("no proxy hint for a caller-supplied fetch, which may route through a proxy itself", async () => {
  await withProxyEnv({ HTTPS_PROXY: "http://127.0.0.1:7890" }, async () => {
    await assert.rejects(clientWith(scriptedFetch([edgeBlock()]).fetch).getBalance(), (error: unknown) => {
      assert.ok(error instanceof SpicyApiError);
      assert.doesNotMatch(error.message, /NODE_USE_ENV_PROXY/);
      return true;
    });
  });
});

void test("no proxy hint for a proxy Node.js could not use, because the switch would stop it starting", async () => {
  for (const value of ["socks5://127.0.0.1:7890", "127.0.0.1:7890"]) {
    await withProxyEnv({ HTTPS_PROXY: value }, async () => {
      await withPlatformFetch(scriptedFetch([edgeBlock()]).fetch, async (client) => {
        await assert.rejects(client.getBalance(), (error: unknown) => {
          assert.ok(error instanceof SpicyApiError);
          assert.doesNotMatch(error.message, /NODE_USE_ENV_PROXY/);
          return true;
        });
      });
    });
  }
});

void test("no proxy hint when no proxy is configured, or only as an empty string", async () => {
  for (const values of [{}, { HTTPS_PROXY: "", http_proxy: "" }]) {
    await withProxyEnv(values, async () => {
      await withPlatformFetch(scriptedFetch([edgeBlock()]).fetch, async (client) => {
        await assert.rejects(client.getBalance(), (error: unknown) => {
          assert.ok(error instanceof SpicyApiError);
          assert.match(error.message, /Attention Required! \| Cloudflare"\.$/);
          return true;
        });
      });
    });
  }
});
