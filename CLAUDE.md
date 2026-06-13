# localflow-proxy

Node/Express gateway for metadata-first AI apps: LLM bridge, API governance, CRM/ERP connectors, PDF extraction, per-IP rate limiting. Part of the multi-repo `localflow/` workspace (sibling repos: core, app, console, examples). The API and config formats are documented in `README.md` — keep it current when they change.

## Gotchas (non-obvious, easy to get wrong)
- **`api-config.json` is auto-generated — never hand-edit it.** Edit `scripts/build-api-config.js`, then run `node scripts/build-api-config.js`. On the server, regenerate after pulling.
- **Per-IP daily quotas use a plain `Map`, not Bottleneck** (`_quotas` / `_consumeQuota` in `routes.js`). Bottleneck.Group silently reset quotas by deleting idle limiters. Don't reintroduce it for quota counting; it's fine for the PDF throttle (`limiter`) which uses scheduled jobs.
- **Mask secrets in logs.** Tokens/keys must go through the `mask()` helper (last-4 only) before any `logger.*` call. Never log a full access token, API key, or password.
- **Config hot-reloads.** `config.json`, `llm-configs.json`, `api-config.json` reload on file change (mtime) with no restart — limit/key changes apply to live state immediately.

## Conventions
- Proxy URL: `https://backoffice.daquota.io/<proxyname>`; default proxy is `demo`. `/v1` is deprecated — don't use it.
- Node.js 20+.
- Keep `CHANGELOG.md` / `ROADMAP.md` current: add a CHANGELOG entry under `[Unreleased]` for any change to the public surface (endpoints, config shape, connectors); move a ROADMAP item to the CHANGELOG when it ships.

## Run
- Dev: `npm run dev` (nodemon). Prod: `npm run prod:start` (pm2; see `prod:*` scripts).
- Requires `MASTER_ENCRYPTION_KEY` in `.env.local`; `ADMIN_TOKEN` enables admin endpoints.
- PDF extraction needs Python 3 + `pdfplumber`.
