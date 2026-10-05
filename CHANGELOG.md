# @spicyapi/sdk

## 0.8.0

### Minor Changes

- Upload reference documents. The platform now accepts PDF, Word, Excel, PowerPoint, Keynote, Pages,
  Numbers, plain text and Markdown files for models whose schema declares a document field such as
  `reference_file_url`. `uploadFile` infers the type from `.pdf`, `.doc`, `.docx`, `.xls`, `.xlsx`,
  `.ppt`, `.pptx`, `.key`, `.pages`, `.numbers`, `.txt` and `.md`, and `uploadBase64` accepts the
  same types; documents share the 90 MiB limit of audio and video. Until now neither helper knew
  these types: `uploadFile("brief.pdf")` threw before anything was sent. Both tables are now checked
  at compile time against the contract's upload types, so the next type the contract adds cannot be
  left out silently.
- Refresh the bundled OpenAPI contract and its generated types to the live API. New in the types:
  `output.transcript` with word timings, language and channels on speech-to-text results (exported
  as `TaskTranscript`); `layer` with `zIndex` and `boundingBox` on layer decomposition assets
  (`TaskOutputAsset`); the `per_1k_characters` price unit used by speech models; the `studio-tools`
  toolkit; `requestId` on task records; business code `40310` (the account's email address is not
  verified); the `X-Spicy-Task-Id` header, `top_k`, `seed`, `stop` and `parallel_tool_calls` on the
  compatible text endpoints; and the `modality` filter and chat metadata on `GET /v1/models`.
- Document chat models that read images, video and audio. The README shows how to upload a file with
  this SDK and send its `spicy://` URI as an `image_url`, `video_url` or `audio_url` part (or inline
  audio as `input_audio`) through the official `openai` client, how to read the `X-Spicy-Task-Id`
  header, and what the `: keep-alive` lines, `unsupported_parameter` and `content_rejected` mean. A
  test confirms the official client forwards the parts its own types do not declare unchanged.
- Bring the documentation index in line with the site: add the Chat recipes and Migrate from OpenAI
  or OpenRouter pages, so `searchDocumentation("openrouter")` and `"role-play"` find them, and
  update titles and summaries that had drifted.

## 0.7.6

### Patch Changes

- Say so when a request skipped the proxy the shell set up. Node.js's built-in `fetch` ignores
  `HTTPS_PROXY` and `HTTP_PROXY` unless the process started with `NODE_USE_ENV_PROXY=1`, while curl,
  git and npm in the same terminal honor them. The request then goes out directly, and the failure
  points anywhere but the proxy. When a request made through the runtime's own `fetch` cannot
  connect, or is answered by something other than the API, and an `http://` or `https://` proxy
  variable is set without that switch, the error now ends with:

  ```text
  HTTPS_PROXY is set, but this request did not use it: Node.js fetch ignores proxy variables unless NODE_USE_ENV_PROXY=1 is also set (Node.js 22.21+ or 24+).
  ```

  Nothing is added for a caller-supplied `fetch`, which may route through a proxy already; for a
  `socks5://` or bare `host:port` value, which Node.js refuses to start with once the switch is on;
  or when the switch is already on.

## 0.7.5

### Patch Changes

- Add the four language SDK pages and the image generation guide to the documentation index, so
  `docs search` and `docs read` can reach them. The pages went live on the documentation site
  earlier; until now this hand-maintained index did not list them, and a search for "python sdk"
  or "lora" simply returned nothing rather than saying the page was missing.

## 0.7.4

### Patch Changes

- Lead with the fact the caller can act on when a reply did not come from SpicyAPI. A request
  stopped at the edge returns `403` with a page the platform never wrote; it used to surface as
  `API response was not valid JSON`, or as the generic `request failed with HTTP 403`. Both read as
  "the API is broken" and send the reader — often an assistant acting on the caller's behalf — to
  debug an endpoint that never received the request. A `403` now opens with the regions the service
  is offered in, and only then quotes whatever answered:

  ```
  Refused before reaching SpicyAPI (HTTP 403). The service is not offered in every region:
  https://spicyapi.ai/legal/terms. A proxy, gateway or CDN edge answered instead - the body said
  "Error 1010: Access denied - The site owner has blocked access based on your browser's signature."
  ```

  The platform's own errors are untouched and still reported in the platform's own words. The raw
  reply, truncated, is kept on the new `SpicyApiError.responseBody`, which is set only for foreign
  replies.

  Whether the body parses was never the right test, and assuming it was is how the common case got
  missed: Cloudflare content-negotiates its error pages and this client always sends
  `Accept: application/json`, so an edge block arrives as well-formed JSON at least as often as it
  arrives as HTML. The test is now authorship — every platform reply carries a numeric `code` —
  rather than syntax.

## 0.7.0

### Minor Changes

- Add `waitSeconds` to `createTask`, so the first poll is unnecessary: the server holds the
  connection open until the task reaches a terminal state, and answers with the full task record
  when it does. The value is sent verbatim — the server clamps anything above 60 seconds and ignores
  anything that is not a positive integer, so clamping it again on the client would only take that
  tolerance away. Only a negative value is refused locally.

  **Running out of budget is not an error.** It returns the ordinary accepted response, exactly as
  if you had never asked, and the two have the same shape and differ only in `state`. Passing
  `waitSeconds` therefore proves nothing about whether the task finished. Branch on the newly
  exported `isTerminal(task)` instead:

  ```ts
  const task = await client.createTask(input, { idempotencyKey: key, waitSeconds: 30 });
  const final = isTerminal(task) ? task : await client.waitForTask(task.taskId);
  ```

  Disconnecting stops the wait and nothing else: the task keeps running and is billed as usual.

## 0.6.0

### Minor Changes

- Fix `spicyapi_models_list` and `spicyapi_model_get` failing outright on 16 of the 121 published
  endpoints. The MCP output schema pinned `policyTier` to three values while the service already
  returns five; `softened` and `filtered` made the MCP SDK reject the structured content, so any
  unfiltered catalogue listing raised `Output validation error` rather than returning models. The
  field is now an open set, because a descriptive classification should never be able to fail a
  call.

  Catch the bundled contract up with the service. New: the anonymous evaluation catalogue
  `GET /console/v1/catalog/models`, which answers "which models are there and what do they cost"
  without an API key; business codes `40003` (uploaded bytes do not match their ticket), `40004` (no
  deployment serves that parameter combination), `503` (dependency briefly unavailable) and `50302`
  (a synchronous generation failed upstream and was already refunded); `toolkit`, marking the models
  that replace a person in an image or a video; per-tier `variants` alongside each price.
  `callBackUrl` now rejects `http://`, task `errorMessage` carries the model service's own reason in
  English when there is one, and `jobs/purge` reads no `Idempotency-Key` — `taskId` is the key.

  Document the subject-swap two-step video workflow, block-rounded duration billing, and where text
  models live: the SDK, CLI and MCP server cover asynchronous media tasks, while chat runs through
  the OpenAI, Anthropic and Gemini compatible layers with an existing client.

## 0.5.2

### Patch Changes

- The built-in documentation index (used by `searchDocumentation`, `spicyapi docs search` and the
  MCP `docs_search` tool) is rebuilt from the live documentation site: current page titles, the new
  SDK, CLI, MCP, Skill, overview, account setup, glossary, FAQ and image-to-video tutorial pages,
  and final `https://docs.spicyapi.ai/docs/<slug>` URLs that no longer go through two redirects.
- `uploadFile` now names every extension it can infer a content type for (images, video and audio)
  when it cannot infer one, instead of listing images only.
- Documentation comments describe what a task's retention covers: generated media, result payload,
  prompt and other input text.

## 0.5.1

### Patch Changes

- Stop reporting a healthy platform as down. `probeStatus` treated a 404 from `/readyz` as "not
  ready", but the readiness probe exposes database and Redis state, so the server registers it only
  on the management process — the public one never had it. `operational` was therefore always false
  on the production domain, and that is the answer to the first command the README recommends, the
  only one that needs no key and costs nothing. A genuine outage still surfaces: an unready service
  answers 503, not 404.

  `spicyapi status` now prints one line a person can read, and keeps the previous structure behind
  `--json`. CLI failures append a `Next:` line saying what to do — for 401 it distinguishes no key
  set, a key whose prefix is not `sk-spicy-`, and a key that the server rejected, echoing only the
  first nine characters.

  Documentation: the README example points at an endpoint that is live and priced instead of a
  paused one, and the MCP setup covers Claude Desktop alongside the other clients.

## 0.5.0

### Minor Changes

- 25887e3: Give uploads their own timeout. `timeoutMs` caps at 120 s, which cannot carry a 90 MiB
  file unless the connection sustains 6.3 Mbps; the request was cut mid-transfer and surfaced as a
  local timeout. `uploadTimeoutMs` defaults to 10 minutes and applies only to the leg that moves the
  bytes.

  `spicyapi_upload_file` now expands a leading `~` and reports its three refusals apart — not
  absolute, no such file, outside the allowed roots — naming the roots it will read. One shared
  message sent the model to change the folder when the real problem was an unexpanded `~`, which
  already pointed inside the allowed root.

- 983dd22: Add customer-controlled retention and on-demand content destruction across all four
  surfaces.

  `createTask` (and `run`) accept `retentionSeconds`, sent as `X-Spicy-Retention`, to shorten how
  long one task's outputs and prompt are kept; `0` removes the outputs as soon as the task reaches a
  terminal state. It can only shorten — the account settings and the platform maximum still apply,
  and the deadlines that actually took effect come back in the task record's new `retention` object.
  An oversized value is clamped by the server rather than rejected, so a request asking to be more
  conservative never fails the generation.

  `purgeTask` destroys one terminal task's generated media, result payload, prompt and input text,
  and is idempotent. It destroys content, not the record of what it cost: the ledger entry, charged
  amount, model, state, timestamps and request ID all remain queryable, so it is never a refund.
  Task records now carry `contentState`, which distinguishes `expired` (the retention rules ran)
  from `purged` (the account destroyed it deliberately) — reporting the second as the first makes it
  look like the platform lost the customer's work.

  The CLI adds `tasks purge`, gated behind the same interactive confirmation or `--yes` as a
  billable command, and `tasks create --retention` accepting `30m`, `1h`, `7d` or plain seconds.
  `tasks get` now spells out the content state and retention deadlines in its human-readable output.

  The MCP server adds `spicyapi_task_purge` with `destructiveHint: true` and a confirmation round.
  Its result is projected onto a fixed whitelist — task ID, content state, removal metadata — so no
  link, ticket or output key can travel in the same message that reports the content's destruction.

### Patch Changes

- 39e03de: Lower the audio and video upload ceiling from 100 MiB to 90 MiB, matching the server.
  Reference media no longer travels straight from the browser to object storage: it is streamed
  through a first-party route so the presigned ticket is never handed to the client, and the edge
  runtime in front of that route caps request bodies at 100 MB. The Base64 helper now rejects
  oversized audio and video locally instead of letting the server reject it after the whole upload.
- 4c586b6: Correct three things the package documentation had wrong. Public model IDs read
  `<publisher>/<model>/<task>` — `bytedance/seedream-5.0-pro/text-to-image` — not the internal
  `<family>/<version>/<task>` slug; the Skill's own workflow reference used the internal shape as
  its placeholder, so an agent reading it would assemble identifiers that do not resolve. There are
  no audio models: the catalog is video, image and chat, and every README opened by claiming
  otherwise. And the quickstarts could not be run as written, because both the model ID and the API
  key were placeholders with no command next to them for obtaining a real one.

  Every README now starts from getting a key (`spicyapi.ai/register`, then the console; keys begin
  `sk-spicy-`) and lists a model before using one. `npx @spicyapi/cli` and `npx @spicyapi/skill` are
  documented without `--yes --package=`, which only `@spicyapi/mcp` needs — it ships two binaries,
  so the short form fails with `could not determine executable to run`. The Skill installs with
  `npx skills add https://spicyapi.ai/skill` through the installer most coding agents share, with
  the packaged installer kept as the second option. The MCP client examples no longer pin `@0.1.0`.

## 0.4.0

### Minor Changes

- Expose optional account funding details in balance responses, with typed promotional grants and
  approved credit facilities. Preserve exact USD strings and compatibility with balance responses
  that do not include funding.

## 0.3.0

### Minor Changes

- Add `listTasks` for paginated current-key task metadata, with UTC date, model and state filters,
  opaque cursors, and exact USD cost strings. Read one page without extra task lookups.

- Add one-call task execution, bounded adaptive waiting, Base64 upload support, and current-key USD
  usage. Preserve request IDs through optional response metadata and clarify direct media results
  and timeout recovery.

## 0.2.1

### Patch Changes

- 6d04fa3: Add typed first-party result URLs and expiry metadata while preserving extensible output
  fields. Clarify that public HTTPS media inputs do not require an upload, and that v2 webhook
  retries may refresh temporary URLs without changing the business event ID.

## 0.2.0

### Minor Changes

- Add request-bound task quotes and expected-cost checks, document the public compatibility
  endpoints, and unify the development workflow across the SDK, CLI, MCP, and Agent Skill.

  The SDK now enforces an end-to-end timeout and a size limit when reading response bodies, and
  fills in the OpenAI-compatible examples and regression tests. The CLI and MCP add read-only
  quoting while keeping explicit confirmation and idempotency controls for billable writes. The
  content-mode field sent by older clients is now ignored for task admission.
