# Changelog

All notable changes to the LocalFlow Proxy are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project aims to follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

Pre-1.0.0 baseline — not yet tagged.

### Changed
- PDF extraction (word-based path): columns are now assigned by whole gap-group rather than per word, so a wide value that straddles two data-row columns — e.g. a portfolio total `8 629 202,44` — stays in one cell instead of being split into `8 629 | 202,44`. Data rows are unaffected.
- Per-IP daily quotas reimplemented with a plain `Map` (`_quotas` / `_consumeQuota`), replacing Bottleneck.Group. The previous implementation silently reset quotas: Bottleneck deletes idle limiters, and since the code only called `currentReservoir()` / `incrementReservoir()` without scheduling jobs, every limiter was always "idle" and got recreated with a full reservoir after a few minutes. Limits are now read from config on each request, so admin changes apply to live counters immediately.
- Client IP resolution honours `X-Forwarded-For` (first hop) before falling back to `req.ip`, so per-IP limits work behind a reverse proxy.

### Security
- Removed the dead `/external-signup` endpoint, which contained hardcoded Odoo credentials; the leaked password was also scrubbed from git history.
- Salesforce access tokens are now masked (last 4 chars) in debug logs instead of printed in full.

### Added
- **Multi-LLM bridge** — Gemini, OpenAI (and OpenAI-compatible endpoints), and Anthropic; protocol/model/key resolved server-side from `llm-configs.json` by `modelId`. BYOK keys take precedence over server keys.
- **Hot-reloadable `config.json`** — rate limits, public-session toggle, CORS origins, and session TTL reload on file change with no restart.
- **Per-session-type built-in key resolution** in `llm-configs.json` (`{ "public": "…" }`, `{ "*": "…" }`, `{ "!public": "…" }`).
- **Public (anonymous) sessions** with per-IP daily quotas; `GET /public/config` exposes the limits without auth.
- **PDF text extraction** via Python/pdfplumber — layout-preserving, with keyword-based page filtering.
- **CRM/ERP connectors** — Odoo (XML-RPC) and Salesforce (jsforce, including Canvas signed-request login).
- **Security model** — AES-256-GCM encryption with per-org key derivation from a single master key; token-based sessions with sliding TTL; admin endpoints behind `ADMIN_TOKEN`.
- **Production process management** via PM2 (`prod:*` npm scripts).

[Unreleased]: https://github.com/localflow-ai/localflow-proxy/commits/main
