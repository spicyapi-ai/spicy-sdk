# @spicyapi/sdk

The official TypeScript and JavaScript SDK for [SpicyAPI](https://spicyapi.ai) — one API for video,
image, audio and chat models. It contains the typed client, webhook verification helpers, a
documentation index and generated OpenAPI types.

An SDK is a ready-made code library for **your own Node.js program**. Instead of writing HTTP
requests by hand, you call functions such as `client.run(...)`, and the SDK attaches your key,
retries safely when the network drops, waits for tasks to finish, uploads local files and checks
webhook signatures for you.

**New to this?** The [complete step-by-step guide](https://docs.spicyapi.ai/docs/sdk) explains every
method in plain language, with runnable recipes.

It does **not** install the CLI, MCP server or Agent Skill, and it is not the right tool for
everything:

| You want to…                                           | Use                                                                                                                                   |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| Call SpicyAPI from your own Node.js or TypeScript code | **This SDK**                                                                                                                          |
| Generate things from a terminal without writing code   | [`@spicyapi/cli`](https://www.npmjs.com/package/@spicyapi/cli)                                                                        |
| Let an AI coding assistant call SpicyAPI               | [`@spicyapi/mcp`](https://www.npmjs.com/package/@spicyapi/mcp) and [`@spicyapi/skill`](https://www.npmjs.com/package/@spicyapi/skill) |
| Use a chat or text model                               | The official `openai` client — see [Chat and LLM streaming](#chat-and-llm-streaming)                                                  |
| Call SpicyAPI from a browser or mobile app             | Nothing: your key must stay on a server. Let your front end call your backend, and the backend call SpicyAPI                          |

## What you can do with it

| What you want to do                                            | Method                                        | Costs money?       |
| -------------------------------------------------------------- | --------------------------------------------- | ------------------ |
| Check that SpicyAPI is reachable (no key needed)               | `getStatus`                                   | No                 |
| See the live model list, your prices and each model's fields   | `listModels` / `getModel`                     | No                 |
| Get the exact price of a request without creating anything     | `quoteTask`                                   | No                 |
| Start a generation                                             | `createTask`                                  | **Yes**            |
| Start a generation and wait for the result in one call         | `run`                                         | **Yes**            |
| Read a task once, or wait until it finishes                    | `getTask` / `waitForTask`                     | No                 |
| Try a failed task again, as a new task                         | `retryTask`                                   | **Yes**            |
| List the tasks created with the current key                    | `listTasks`                                   | No                 |
| Check your balance, or what the current key spent              | `getBalance` / `getUsage`                     | No                 |
| Upload a local image, video, audio or document file            | `uploadFile` / `uploadBytes` / `uploadBase64` | No                 |
| Upload in separate steps (ticket, PUT, commit)                 | `createUploadUrl` / `commitUploadedFile`      | No                 |
| Get a fresh download link for a result                         | `createDownloadUrl`                           | No                 |
| Destroy a finished task's stored files and prompt              | `purgeTask`                                   | No (and no refund) |
| Check that a webhook really came from SpicyAPI                 | `verifyWebhook` / `computeWebhookSignature`   | No                 |
| Search the documentation, or read the bundled OpenAPI contract | `searchDocumentation` / `readOpenApiContract` | No                 |

"Costs money" means the call holds funds from your balance. You are charged only if the task
succeeds, never more than the held amount; failed and expired tasks release the hold in full. The
one exception is a `content_rejected` refusal on a model whose page states that refusals are billed,
which settles at the accepted estimate.

**Evaluating before you have a key?** One catalogue read is public, so "which models exist and what
do they cost" can be answered before signing up. It is a plain HTTPS GET rather than an SDK method:

```js
const response = await fetch("https://api.spicyapi.ai/console/v1/catalog/models?locale=en");
const { data } = await response.json();
for (const item of data.items) {
  console.log(item.model, item.modality, item.price?.amount, item.price?.unit);
}
```

Each item carries `model` and `slug` with the same value, so parsing code written here keeps working
against `listModels()`. `locale` accepts `en`, `ja`, `ko`, `de`, `fr`, `es`, `pt-BR`, `ru`, `it` and
`pl`, and the response is cached at the edge for a few minutes. **Once you hold a key, switch to
`listModels()`**: the authenticated catalogue is scoped to your key, carries your account's prices,
the full input JSON Schema and server-validated examples, and it is the surface `createTask`'s
`model` is contractually tied to. The public list is for evaluation, not for building `input`.

## Step 1 — Install

You need **Node.js 22.13 or later**. Check with `node -v`; if the number is lower, install the LTS
version from [nodejs.org](https://nodejs.org).

```bash
mkdir spicy-demo            # a new folder for your project
cd spicy-demo               # work inside it
npm init -y                 # create package.json
npm pkg set type=module     # let your files use `import`
npm install @spicyapi/sdk   # download the SDK
```

The package is an ES module only: `import { SpicyClient } from "@spicyapi/sdk"` works,
`require("@spicyapi/sdk")` fails with `ERR_PACKAGE_PATH_NOT_EXPORTED`. Without `"type": "module"`,
name your files `.mjs`. From CommonJS, use `await import("@spicyapi/sdk")` inside an async function.

## Step 2 — Get a key

1. Create an account at [spicyapi.ai/register](https://spicyapi.ai/register) — accounts are opened
   in batches, so you may join the waitlist first.
2. Create a key on the [API keys page](https://spicyapi.ai/console/keys). It starts with `sk-spicy-`
   and is shown once. New keys come with a low daily spend cap, which you can change there.
3. Add a balance under [Billing](https://spicyapi.ai/console/billing) before running paid tasks.
4. Put the key in the environment your program reads, never in source:

```bash
# macOS / Linux, for the current terminal window
export SPICY_API_KEY="sk-spicy-..."   # paste your own key
echo "${SPICY_API_KEY:0:9}"            # should print sk-spicy-
```

```powershell
# Windows PowerShell, for the current window
$env:SPICY_API_KEY = "sk-spicy-..."
```

The SDK reads `SPICY_API_KEY` from `process.env`; it does not load `.env` files itself. If you keep
the key in a `.env` file, start your program with `node --env-file=.env app.mjs` and add `.env` to
`.gitignore`. On a server, use your host's secret settings or pass `new SpicyClient({ apiKey })`.

## Step 3 — Check that everything works

This needs no key and costs nothing:

```js
// check.mjs — run with: node check.mjs
import { SpicyClient } from "@spicyapi/sdk";

const client = new SpicyClient();
const status = await client.getStatus();

console.log(status.operational ? "SpicyAPI is up" : "SpicyAPI is not reachable right now");
console.log("Checked at", status.checkedAt);
```

TypeScript works the same way: save it as `check.ts` and run `node check.ts` on recent Node.js
releases, or `node --experimental-strip-types check.ts`, or `npx tsx check.ts`.

## Step 4 — Your first result

This program picks an image model your key can use, prints the exact price and stops. Run it again
with `--yes` to create the image, wait for it and save it. Only the `--yes` run spends money.

```js
// first-result.mjs — run with: node first-result.mjs   then: node first-result.mjs --yes
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { SpicyApiError, SpicyClient } from "@spicyapi/sdk";

// Reads your key from the SPICY_API_KEY environment variable.
const client = new SpicyClient();

async function main() {
  // Step 1 — Is SpicyAPI reachable? Free, and needs no key.
  const status = await client.getStatus();
  if (!status.operational) {
    throw new Error("SpicyAPI is not reachable right now. Try again in a few minutes.");
  }

  // Step 2 — Which image models can this key call? Free.
  const catalog = await client.listModels({ modality: "image", includeExamples: true });
  const model = catalog.items.find(
    (item) => item.enabled && item.available && item.examples?.length,
  );
  if (!model) throw new Error("No image model is available to this key right now.");
  console.log(`Model: ${model.displayName} (${model.model})`);

  // Step 3 — Build the input. Start from an example the server has already
  // checked, and swap in your own prompt if the model takes one.
  const input = { ...model.examples?.[0]?.input };
  if ("prompt" in input) input.prompt = "A paper lantern glowing on a rainy street at night";

  // Step 4 — Ask for the exact price. Free: nothing is created or reserved.
  const request = { model: model.model, input };
  const quote = await client.quoteTask(request);
  console.log(`Price: $${quote.estimatedCost} USD`);

  if (!process.argv.includes("--yes")) {
    console.log("Nothing was charged. Run again with --yes to generate the image.");
    return;
  }

  // Step 5 — Create the task and wait for it. This is the step that costs money.
  const task = await client.run(
    { ...request, quoteId: quote.quoteId, expectedCost: quote.estimatedCost },
    {
      idempotencyKey: randomUUID(),
      onAccepted: (accepted) => console.log(`Task accepted: ${accepted.taskId}`),
      onUpdate: (update) => console.log(`State: ${update.state}`),
    },
  );

  // Step 6 — A failed task is a normal answer, not an exception. It is not charged.
  if (task.state !== "succeeded") {
    console.log(`The task ended as ${task.state}: ${task.errorCode} ${task.errorMessage ?? ""}`);
    console.log("Failed and expired tasks are not charged.");
    return;
  }

  // Step 7 — Download the result now. The link expires after about 20 minutes.
  const asset = task.output?.assets?.find((item) => item.url);
  if (!asset?.url) throw new Error("The task succeeded but its file is unavailable.");
  const download = await fetch(asset.url); // never send your API key here
  if (!download.ok) throw new Error(`Download failed with HTTP ${download.status}`);
  const extension = asset.mime?.split("/")[1] ?? "png";
  await writeFile(`result.${extension}`, Buffer.from(await download.arrayBuffer()));
  console.log(
    `Saved result.${extension}. Charged: $${task.cost}${task.settled ? "" : " (not final yet)"}`,
  );
}

main().catch((error) => {
  if (error instanceof SpicyApiError) {
    console.error(`SpicyAPI error ${error.code}: ${error.message} (request_id ${error.requestId})`);
  } else {
    console.error(error);
  }
  process.exitCode = 1;
});
```

What happens, step by step:

- Model IDs read `<publisher>/<model>/<task>`. Always take them from `listModels()` at run time, and
  use only items whose `enabled` and `available` are both `true`; do not hard-code one from memory.
- Every model accepts its own input fields, and one unknown field is rejected with `400`. Starting
  from a server-validated example avoids that. `getModel(id).inputSchema` lists every field.
- Passing `quoteId` and `expectedCost` means "only at the price I was shown": if the price changed,
  creation fails with `40901` instead of holding a different amount.
- `run` submits once and handles adaptive polling, including pending media transfer. Its local
  timeout (default 10 minutes, pass `timeoutMs` for video) covers submission and waiting; timing out
  or aborting **does not cancel the accepted task** — resume later with the task ID saved in
  `onAccepted`. For background jobs, use a webhook and skip polling entirely.

## Three rules

1. **The key stays on a server.** Set `SPICY_API_KEY` through the process environment or a secret
   manager. Never place a live key in browser code, a mobile bundle, source, prompts, logs or
   committed configuration.
2. **Read the schema before building `input`.** Two models in one family can take different fields.
   `getModel` returns the current schema; do not copy fields from a different model.
3. **`createTask`, `run` and `retryTask` spend money.** Persist one idempotency key per logical
   attempt and reuse it for every retry of that attempt. A new key means a new generation.

## Client reference

### Constructor options

`new SpicyClient()` needs no options for normal use. An invalid option throws a `TypeError`
immediately.

| Option                   | Default                                                     | Meaning                                                                                                               |
| ------------------------ | ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `apiKey`                 | `process.env.SPICY_API_KEY`                                 | Required by every method except `getStatus`; without it they throw `TypeError` before sending anything                |
| `timeoutMs`              | `30000`                                                     | One API request, 1–120000 ms. Not the total wait for a task                                                           |
| `uploadTimeoutMs`        | `600000`                                                    | The leg that sends file bytes to storage, 1–3600000 ms                                                                |
| `maxRetries`             | `2`                                                         | Extra attempts after a network error or HTTP 408, 429, 500, 502, 503 or 504 (0–5)                                     |
| `retryBaseDelayMs`       | `250`                                                       | First pause before a retry; doubles each attempt with ±25% jitter                                                     |
| `maxRetryDelayMs`        | `30000`                                                     | Longest pause. A longer `Retry-After` from the server ends retrying and returns the error                             |
| `apiBaseUrl`             | `SPICY_API_BASE_URL`, else `https://api.spicyapi.ai/api/v1` | HTTPS only; plain HTTP is accepted for loopback development                                                           |
| `serviceBaseUrl`         | `SPICY_SERVICE_BASE_URL`, else `https://api.spicyapi.ai`    | Used by `getStatus`                                                                                                   |
| `fetch`                  | `globalThis.fetch`                                          | Custom transport, for proxies or tests                                                                                |
| `onResponse`             | —                                                           | Receives method, path, status, request ID and rate-limit headers for each API response — never the key, body or media |
| `now`, `random`, `sleep` | —                                                           | Test hooks for the clock, jitter and pauses                                                                           |

**Automatic retries.** Reads (`getStatus`, `listModels`, `getModel`, `getTask`, `listTasks`,
`getBalance`, `getUsage`) and `quoteTask`, `purgeTask` and `commitUploadedFile` are retried
automatically. `createTask`, `run` and `retryTask` are retried **only when you pass an
`idempotencyKey`**, so a retry can never create a second task. `createUploadUrl`, the storage upload
and `createDownloadUrl` are not retried. Every method accepts `signal` (an `AbortSignal`); aborting
stops your request or wait, never an accepted task. API responses larger than 4 MiB are refused.

### Methods

| Method                                                                                            | Returns (key fields)                                                                                                                  | Costs money? |
| ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| `getStatus()`                                                                                     | `operational`, `health`, `readiness`, `checkedAt`. Never throws for network problems                                                  | No           |
| `listModels({ modality, task, provider, search, includeSchema, includeExamples })`                | `{ total, items }`; each item has `model`, `enabled`, `available`, `pricing`, `quantityField` and optional `inputSchema` / `examples` | No           |
| `getModel(modelId)`                                                                               | One model, always with `inputSchema` and `examples`                                                                                   | No           |
| `quoteTask({ model, input, callBackUrl })`                                                        | `quoteId`, `estimatedCost`, `maxCharge`, `quantity`, `unit`, `expiresAt` (five minutes)                                               | No           |
| `createTask(request, { idempotencyKey, retentionSeconds })`                                       | `taskId`, `state`, `estimatedCost` (the hold), `deadlineAt`                                                                           | **Yes**      |
| `run(request, { idempotencyKey, retentionSeconds, timeoutMs, intervalMs, onAccepted, onUpdate })` | The finished task record                                                                                                              | **Yes**      |
| `getTask(taskId)`                                                                                 | `state`, `output.assets[]` (`url`, `expiresAt`, `mime`, …), `errorCode`, `cost`, `settled`, `retention`                               | No           |
| `waitForTask(taskId, { timeoutMs, intervalMs, onUpdate })`                                        | The finished task record; throws `SpicyWaitTimeoutError` when time runs out                                                           | No           |
| `retryTask(taskId, { idempotencyKey })`                                                           | A new task: `taskId`, `sourceTaskId`, `state`, `estimatedCost`. Only for `failed` or `expired` tasks                                  | **Yes**      |
| `listTasks({ from, to, state, model, limit, cursor })`                                            | One page: `items`, `hasMore`, `nextCursor`                                                                                            | No           |
| `getBalance()`                                                                                    | `available`, `held`, `total`, optional `funding` breakdown                                                                            | No           |
| `getUsage({ from, to })`                                                                          | `totalCalls`, `totalSpend`, `days[]`, `models[]` for the current key                                                                  | No           |
| `uploadFile(path)` / `uploadBytes(data, { contentType })` / `uploadBase64(value)`                 | `uri` (`spicy://`, valid one day), `expiresAt`, `bytes`, `contentType`, `sha256`                                                      | No           |
| `createUploadUrl(contentType, bytes)` / `commitUploadedFile(fileId)`                              | Upload ticket, then the committed file with its `uri`                                                                                 | No           |
| `createDownloadUrl(taskId, key?)`                                                                 | `key`, `url`, `expiresAt` (about 20 minutes)                                                                                          | No           |
| `purgeTask(taskId)`                                                                               | `contentState`, `purgedAt`, `billingRetained: true`, `mediaDeletionPending`                                                           | No           |

`uploadFile` detects the type from the extension: `.jpg`, `.jpeg`, `.png`, `.webp`, `.gif`, `.mp4`,
`.webm`, `.mp3` and `.wav` for media, and `.pdf`, `.doc`, `.docx`, `.xls`, `.xlsx`, `.ppt`, `.pptx`,
`.key`, `.pages`, `.numbers`, `.txt` and `.md` for reference documents. For other names pass
`contentType`; otherwise it throws a `TypeError` that lists every supported extension. Images may be
up to 10 MiB; audio, video and documents up to 90 MiB.

`createTask` and `run` accept `retentionSeconds`, sent as `X-Spicy-Retention`, to shorten how long
that one task's generated media, result payload, prompt and other input text are kept; billing
records are always kept. It only ever shortens; the account settings and the platform maximum still
apply, and the deadlines that took effect come back in the task record's `retention` object
alongside `contentState`.

`purgeTask` destroys one terminal task's generated media, result payload, prompt and other input
text. It is idempotent — repeating it on an already destroyed task succeeds, returning the original
`purgedAt` — and it **destroys content, not the record of what it cost**: the ledger entry, charged
amount, model, state, timestamps and request ID all remain queryable. It is not a refund and does
not reverse a charge. A queued or running task is refused with `400`; an accepted task cannot be
canceled and there is no cancellation API, so wait for it with `waitForTask`, then purge it. It is
the one write that takes no idempotency key — `taskId` is the idempotency key, so the route does not
read an `Idempotency-Key` header and `purgeTask` sends none.

Three fields on a model record are classification only and never change what a request may do:
`mature` and `policyTier` describe the model creator's own metadata, and `toolkit` (currently only
`subject-swap`) says which toolkit family the model belongs to. None of them takes part in routing,
pricing or authorization, and `toolkit` is simply absent on models outside a toolkit. There is no
`toolkit` filter on `listModels`; read the field off the returned items.

Also exported: `searchDocumentation(query, limit)` and `DOCUMENTATION` (an offline index of the
documentation site, one entry per page, each `url` in the form
`https://docs.spicyapi.ai/docs/<slug>`; no match returns `[]`), `readOpenApiContract()` (the bundled
OpenAPI 3.1 YAML), the `DEFAULT_*` constants and `MAX_API_RESPONSE_BYTES`, and TypeScript types such
as `TaskRecord`, `ApiModel` and `Balance`. `@spicyapi/sdk/webhooks` exports only the webhook
helpers; `@spicyapi/sdk/openapi` exports only the raw `paths`, `components` and `operations` types.

TypeScript is the current official SDK. For Python, Go and other languages, generate a client from
the [OpenAPI 3.1 contract](https://docs.spicyapi.ai/docs/api-reference). Do not describe an
unpublished third-party wrapper as an official SDK.

## Handling errors

A failed **call** throws. A failed **task** does not: `run` and `waitForTask` return it with
`state: "failed"` and an `errorCode`, and it is not charged.

| Error class                     | Meaning                                                                         | Useful fields                                                                                                                       |
| ------------------------------- | ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `SpicyApiError`                 | SpicyAPI answered with an error                                                 | `code` (business code, e.g. `40201`), `status`, `message`, `requestId`, `retryAfterSeconds`, `rateLimitLimit`, `rateLimitRemaining` |
| `SpicyTransportError`           | No usable response: network failure or a response over 4 MiB                    | `cause`                                                                                                                             |
| `SpicyTimeoutError`             | One request exceeded `timeoutMs` or `uploadTimeoutMs` (a `SpicyTransportError`) | `timeoutMs`                                                                                                                         |
| `SpicyWaitTimeoutError`         | `run` or `waitForTask` ran out of time. **The task is still running**           | `taskId`, `timeoutMs`, `lastTask`                                                                                                   |
| `SpicyUploadError`              | Storage rejected the uploaded bytes, or the file exceeds the ticket limit       | `status`                                                                                                                            |
| `SpicyWebhookVerificationError` | A webhook failed verification                                                   | `reason`                                                                                                                            |
| `TypeError`                     | Invalid call: no key, an option out of range, an empty ID. Nothing was sent     | `message`                                                                                                                           |

Branch on `code`, never on `message`, and quote `requestId` to support. Common codes: `400` invalid
input (compare with the schema), `40003` the uploaded bytes do not match their upload ticket,
`40004` no deployment can serve this parameter combination, `401` key problem, `40201` balance too
low, `40202` spend cap reached, `40301` key may not use this model, `40310` the account's email
address is not verified yet (open the verification link; the key starts working as soon as it is
verified, with no change on your side), `40901` quote expired or price changed (quote again), `429`
too many requests (wait `retryAfterSeconds`), `503` a dependency is temporarily unavailable, `50301`
model unavailable right now, `50302` a synchronous generation failed upstream and was refunded.

The four codes that need a specific move rather than a plain retry:

- **`40003`** — the file's actual size, media type or signature does not match the upload ticket it
  was committed against. Do not re-commit the same ticket: upload the file again from the start
  (`uploadFile` does the whole flow) and use the new `uri`.
- **`40004`** — the request itself is valid, but nothing can serve that exact combination of
  parameters. Retrying unchanged returns the same answer. Change the parameter the message names —
  usually a resolution, duration or aspect ratio — against the model's `inputSchema`, then send it
  again.
- **`503`** — a dependency (a list or usage query, inline image storage) is temporarily unavailable.
  Back off by `retryAfterSeconds` when it is present; the SDK's automatic retries already do this
  for reads.
- **`50302`** — a synchronous generation failed upstream **and the charge was already refunded**.
  Sending the same request again is safe and is the intended move; it is not an idempotency hazard,
  because nothing is outstanding.

After a `SpicyTransportError` or `SpicyTimeoutError` from `createTask` you cannot tell whether the
task was created: send the same request again **with the same idempotency key**. After a
`SpicyWaitTimeoutError`, call `waitForTask(error.taskId)` later instead of creating a new task.

A failed task's `errorCode` decides the next step. `retryTask` sends the original input again
unchanged, so:

- `rate_limited`, `upstream_unavailable`, `timeout`, `upstream_failed` — wait, then `retryTask`
  once. If a `timeout` repeats, try a shorter duration or lower resolution with `createTask`.
- `generation_failed` — change the prompt or image and use `createTask`; the same input usually
  fails the same way.
- `invalid_asset` — upload the file again and use `createTask` with the new `uri`; a retry would
  reuse the old file.
- `content_rejected`, `invalid_request`, `unsupported_combination` — do not retry unchanged; change
  the prompt, settings or model and use `createTask`.

`errorMessage` is worth showing a user, but never worth branching on. When the model service gave a
specific reason — a corrupted reference image, a copyright restriction on generated audio — that
sentence is passed through in English, not translated, with service names, hosts, URLs, request and
task IDs and account or billing details stripped out. Otherwise you get SpicyAPI's own normalized
wording, which follows the same language selection as `msg`. Either way `errorCode` is the stable
value: it comes from a closed set and does not change with the wording or the language.

See the [errors guide](https://docs.spicyapi.ai/docs/errors).

## Prices and tiers

A model record's `pricing` array holds one entry per currently effective price tier, and
`startingPrice` is the cheapest of them. Each entry has a `unit` (`per_image`, `per_second`,
`per_request`, `per_1k_tokens` or `per_1k_characters`, the last for speech priced by the length of
the input text), a `price` as an exact decimal USD string, and a `variant` that names the tier:

| `variant`                           | What it means                                                                |
| ----------------------------------- | ---------------------------------------------------------------------------- |
| `""`                                | The model has a single price; there is nothing to choose                     |
| `720p`                              | One input field sets the price, and this is that field's value as it is sent |
| `duration=5;resolution=720p`        | Several fields set the price: `field=value` pairs sorted by field name, `;`  |
| `generate_audio=~;resolution=1080p` | `~` stands for an optional field that was not sent and has no default        |

Values inside a compound key are URL-encoded. Build the key by reading the fields, never by
reformatting a display string; and do not assume a model has tiers at all, since many do not.

The public catalogue in the snippet above expresses the same thing differently: `price.amount` is
the starting price, `price.tiers` counts the effective tiers, and `price.variants` lists every tier
cheapest first, so the first entry and `price.amount` always agree. Per-token models have
`price.perMillionTokens` instead and no `variants` array. A tier may also carry `listPrice`, which
is the **model creator's** own published price and appears only when ours is at least 1% below it —
it is not a pre-discount price of ours.

**Some video endpoints bill in whole blocks.** Where a model declares a block, the duration of the
source clip is rounded up to the next block boundary before it is priced, so a 6-second clip on a
5-second block is billed as 10 seconds, and a 6-second clip on an 8-second block is billed as 8.
This applies only to endpoints that declare a block — it is not how per-second pricing works in
general — and each model's page states its block length. The amount `quoteTask` returns is the
amount that will be held; the final charge is computed on the rounded-up duration and can never
exceed that hold, so a block never produces a surprise above the number you confirmed.

## Confirming a price before you spend

When a caller needs an exact price confirmation, quote the request, show the numbers, then pass the
quote into creation:

```ts
const payload = { model, input };
const quote = await client.quoteTask(payload);
// Show quote.estimatedCost, quote.maxCharge and quote.expiresAt to the user.

const accepted = await client.createTask(
  { ...payload, quoteId: quote.quoteId, expectedCost: quote.estimatedCost },
  { idempotencyKey: operationId },
);
```

Pre-authorized server workflows can submit directly at current pricing. Separate health, balance and
quote requests are not mandatory steps — the exact `estimatedCost` comes back with the acceptance.

## Media inputs and results

Pass a publicly accessible HTTPS image, video or audio URL directly in the field the model schema
specifies. Uploading is optional:

- `uploadFile` reads a local file and runs the whole upload for you, returning an account-bound
  `spicy://` URI valid for one day. Put `file.uri` in the model's media field.
- `createUploadUrl` → PUT → `commitUploadedFile` is the same flow in separate steps.
- `uploadBase64` accepts a Data URI or raw standard Base64 with an explicit `contentType`.
- Reference documents (PDF, Word, Excel, PowerPoint, Keynote, Pages, Numbers, plain text and
  Markdown) upload the same way, for models whose schema declares a document field such as
  `reference_file_url`.
- Image fields also accept your own persona images as `spicy://p/<assetId>`. You create them in the
  console, and only API keys created in your personal workspace can use them.
- Small schema-declared image fields accept Data URIs directly in `input` (1 MiB decoded per image,
  2 MiB total JSON body, with documented pixel limits). The upload helper handles larger files
  within upload and model limits.

```js
const file = await client.uploadFile("./photo.jpg");
const task = await client.run(
  { model: modelId, input: { prompt: "Slow push-in, light rain", image_url: file.uri } },
  { idempotencyKey: randomUUID(), timeoutMs: 30 * 60_000 },
);
```

Use the image field name the model's schema actually declares.

`getTask` and `waitForTask` return ready media in `output.assets` — `url`, `expiresAt`, MIME, and
available dimensions, duration and byte count. Download `asset.url` directly **without forwarding
`SPICY_API_KEY`**; no separate `createDownloadUrl` call is needed. `pending` assets need another
poll; `unavailable` assets are gone and must be generated again. URLs normally last 20 minutes,
inside the 14-day result retention window; poll again to refresh one. See the
[media guide](https://docs.spicyapi.ai/docs/media).

Not every task hands back a file. A task can also answer in `output.text` — audio transcription is
the clearest case: it is an ordinary asynchronous media task, but what it produces is words. Read
`output.text` when the model you selected produces text, and do not treat an empty `output.assets`
as a failure on those models. Speech-to-text models that report more also return `output.transcript`
(`TaskTranscript`): the detected language, the duration, per-word `start` and `end` times in
seconds, and one entry per channel when multichannel transcription was requested.

Layer decomposition results put a `layer` object on each asset (`TaskOutputAsset`). The first asset
is the base image with `zIndex` 0; every other asset is a transparent PNG layer. Stack them by
ascending `zIndex`, placing each one inside its `boundingBox` (`[x1, y1, x2, y2]` in base-image
pixels) when the model reports one.

## Webhooks

A webhook lets SpicyAPI call your server when a task finishes. Pass `callBackUrl` to `createTask`,
get a signing key you can copy, and verify every delivery before acting on it — anyone who knows
your URL can post a fake "task succeeded" message.

`callBackUrl` must be a public `https://` address. Plain `http://` is refused, and so are
`localhost`, private network addresses, explicit ports other than 443 and 80, and URLs carrying
credentials; all of them return `400` with `msg: "Invalid callback URL"`. The reason `http://` has
no development exception here is that the delivery body carries the prompt and signed links to the
result: sending it in the clear would publish both to anything on the path. To receive callbacks on
a laptop, put a tunnel with a real certificate in front of it rather than asking for `http://`.

Every account gets a signing key automatically at registration, but its value is never shown. To get
one you can store as `SPICY_WEBHOOK_SECRET`, click **Generate** (or **Rotate**) on the console's
[Webhooks page](https://spicyapi.ai/console/webhooks); the plaintext is shown only once. Rotation
has no overlap period: the old key stops signing immediately, so update every running receiver right
away.

```ts
import { verifyWebhook } from "@spicyapi/sdk";

const { payload, taskId, deliveryId } = verifyWebhook({
  rawBody, // the exact received bytes, before any parsing
  secret: process.env.SPICY_WEBHOOK_SECRET!,
  timestamp: headers["x-webhook-timestamp"],
  signature: headers["x-webhook-signature"],
  payloadVersion: 2,
});
```

Verify against the **exact received bytes**, before any JSON parsing or re-serialization, and
deduplicate on `request_id` (returned as `deliveryId`) rather than a full-body hash. Answer with a
2xx within 15 seconds and do slow work afterwards. V2 webhooks carry the same result fields as a
task read; a retry keeps the business event and `request_id` but refreshes `url` and `expiresAt`. V1
payloads are unchanged.

`verifyWebhook` rejects deliveries older than `toleranceSeconds` (default 300) and bodies over
`maxBodyBytes` (default 1 MiB), and throws `SpicyWebhookVerificationError` with a `reason` such as
`invalid_signature` or `stale_timestamp`.
`computeWebhookSignature(taskId, timestamp, rawBody, secret)` signs a test body so you can check
your receiver locally. A complete receiver built on `node:http` is in the
[SDK guide](https://docs.spicyapi.ai/docs/sdk); the signing algorithm for other languages is in the
[webhooks guide](https://docs.spicyapi.ai/docs/webhooks).

## Task history

`listTasks` reads one page of metadata for the current API key. It does not fetch each task's
inputs, results or media URLs. Keep the UTC dates fixed while paging and pass the cursor unchanged:

```ts
const filters = { from: "2026-09-01", to: "2026-09-07", limit: 20 };
const page = await client.listTasks(filters);
if (page.hasMore && page.nextCursor) {
  const nextPage = await client.listTasks({ ...filters, cursor: page.nextCursor });
  console.log(nextPage.items);
}
```

The UTC interval is `[from,to)`, defaults to seven days ending tomorrow UTC, and cannot exceed 92
days. Page size defaults to 20 and is capped at 100. Optional `state` and `model` filters narrow the
results. Each `cost` is an exact decimal USD string, final only when `settled` is true. Hidden tasks
are excluded, so use `getUsage` for settled spending reports.

This endpoint has its own account-wide bucket: a burst of 30 requests, refilling 30 per minute,
shared by every key on the account. Unlike the general API limit it fails closed, so it still
rejects when the limiter is degraded. Use it for reconciliation, not polling.

History is for discovery and recovery. Use `run`, `waitForTask` or webhooks to track normal
completion, and `getTask` only for a result you actually selected.

## Chat and LLM streaming

This SDK deliberately keeps tasks, quotes and uploads in one small client and does not reimplement
the OpenAI streaming protocol. For token-by-token chat, use the official `openai` client against
SpicyAPI's compatible endpoints (`npm install openai`):

```js
import OpenAI from "openai";

const client = new OpenAI({
  apiKey: process.env.SPICY_API_KEY,
  baseURL: "https://api.spicyapi.ai/v1",
  maxRetries: 0, // never silently repeat a billable operation
});

const signal = AbortSignal.timeout(120_000);
const stream = await client.chat.completions.create(
  {
    model: process.env.SPICY_MODEL,
    messages: [{ role: "user", content: "Explain a rainbow in one sentence." }],
    stream: true,
    stream_options: { include_usage: true },
  },
  { signal, headers: { "Idempotency-Key": process.env.SPICY_IDEMPOTENCY_KEY } },
);

try {
  for await (const chunk of stream) {
    process.stdout.write(chunk.choices[0]?.delta.content ?? "");
    if (chunk.usage) process.stderr.write(`${JSON.stringify(chunk.usage)}\n`);
  }
} finally {
  stream.controller.abort();
}
```

Notes that matter in production:

- The abort signal covers stream consumption as well as connection setup. Aborting stops the local
  stream; it does not cancel an accepted task or promise a refund.
- With `stream: false`, read `choices[0].message.content`.
- In a tool conversation, accumulate tool-call fragments by index and preserve the complete
  assistant message before adding matching `tool_call_id` results.
- Enable tool or reasoning fields only when the model schema supports them. Reasoning-capable models
  may return `delta.reasoning_content`, which can need an explicit type extension in the official
  client; its tokens are already counted in `completion_tokens`.
- Compatibility requests use the price at acceptance. Use native `quoteTask` and `createTask` when
  confirming `expectedCost` is required.
- Stream completion is not proof of financial settlement. Once a `/v1` text request is accepted, the
  `X-Spicy-Task-Id` response header names the task that holds the charge (also on errors returned
  after acceptance); read it with `.withResponse()` and look the task up with `getTask`. It is
  absent when the request was rejected before a task existed, or when a keep-alive had already sent
  the stream's headers.
- While a long reasoning model has produced nothing yet, the stream carries `: keep-alive` comment
  lines; the official client skips them. A non-streaming call that takes longer than about 100
  seconds is cut off by the network edge and not charged, so use `stream: true` for long reasoning.
- A content-policy refusal is `400` with `code: content_rejected`; a field or message part the model
  does not accept is `400` with `code: unsupported_parameter` and `param` naming it. Change the
  input rather than retrying unchanged.

OpenAI is not the only protocol the text models answer. The same catalogue is reachable through
`POST /v1/chat/completions` and `POST /v1/responses` (OpenAI), `POST /v1/messages` (Anthropic) and
`POST /v1beta/models/{model}:generateContent` (Google Gemini), all under `https://api.spicyapi.ai`.
Keep the official client you already use and point its base URL at SpicyAPI; validation, pricing and
availability are identical across the four. This SDK stays with asynchronous media tasks on purpose,
so there is no chat method to look for here.

See the [complete compatibility guide](https://docs.spicyapi.ai/docs/quotes-and-compatibility) and
the [official JavaScript client](https://github.com/openai/openai-node).

### Images, video and audio in a message

Some chat models read images, and a few also read video and audio; the answer is still text. Which
parts a model takes is declared in its `inputSchema` under `properties.messages` (read it with
`getModel`), and a part the model does not take returns `400` with `code: unsupported_parameter`,
charging nothing. Upload a local file with this SDK and put its `spicy://` URI in the part:

```js
import OpenAI from "openai";
import { SpicyClient } from "@spicyapi/sdk";

const spicy = new SpicyClient();
const clip = await spicy.uploadFile("./clip.mp4");

const openai = new OpenAI({
  apiKey: process.env.SPICY_API_KEY,
  baseURL: "https://api.spicyapi.ai/v1",
  maxRetries: 0,
});
const { data: completion, response } = await openai.chat.completions
  .create({
    model: process.env.SPICY_MODEL,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "What happens in this clip?" },
          { type: "video_url", video_url: { url: clip.uri } },
        ],
      },
    ],
  })
  .withResponse();
console.log(completion.choices[0].message.content);
console.log(response.headers.get("x-spicy-task-id")); // the task that holds the charge
```

| Part         | Shape                                                                                  |
| ------------ | -------------------------------------------------------------------------------------- |
| Image        | `{ type: "image_url", image_url: { url } }` — HTTPS, `spicy://` or a small `data:` URI |
| Video        | `{ type: "video_url", video_url: { url } }` — an upload, or a public HTTPS URL         |
| Audio file   | `{ type: "audio_url", audio_url: { url } }` — an upload only                           |
| Inline audio | `{ type: "input_audio", input_audio: { data, format } }` — Base64, `wav` or `mp3`      |

`video_url` and `audio_url` are not in the `openai` package's TypeScript types; the client sends
them unchanged, so in TypeScript cast the content array
(`as OpenAI.Chat.ChatCompletionContentPart[]`). Uploaded video and audio in one request can total at
most 14 MB. See
[sending media to a text model](https://docs.spicyapi.ai/docs/text-and-streaming#media-input).

## Troubleshooting

- **`TypeError: SPICY_API_KEY is required for authenticated API operations`** — the variable is not
  set in the terminal or process running `node`. Set it again in that window, or start with
  `node --env-file=.env`.
- **`SpicyApiError` 401** — "API key format is not recognized" means the value does not start with
  `sk-spicy-`; "Credentials are invalid or expired" means the key was disabled or mistyped. Create a
  new key.
- **`Cannot use import statement outside a module` or `ERR_PACKAGE_PATH_NOT_EXPORTED`** — run
  `npm pkg set type=module` or use the `.mjs` extension.
- **`SpicyWaitTimeoutError`** — the task is still running. Call `waitForTask(error.taskId)` with a
  longer `timeoutMs`; do not create it again under a new key.
- **Download link returns 403** — result links last about 20 minutes. Call `getTask` again for a
  fresh `url`.
- **`API response exceeded 4194304 bytes`** — narrow `listModels` with `modality` or `task` when you
  include schemas, or use `getModel`.
- **`network request failed` while `curl` works** — check whether your shell sets `HTTPS_PROXY`.
  Node.js's built-in `fetch` ignores proxy variables unless the process starts with
  `NODE_USE_ENV_PROXY=1` (Node.js 22.21+ or 24+); the error then names the variable it did not use.
  Start `node` with that variable, or pass your own proxy-aware implementation as the `fetch`
  option. The CLI and the MCP server switch it on for you.
- **Can I cancel a task?** No. An accepted task runs to the end; aborting only stops your side.

## More

- [SDK guide](https://docs.spicyapi.ai/docs/sdk) · [Developer hub](https://spicyapi.ai/developers) ·
  [Full documentation](https://docs.spicyapi.ai/docs)
- Prefer a terminal? [`@spicyapi/cli`](https://www.npmjs.com/package/@spicyapi/cli). Prefer a coding
  agent? [`@spicyapi/mcp`](https://www.npmjs.com/package/@spicyapi/mcp).
