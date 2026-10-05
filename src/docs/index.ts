export interface DocumentationEntry {
  slug: string;
  title: string;
  summary: string;
  url: string;
  keywords: string[];
}

/* The documentation site's final address. `https://spicyapi.ai/en/docs/...` first 308s to
   `/docs/...` and then to docs.spicyapi.ai, two wasted round trips; this points straight at the
   destination. Verified page by page with `curl -sI` on 2026-09-17: every existing page answers 200
   under this prefix with no redirect. */
const DOCS_BASE_URL = "https://docs.spicyapi.ai/docs";

/* Order, titles and summaries follow `content/docs/meta.en.json` in spicy-docs and the title and
   description in each page's `*.en.mdx` frontmatter; changing the site means changing this too.
   keywords is not a site field: it adds terms absent from the summary that people nonetheless
   search for - including retrieval terms lost when a summary was rewritten (billing's refund and
   settlement, for instance) - so that the same question does not stop matching after an edit.
   The one deliberate difference: the four language SDK summaries leave out the package or module
   identifier the site puts in brackets, because those identifiers move with the repositories and a
   stale one here would point somebody at the wrong install command. */
const definitions: Array<Omit<DocumentationEntry, "url">> = [
  {
    slug: "overview",
    title: "How SpicyAPI works",
    summary:
      "What SpicyAPI is, what you can make with it, the four ways to use it with or without code, and the few ideas every other page builds on.",
    keywords: ["overview", "what is spicyapi", "concepts", "how it works"],
  },
  {
    slug: "account-setup",
    title: "Set up your account",
    summary:
      "Go from no account to a working API key in about fifteen minutes. Sign up, verify your email, add funds, create a key and make a free test call, with every screen explained.",
    keywords: ["account", "sign up", "register", "waitlist", "top up", "first key"],
  },
  {
    slug: "",
    title: "Quickstart",
    summary: "Get a key, create a task, collect the result. The whole path, end to end.",
    keywords: ["start", "guide", "quickstart", "introduction", "tutorial"],
  },
  {
    slug: "cli",
    title: "Command-line tool (CLI)",
    summary:
      "Use the spicyapi command to browse models, check prices, generate images and videos and download the results from a terminal, without writing code.",
    keywords: ["cli", "terminal", "command line", "shell", "npx"],
  },
  {
    slug: "mcp",
    title: "MCP server",
    summary:
      "Connect Claude, Cursor, VS Code and other AI assistants to SpicyAPI, then browse models, compare prices, generate media and collect results by chatting — with every paid step confirmed by you.",
    keywords: ["mcp", "model context protocol", "claude", "cursor", "assistant", "elicitation"],
  },
  {
    slug: "skill",
    title: "Agent Skill",
    summary:
      "A ready-made playbook for AI coding assistants. Install it once and your assistant builds SpicyAPI integrations the safe, correct way. What it is, what it changes, how to install it and how to check it works.",
    keywords: ["skill", "agent skill", "coding assistant", "playbook", "install"],
  },
  {
    slug: "sdk",
    title: "TypeScript SDK",
    summary:
      "A step-by-step guide to the TypeScript SDK @spicyapi/sdk — install it, get your first result, and look up every method, option and error in plain language. Python, Go, PHP and Java SDKs are documented on their own pages.",
    keywords: ["sdk", "typescript", "javascript", "node", "npm", "client library"],
  },
  {
    slug: "sdk-python",
    title: "Python SDK",
    summary:
      "The official Python SDK — install it, quote and run your first generation, upload a local file, verify webhooks and read every error code.",
    keywords: ["sdk", "python", "pip", "pypi", "asyncio", "client library"],
  },
  {
    slug: "sdk-go",
    title: "Go SDK",
    summary:
      "The official Go SDK — install it, quote and run your first generation, upload a local file, walk your task history and handle every error code.",
    keywords: ["sdk", "go", "golang", "go get", "module", "client library"],
  },
  {
    slug: "sdk-php",
    title: "PHP SDK",
    summary:
      "The official PHP SDK — install it with Composer, quote and run your first generation, upload a local file, verify webhooks safely and handle every error code.",
    keywords: ["sdk", "php", "composer", "packagist", "laravel", "client library"],
  },
  {
    slug: "sdk-java",
    title: "Java SDK",
    summary:
      "The official Java SDK — install it, quote and run your first generation, upload a local file, verify callbacks and switch exhaustively over a sealed error taxonomy.",
    keywords: ["sdk", "java", "maven", "gradle", "jvm", "kotlin", "client library"],
  },
  {
    slug: "authentication",
    title: "Authentication",
    summary:
      "Key format, per-key restrictions, which tasks a key can see, and what to do the moment a key leaks.",
    keywords: ["api key", "bearer", "security", "rotation", "incident"],
  },
  {
    slug: "models",
    title: "Model catalog and schemas",
    summary:
      "Use the authenticated live catalog to select callable models, read their prices, and build requests from their current JSON Schema.",
    keywords: [
      "catalog",
      "schema",
      "input schema",
      "price",
      "model",
      "examples",
      "validation",
      "json schema draft",
    ],
  },
  {
    slug: "tasks",
    title: "Asynchronous tasks",
    summary:
      "The createTask and recordInfo contracts, what each of the six states means, and how to choose between callbacks and polling.",
    keywords: ["createTask", "recordInfo", "poll", "polling", "state", "cost", "outputs"],
  },
  {
    slug: "media",
    title: "Media",
    summary:
      "Presigned direct uploads for reference media, and short-lived download links for artefacts.",
    keywords: [
      "upload",
      "download",
      "file",
      "image",
      "maximum bytes",
      "size limit",
      "public https media",
      "signed result url",
      "document",
      "pdf",
    ],
  },
  {
    slug: "webhooks",
    title: "Webhooks",
    summary:
      "Distinguish v1 and v2 webhook payloads, select the correct task ID, and verify signatures with working Node.js, Python, and curl examples.",
    keywords: ["callback", "hmac", "signature", "webhook", "raw body", "delivery", "retries"],
  },
  {
    slug: "idempotency",
    title: "Idempotency",
    summary: "Retry after a timeout without generating twice or paying twice.",
    keywords: ["idempotency-key", "retry", "duplicate", "duplicate holds", "logical generation"],
  },
  {
    slug: "quotes-and-compatibility",
    title: "Quotes and protocol compatibility",
    summary:
      "Get the exact price of a request before paying, submit it at that price, recover from a lost response, and know how the text and video compatibility APIs are priced.",
    keywords: [
      "quote",
      "quoteTask",
      "estimatedCost",
      "maxCharge",
      "40901",
      "price drift",
      "openai",
      "responses",
      "chat completions",
      "video projection",
    ],
  },
  {
    slug: "text-and-streaming",
    title: "Text and streaming",
    summary:
      "Call text models in the official OpenAI, Anthropic or Google Gemini format, and handle conversations, tools, streams and costs correctly.",
    keywords: [
      "text",
      "chat",
      "llm",
      "streaming",
      "sse",
      "tokens",
      "messages",
      "vision",
      "image input",
      "video input",
      "audio input",
      "multimodal",
      "keep-alive",
    ],
  },
  {
    slug: "chat-recipes",
    title: "Chat recipes",
    summary:
      "Complete, runnable programs for multi-turn conversations, character role-play, streaming into your own interface and tool calling, in Python, Node.js and curl.",
    keywords: [
      "chat",
      "role-play",
      "roleplay",
      "character",
      "multi-turn",
      "conversation history",
      "tool calling",
      "examples",
    ],
  },
  {
    slug: "migrate-from-openai",
    title: "Migrate from OpenAI or OpenRouter",
    summary:
      "Point existing OpenAI-library code at SpicyAPI. What changes (base URL, key, model ID), which request fields behave differently, and what to remove when you come from OpenRouter.",
    keywords: ["openai", "openrouter", "migrate", "migration", "switch", "base url", "drop-in"],
  },
  {
    slug: "agents",
    title: "Agents and automation",
    summary:
      "Which official tool to use, and a production runbook for AI agents, backend workers and repeatable media pipelines.",
    keywords: ["agent", "mcp", "sdk", "cli", "tool", "packages", "runbook"],
  },
  {
    slug: "guide-image-to-video",
    title: "Tutorial: turn a picture into a video",
    summary:
      "Start from one picture on your computer and finish with a downloaded video file. Every step shows the CLI, the TypeScript SDK and plain HTTP.",
    keywords: ["image to video", "image-to-video", "animate a photo", "walkthrough"],
  },
  {
    slug: "guide-image-generation",
    title: "Guide: generating and editing images",
    summary:
      "How the image endpoints behave as a class — the two request shapes, the three ways output size is spelled, what a reference picture adds to the bill, adapter weights, and how to read a rejection.",
    keywords: [
      "text to image",
      "image editing",
      "reference image",
      "aspect ratio",
      "resolution",
      "lora",
      "adapter weights",
    ],
  },
  {
    slug: "subject-swap",
    title: "Subject swap",
    summary:
      "One toolkit, two shapes. Single-call models replace a face or a head in one request; two-call models analyse a clip first so you can choose which person changes.",
    keywords: [
      "face swap",
      "head swap",
      "character swap",
      "subject swap",
      "toolkit",
      "video-analyze",
      "replace a person",
      "two step",
    ],
  },
  {
    slug: "production-integration",
    title: "Production integration",
    summary:
      "A launch checklist for a recoverable integration — the right model, protected keys and balance, confirmed costs, durable task tracking, reliable callbacks and the tests to run before going live.",
    keywords: ["production", "checklist", "go live", "monitoring", "reconciliation"],
  },
  {
    slug: "billing",
    title: "Billing",
    summary:
      "Priced in US dollars. Funds are held when a task is accepted, settled on success and returned in full on failure — plus adding funds, spend caps, balance history and invoices.",
    keywords: [
      "cost",
      "credit",
      "balance",
      "payment",
      "billing",
      "holds",
      "settlement",
      "refunds",
      "spend cap",
    ],
  },
  {
    slug: "console-workspaces",
    title: "Console and teams",
    summary:
      "What every page of the SpicyAPI console does and when to use it, and how teams share API keys and spend limits while the team owner pays.",
    keywords: ["console", "workspace", "team", "members", "budget"],
  },
  {
    slug: "retention",
    title: "Retention and destruction",
    summary:
      "What the platform caps are, how far down you can dial them, what shortening a setting does to content you already have, how to destroy a task's content, and what we cannot promise.",
    keywords: [
      "privacy",
      "delete",
      "storage",
      "retention",
      "per-request retention",
      "purge",
      "destroy",
    ],
  },
  {
    slug: "api-reference",
    title: "OpenAPI and endpoint index",
    summary:
      "Downloadable OpenAPI 3.1 contract, every public endpoint with the guide that explains it, the shared request headers, and the production origin.",
    keywords: ["openapi", "endpoint", "reference", "api reference", "envelope"],
  },
  {
    slug: "errors",
    title: "Errors",
    summary:
      "Every business code, its HTTP status, what to do about it, and which retries are worth making.",
    keywords: [
      "code",
      "request_id",
      "correlation",
      "429",
      "503",
      "unavailable",
      "service unavailable",
      "no route",
      "customer price",
    ],
  },
  {
    slug: "limits",
    title: "Rate limits",
    summary:
      "How the read and write request buckets work, what draws from each, the other limits you can run into, and why concurrency is a separate question.",
    keywords: ["rate", "quota", "retry-after", "throttling", "backoff", "concurrency"],
  },
  {
    slug: "schema",
    title: "Spicy Schema contract",
    summary:
      "The shared request envelope, canonical fields, form schema, async lifecycle, errors, result storage and compatibility rules.",
    keywords: ["spicy schema", "canonical fields", "lifecycle"],
  },
  {
    slug: "task-actions",
    title: "Task commitment and retry",
    summary:
      "Why an accepted generation task cannot be canceled, and how failed or expired tasks are retried safely.",
    keywords: ["retry", "cancel", "unsupported actions", "commitment"],
  },
  {
    slug: "troubleshooting",
    title: "Troubleshooting and recovery",
    summary:
      "Find your symptom, see why it happens and what to do — payments, 401 and 403, balance and limits, unavailable models, failed or stuck tasks, uploads, callbacks and streams.",
    keywords: ["troubleshooting", "debug", "recover", "stuck", "pending"],
  },
  {
    slug: "faq",
    title: "FAQ",
    summary:
      "Short answers to the questions people ask most about SpicyAPI, from free tiers and failed-task charges to cancelling tasks, keeping results and fixing common errors.",
    keywords: ["faq", "frequently asked questions"],
  },
  {
    slug: "glossary",
    title: "Glossary",
    summary:
      "Every term these docs use, from API key to webhook, explained in plain words with what it means in SpicyAPI and where to read more.",
    keywords: ["glossary", "terminology", "definitions"],
  },
  {
    slug: "policy",
    title: "Content and usage responsibility",
    summary:
      "What SpicyAPI checks and what it doesn't, what you are responsible for, which uses are never allowed, where the service is available, and how to report abuse.",
    keywords: [
      "model capabilities",
      "content review",
      "content",
      "policy",
      "caller responsibility",
    ],
  },
];

export const DOCUMENTATION: DocumentationEntry[] = definitions.map((entry) => ({
  ...entry,
  url: entry.slug ? `${DOCS_BASE_URL}/${entry.slug}` : DOCS_BASE_URL,
}));

const SEARCH_STOP_WORDS = new Set([
  "a",
  "about",
  "across",
  "after",
  "an",
  "and",
  "are",
  "as",
  "at",
  "before",
  "by",
  "for",
  "from",
  "how",
  "in",
  "into",
  "is",
  "it",
  "of",
  "on",
  "or",
  "the",
  "to",
  "using",
  "what",
  "when",
  "where",
  "which",
  "who",
  "why",
  "with",
  "without",
]);

function normalizeSearchText(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

export function searchDocumentation(query = "", limit = 10): DocumentationEntry[] {
  if (!Number.isInteger(limit) || limit < 1 || limit > 25) {
    throw new TypeError("limit must be an integer between 1 and 25");
  }
  const normalizedQuery = normalizeSearchText(query);
  const allTerms = normalizedQuery.split(/\s+/).filter(Boolean);
  const meaningfulTerms = allTerms.filter((term) => !SEARCH_STOP_WORDS.has(term));
  const terms = meaningfulTerms.length > 0 ? meaningfulTerms : allTerms;
  if (terms.length === 0) return DOCUMENTATION.slice(0, limit);

  return DOCUMENTATION.map((entry, index) => {
    const title = normalizeSearchText(entry.title);
    const slug = normalizeSearchText(entry.slug);
    const summary = normalizeSearchText(entry.summary);
    const keywords = normalizeSearchText(entry.keywords.join(" "));
    const haystack = `${title} ${slug} ${summary} ${keywords}`;
    const matched = terms.filter((term) => haystack.includes(term));
    const score = matched.reduce(
      (total, term) =>
        total +
        (title.includes(term) ? 8 : 0) +
        (slug.includes(term) ? 6 : 0) +
        (keywords.includes(term) ? 4 : 0) +
        (summary.includes(term) ? 2 : 0) +
        1,
      haystack.includes(normalizedQuery) ? 20 : 0,
    );
    return { entry, index, matched: matched.length, score };
  })
    .filter((candidate) => candidate.matched > 0)
    .sort(
      (left, right) =>
        right.matched - left.matched || right.score - left.score || left.index - right.index,
    )
    .slice(0, limit)
    .map((candidate) => candidate.entry);
}
