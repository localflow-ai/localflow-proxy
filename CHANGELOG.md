# Changelog

All notable changes to the LocalFlow Proxy are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project aims to follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

Pre-1.0.0 baseline — not yet tagged.

### Added
- **Rate-limit reset info on 429** — when a public session exceeds its per-IP daily cap, the `429` now carries when it resets: a `Retry-After` header (seconds), a `resetAt` field (epoch ms), and the same instant embedded in the `error` message (for clients that surface only that field). The instant is timezone-agnostic, so the client renders it in the user's local time ("come back after …") instead of a vague "tomorrow". Window semantics are unchanged (fixed 24h from the first request of the window).
- **`apiKeyLast4` on LLM admin responses** — `GET`/`POST`/`PUT /admin/llm-config` now include a display-only `apiKeyLast4` (last 4 chars of the configured key) alongside the masked `apiKey: "***"`, so an admin can tell which key is set when several exist (shown in the console LLMs page). LLM server keys only — `api-config` keys are encrypted at rest, so their last 4 would be meaningless ciphertext. Never persisted (stripped on write); `"***"` stays the keep-existing sentinel on `PUT`.
- **Configurable PDF-extraction interpreter** — `config.json.pythonBin` (or the `PYTHON_BIN` env var) selects the Python that runs `scripts/extract_pdf.py`, defaulting to `python3`. Lets a proxy point at a modern Python/venv whose `pdfplumber` supports `x_tolerance_ratio` instead of a stale system `python3` (which fails with `x_tolerance_ratio is not a valid WordExtractor parameter`). Server-side only — not exposed via `PUT /admin/config`.
- **Per-proxy admin token** — `config.json` now carries `adminToken`, resolved per request from the proxy's own config (so each tenant under the shared router has its own admin credential). The `ADMIN_TOKEN` env var is kept as a legacy fallback. The token is masked to `"***"` in `GET /admin/config`, and an omitted/`"***"` value on `PUT /admin/config` keeps the existing one. Needed because the version router runs all proxies in one process, where a single `process.env.ADMIN_TOKEN` would be shared across tenants.
- **Admin global-config API** — `PUT /admin/config` updates `config.json` from an admin session (validated, merged into the existing config, hot-reloaded immediately). Manages `adminToken`, `allowedOrigins`, `allowPublicSessions`, `safeMode`, `sessionTtlMs` and the per-IP `publicSessionLimiterConfiguration`. Surfaced as a **Settings** page in the console.
- **Authorization / permissions** — a hot-reloaded `permissions.json` (`public` / `authenticated` / reserved `groups` / per-user layers, deny-by-default), `GET /permissions` returning the resolved effective set for the session, and server-side enforcement of capabilities/limits/allow-lists on `/common/genai` (`ai.use`, `ai.attachImage`/`ai.attachFile`, `ai.byok`, `models`, `maxPromptChars`), `/common/extract-pdf` (`pdf.extract`, `maxUploadBytes`), `/common/api-proxy` (`api.use`, `apis`), and CRM `/data`·`/metadata`·`/attachments` (`crm.read`). No `permissions.json` ⇒ legacy (unrestricted); a present-but-broken file fails closed. Admin sessions bypass. Full model in [docs/permissions.md](docs/permissions.md).
- **Admin permissions API** — `GET` / `PUT` / `DELETE /admin/permissions` to read, replace (validated) and remove the `permissions.json` document from an admin session; changes apply immediately (surfaced as a Permissions page in the console).
- **Admin LLM-config API** — `GET` / `POST` / `PUT` / `DELETE /admin/llm-config` to manage `llm-configs.json` (the models the assistant picks by `modelId`), validated, with single-default enforcement. Preset `apiKey`s are masked to `"***"` in responses (never returned raw) and an omitted/`"***"` key on `PUT` keeps the existing one; `/admin/api-config` now masks keys the same way. Surfaced as an LLMs page in the console.

### Changed
- `maxPromptChars` on `/common/genai` now bounds **the latest user message only**, not the whole payload. Counting the entire conversation (history, the model's prior formulas, machine-generated execution traces, system prompt) shrank the allowance every turn and `413`'d normal follow-ups — notably PDF analyses, whose system prompt carries the document text. Messages may also carry a `context` string (machine-generated preamble, e.g. an execution trace): the proxy prepends it to the message content when forwarding to the provider but never counts it toward the limit.
- PDF extraction: a detected table that under-segments its content (the words form many more columns than the ruling lines found — e.g. a holdings table detected as a 2-column currency+value strip, with names/quantities outside the cells) now falls back to word-based extraction instead of dropping the unmatched text. Recovers holdings previously lost from complex multi-column statements; verified strictly additive (no tokens lost) on the affected reports and byte-identical on the others via the baseline snapshots.
- PDF extraction (word-based path): columns are now assigned by whole gap-group rather than per word, so a wide value that straddles two data-row columns — e.g. a portfolio total `8 629 202,44` — stays in one cell instead of being split into `8 629 | 202,44`. Data rows are unaffected.
- Per-IP daily quotas reimplemented with a plain `Map` (`_quotas` / `_consumeQuota`), replacing Bottleneck.Group. The previous implementation silently reset quotas: Bottleneck deletes idle limiters, and since the code only called `currentReservoir()` / `incrementReservoir()` without scheduling jobs, every limiter was always "idle" and got recreated with a full reservoir after a few minutes. Limits are now read from config on each request, so admin changes apply to live counters immediately.
- Client IP resolution honours `X-Forwarded-For` (first hop) before falling back to `req.ip`, so per-IP limits work behind a reverse proxy.
- **Config: `allPublicSessions` renamed to `allowPublicSessions`** (it's a switch, not a set). The old key is still read as a fallback, and writing the new key via `PUT /admin/config` normalises it away — existing `config.json` files keep working.
- **Removed the unenforced `genaiPerDay` / `apiPerDay` permission limits.** They were config the proxy never read; daily rate-limiting is the per-IP `publicSessionLimiterConfiguration` only. `permissions.json` limits are now `maxPromptChars` / `maxUploadBytes` (per-request) — a saved doc still carrying the old keys is rejected by `PUT /admin/permissions` (drop them). Clarified the two-file model (global config vs per-identity permissions) in the README.

### Security
- Removed the dead `/external-signup` endpoint, which contained hardcoded Odoo credentials; the leaked password was also scrubbed from git history.
- Salesforce access tokens are now masked (last 4 chars) in debug logs instead of printed in full.

### Added
- **`/common/genai` accepts attachments** — each `messages[]` entry may carry `attachments: [{ name, mimeType, data }]` (base64, no `data:` prefix). The proxy maps them into each provider's multimodal format (Gemini `inline_data`, OpenAI `image_url`/`file`, Anthropic `image`/`document`). Enables file-aware chat in `localflow-assistant`.
- **Safe mode** — set `"safeMode": true` in `config.json` to forbid the proxy from ever forwarding file contents to the LLM: any `/common/genai` request carrying attachments is rejected with HTTP 403, and `GET /public/config` reports `safeMode` so clients can hide the "send to AI" option. A proxy-level policy users cannot override.
- **Multi-LLM bridge** — Gemini, OpenAI (and OpenAI-compatible endpoints), and Anthropic; protocol/model/key resolved server-side from `llm-configs.json` by `modelId`. BYOK keys take precedence over server keys.
- **Hot-reloadable `config.json`** — rate limits, public-session toggle, CORS origins, and session TTL reload on file change with no restart.
- **Per-session-type built-in key resolution** in `llm-configs.json` (`{ "public": "…" }`, `{ "*": "…" }`, `{ "!public": "…" }`).
- **Public (anonymous) sessions** with per-IP daily quotas; `GET /public/config` exposes the limits without auth.
- **PDF text extraction** via Python/pdfplumber — layout-preserving, with keyword-based page filtering.
- **CRM/ERP connectors** — Odoo (XML-RPC) and Salesforce (jsforce, including Canvas signed-request login).
- **Security model** — AES-256-GCM encryption with per-org key derivation from a single master key; token-based sessions with sliding TTL; admin endpoints behind `ADMIN_TOKEN`.
- **Production process management** via PM2 (`prod:*` npm scripts).

[Unreleased]: https://github.com/localflow-ai/localflow-proxy/commits/main
