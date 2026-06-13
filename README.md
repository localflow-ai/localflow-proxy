# LocalFlow Proxy

> **Apache 2.0 License** — See [LICENSE](#license) at the bottom of this file.

The LocalFlow Proxy is an edge or cloud service that bridges how [localflow-core](https://github.com/localflow-ai/localflow-core) accesses external data and APIs. It adds CRM/ERP connections, governed external API access, server-side edge services, and full data-flow auditability. When deployed, it becomes the single point of control for a zero-trust data boundary: every outbound call from the AI sandbox is explicitly whitelisted, authenticated, and audited — nothing leaves your network without authorization.

It serves five key purposes:

- **CRM / ERP connectors** — authenticate users against Odoo, Salesforce, or any custom backend; manage session tokens and their lifecycle
- **API governance** — define which external APIs AI formulas may call; supports BYOK (bring your own key), per-source throttling, URL whitelisting, and OAuth 2.0 token exchange
- **Server-side edge services** — PDF text extraction, OCR, and other tasks that benefit from server-side execution; delivers higher quality than in-browser alternatives and keeps heavy computation off the client
- **LLM bridge** — relay LLM requests through the proxy so API keys are decrypted server-side and never exposed in the browser; required when keys must not leave your network
- **Data flow monitoring** — track and audit what data enters and leaves the AI sandbox, giving operators visibility over the information boundary between the browser and external services

**Related repositories:**
- [localflow-core](https://github.com/localflow-ai/localflow-core) — the client-side metadata-first AI library
- [localflow-examples](https://github.com/localflow-ai/localflow-examples) — React and vanilla JS examples

---

## Table of contents

1. [Architecture](#architecture)
2. [Getting started](#getting-started)
3. [Configuration](#configuration)
4. [API reference](#api-reference)
5. [Connectors](#connectors)
6. [Contributing](#contributing)
7. [Roadmap & changelog](#roadmap--changelog)
8. [License](#license)

---

## Architecture

```
Browser (metadata-first AI app)
        │
        │  HTTPS — session token in Authorization header
        ▼
LocalFlow Proxy                 ← this repository
        │
        ├── /common/genai  ──────► LLM (Gemini or other)        [LLM bridge]
        ├── /common/api-proxy ───► Whitelisted external APIs     [API governance]
        ├── /common/extract-pdf ► PDF extraction (pdfplumber)    [Edge services]
        ├── /common/access-stats  Data flow tracking             [Monitoring]
        ├── /session             Auth + session management       [Security]
        ├── /metadata            CRM/ERP object metadata         [Connectors]
        └── /data                CRM/ERP CRUD operations         [Connectors]
```

All secrets — LLM keys, CRM credentials, master encryption key — live exclusively on the proxy. The browser never sees them. LLM API keys entered by users are encrypted with AES-256-GCM using a per-organisation derived key before being stored client-side, and are decrypted only inside the proxy at request time.

### Technical highlights

- Token-based sessions with configurable sliding TTL (default 24 h) and up to 1 000 concurrent sessions
- AES-256-GCM encryption with per-org key derivation from a single master key
- Multi-LLM bridge: Gemini, OpenAI (and compatible), Anthropic — protocol resolved server-side by `modelId`
- Per-session-type built-in key scoping in `llm-configs.json` (e.g. demo key for public sessions only)
- Hot-reloadable configuration: `config.json`, `llm-configs.json`, `api-config.json` — all reload on file change with no restart
- API-key injection via query param, header, request body, or route placeholder
- OAuth 2.0 client-credentials token exchange for third-party APIs
- URL rewrite rules applied before forwarding
- Per-source throttling and per-IP daily quotas on public sessions, configurable via `config.json` (limit changes apply immediately to existing counters)
- Layout-preserving PDF extraction via Python/pdfplumber with keyword-based page filtering
- Session-scoped bidirectional field and object-type aliases (connector field mapping)

---

## Getting started

### Prerequisites

- Node.js 20+ (ARM-native build on Apple Silicon — install via nvm: `nvm install 20`)
- npm 9+
- Python 3 with `pdfplumber` installed — required for PDF extraction:
  ```bash
  pip3 install pdfplumber
  ```
- A 32-byte (256-bit) master encryption key

### 1. Clone and install

```bash
git clone https://github.com/localflow-ai/localflow-proxy.git
cd localflow-proxy
npm install
```

### 2. Generate a master encryption key

```bash
openssl rand -hex 32
```

Keep this value secret. All encrypted data (LLM keys, BYOK API keys) is derived from it. Losing the key means all stored encrypted values become unreadable.

### 3. Configure the environment

Create a `.env` file in the project root for shared/committed settings and a `.env.local` file for secrets that should never be committed. `.env.local` is loaded last and overrides any value in `.env`.

Minimal `.env.local`:

```env
MASTER_ENCRYPTION_KEY=your_64_character_hex_string_here
ADMIN_TOKEN=your_secret_admin_token_here
```

See [Configuration](#configuration) for all options.

### 4. Run

```bash
# Development — auto-restarts on file change, stop with Ctrl+C
npm run dev

# Production — managed by PM2 (survives terminal close, auto-restarts on crash)
npm run prod:start    # start
npm run prod:stop     # stop
npm run prod:restart  # restart
npm run prod:logs     # tail logs
npm run prod:status   # show process status
```

The server starts on `http://localhost:3000` by default. Override with `PORT=3001` in `.env.local`.

---

## Configuration

### Environment variables

The proxy loads `.env` first, then `.env.local` (which overrides any duplicate keys). Both files are optional but at minimum `MASTER_ENCRYPTION_KEY` must be set. Add `.env.local` to `.gitignore` to keep secrets out of version control.

| Variable | Required | Description |
|----------|----------|-------------|
| `MASTER_ENCRYPTION_KEY` | **Yes** | 64-character hex string (32 bytes). Used to derive per-org AES-256-GCM encryption keys. Generate with `openssl rand -hex 32`. |
| `ADMIN_TOKEN` | No | Secret token that enables the `POST /admin/session` endpoint. When set, a client can authenticate as an admin by sending `Authorization: Bearer <ADMIN_TOKEN>` to that endpoint and receives a session token with full admin privileges. If unset, the endpoint returns `503`. |
| `API_CONFIG_FILE` | No | Path to the API descriptors JSON file. Defaults to `./api-config.json`. The file is hot-reloaded whenever it changes on disk. |
| `PORT` | No | HTTP port. Defaults to `3000`. |

### Proxy config file (`config.json`)

`config.json` controls runtime behaviour of the proxy. It is hot-reloaded on every request when the file changes on disk — no restart required.

```json
{
  "allowedOrigins": "*",
  "sessionTtlMs": 86400000,
  "allPublicSessions": true,
  "publicSessionLimiterConfiguration": {
    "genaiPerIpPerDay": 40,
    "apiPerIpPerDay": 5000
  }
}
```

| Field | Default | Description |
|-------|---------|-------------|
| `allowedOrigins` | `"*"` | CORS allowed origins. `"*"` allows all. Use a string or array of strings to restrict. |
| `sessionTtlMs` | `86400000` | Session idle timeout in milliseconds (default 24 h). |
| `allPublicSessions` | `true` | Set to `false` to disable all unauthenticated (public) sessions without a restart. |
| `publicSessionLimiterConfiguration.genaiPerIpPerDay` | `40` | Max AI (genai) requests per IP per day for public sessions. |
| `publicSessionLimiterConfiguration.apiPerIpPerDay` | `5000` | Max API proxy requests per IP per day for public sessions. |

### LLM config file (`llm-configs.json`)

`llm-configs.json` defines the available LLM models. It is also hot-reloaded on change.

```json
[
  {
    "id": "gemini-flash",
    "displayName": "Gemini 3 Flash",
    "protocol": "gemini",
    "model": "gemini-3-flash-preview",
    "apiKey": { "public": "AIza..." },
    "isDefault": true
  },
  {
    "id": "gpt-4o",
    "displayName": "GPT-4o",
    "protocol": "openai",
    "model": "gpt-4o",
    "apiKey": ""
  },
  {
    "id": "claude-sonnet",
    "displayName": "Claude Sonnet 4.6",
    "protocol": "anthropic",
    "model": "claude-sonnet-4-6",
    "apiKey": ""
  }
]
```

| Field | Description |
|-------|-------------|
| `id` | Unique identifier used by clients as `modelId`. |
| `displayName` | Label shown in the UI. |
| `protocol` | `"gemini"`, `"openai"`, or `"anthropic"`. |
| `model` | Provider model name forwarded in the API call. |
| `baseUrl` | (OpenAI-compatible only) Override the API base URL, e.g. for MIMO or other compatible providers. |
| `apiKey` | Server-side key. String form (`"key"`) applies to all sessions. Object form enables per-session-type control (see below). |
| `isDefault` | If `true`, clients use this model when none is specified. |

**Per-session-type key scoping (`apiKey` object form):**

| Form | Meaning |
|------|---------|
| `"AIza..."` | Built-in key available to all session types (legacy / shorthand) |
| `{ "*": "AIza..." }` | Same as string form — explicit wildcard |
| `{ "public": "AIza..." }` | Built-in key only for public (anonymous) sessions; other sessions must BYOK |
| `{ "!public": "AIza..." }` | Built-in key for all session types *except* public |
| `""` or `{}` | No built-in key — all sessions must BYOK |

BYOK (an encrypted key sent by the client) always takes precedence over the server-side key.

### API descriptor file (`api-config.json`)

The `api-config.json` file defines which external APIs analysis formulas are allowed to call through the `/common/api-proxy` endpoint. **Do not edit `api-config.json` directly** — it is auto-generated. Edit `scripts/build-api-config.js` instead, then run:

```bash
node scripts/build-api-config.js
```

Each descriptor is a JSON object with the following fields:

| Field | Type | Description |
|-------|------|-------------|
| `id` | `string` | Unique identifier for the API. |
| `name` | `string` | Display name shown in the UI. |
| `topic` | `string` | Category (e.g. `"geo"`, `"finance"`). |
| `description` | `string` | Short description shown in the UI. |
| `baseUrl` | `string \| string[]` | Allowed base URL prefix(es). Requests to any other URL are rejected with 403. |
| `force` | `boolean` | If `true`, the API is always activated (cannot be disabled by the user). |
| `prepaid` | `boolean` | If `true`, the proxy supplies its own API key (no BYOK). |
| `apiKey` | `string` | Server-side API key injected by the proxy (never sent to the browser). |
| `apiKeyHeader` | `string` | HTTP header name to inject the API key into (e.g. `"Authorization"`). |
| `apiKeyQueryParam` | `string` | Query parameter name to inject the API key into. |
| `apiKeyQueryParamGetOnly` | `string` | Same as `apiKeyQueryParam` but only for GET requests. |
| `apiKeyBodyParam` | `string` | JSON body field name to inject the API key into. |
| `apiKeyRoutePlaceholder` | `string` | Placeholder in the URL path to replace with the API key. |
| `oAuth2TokenUrl` | `string` | If set, fetch a Bearer token from this URL before forwarding (client-credentials flow). |
| `rewriteRules` | `array` | URL rewrite rules applied before forwarding. Each rule-set is a flat array of `[action, search, replace, ...]` triples. Only `"replace"` is supported. |
| `waitMs` | `number` | Minimum milliseconds between consecutive requests to this API (global throttle). |
| `requiredUserAgent` | `string` | Override the `User-Agent` header sent to the API. |
| `requiredReferer` | `string` | Set the `Referer` header sent to the API. |
| `requiredOrigin` | `string` | Set the `Origin` header sent to the API. |
| `prompt` | `string` | Hint injected into the LLM system prompt when this API is activated. |

---

## API reference

Most endpoints require a `Bearer <token>` in the `Authorization` header (or `X-Proxy-Token` for `/common/api-proxy`). Tokens are obtained from `POST /session`. The endpoints `GET /public/config` and `POST /session` require no token.

### Authentication

#### `POST /session`

Create a new session by authenticating against a CRM/ERP connector.

**Request body:**

```json
{ "type": "odoo", "config": { "url": "...", "db": "...", "username": "...", "password": "..." } }
{ "type": "salesforce", "config": { "url": "...", "username": "...", "password": "...", "token": "..." } }
{ "type": "public", "config": {} }
```

**Response:** `{ "token": "<session-token>" }`

---

#### `GET /session`

Verify the current session and retrieve context (user info, permissions, connector configuration).

---

### Field and type mapping

These endpoints configure session-scoped aliases. The client can define its own field and object-type names; the proxy translates them transparently on every subsequent request.

| Endpoint | Description |
|----------|-------------|
| `POST /session/field-mapping` | Set global field aliases (apply to all object types). Body: `{ "myField": "backendField", ... }` |
| `POST /session/field-mapping/:objectType` | Set field aliases for a specific object type. |
| `POST /session/object-type-mapping` | Set object-type aliases. Body: `{ "myType": "backend_type", ... }` |

---

### CRM / ERP data

| Endpoint | Description |
|----------|-------------|
| `GET /metadata` | List all available object types. |
| `GET /metadata/:objectType` | Get full field metadata for an object type. |
| `GET /metadata/object-type/:id` | Resolve an object type by record ID. |
| `GET /data/:objectType` | Fetch records. Query params: `fields` (comma-separated), `limit`, `order` (JSON), `where` (JSON). |
| `GET /data/:objectType/:id` | Fetch a single record by ID. |
| `POST /data/:objectType` | Create a record. |
| `PUT /data/:objectType/:id` | Update a record. |
| `DELETE /data/:objectType/:id` | Delete a record. |
| `GET /attachments/:objectType/:id` | List attachments. Query param: `mimeTypePrefix`. |

---

### Common services

#### `GET /public/config`

Returns public-facing proxy configuration — no token required. Intended for demo apps that display rate limit information before the user logs in.

```json
{
  "publicSessions": {
    "enabled": true,
    "rateLimits": { "genaiPerIpPerDay": 10, "apiPerIpPerDay": 5000 }
  }
}
```

---

#### `GET /common/llm-configs`

Returns the list of configured LLM models (API keys are never included).

```json
[
  { "id": "gemini-flash", "displayName": "Gemini 3 Flash", "protocol": "gemini", "model": "gemini-3-flash-preview", "isDefault": true },
  ...
]
```

---

#### `POST /common/genai`

Forward a prompt to an LLM. The proxy resolves the model, protocol, and API key from `llm-configs.json` by `modelId`. BYOK (`apiKey`) takes precedence over the server-configured key.

```json
{
  "modelId": "gemini-flash",
  "system": "You are a helpful assistant.",
  "messages": [{ "role": "user", "content": "Hello" }],
  "apiKey": "<optional encrypted BYOK key>",
  "options": { "temperature": 0.5, "thinking": false, "json": false }
}
```

**Response:**
```json
{ "text": "...", "thoughts": "..." }
```

Supported protocols: `gemini`, `openai` (and OpenAI-compatible endpoints), `anthropic`.

---

#### `ALL /common/api-proxy`

Proxy any request to an external API that appears in `api-config.json`. The target URL is passed as a `?url=` query parameter. Requests to unlisted URLs are rejected with 403.

Header: `X-Proxy-Token: Bearer <token>`  
Optional: `X-Proxy-API-Key: <encrypted BYOK key>` (decrypted by the proxy before forwarding)

---

#### `POST /common/extract-pdf`

Extract text from a PDF, with optional keyword-based page filtering.

**Binary upload:**
```
Content-Type: application/pdf
Body: <raw PDF bytes>
?searchString=invoice,total   (optional, comma-separated)
```

**URL-based:**
```json
{ "url": "https://...", "searchString": "invoice,total" }
```

**Response:**
```json
{
  "success": true,
  "metadata": { ... },
  "returnedPages": 3,
  "content": "## Page 2\n\n..."
}
```

When `searchString` is provided, only matching pages (± one page of context) are returned. Non-adjacent sections are separated by an `[Omitted Content]` marker.

---

#### `POST /common/encrypt` / `POST /common/decrypt`

Encrypt or decrypt a string using the session's org-derived key.

```json
{ "message": "plain text or cipher text" }
```

Response: `{ "encrypted": "..." }` / `{ "decrypted": "..." }`

---

#### `GET /common/api-config`

Return the list of available external API descriptors (API keys masked as `"***"`).

---

#### `GET /common/access-stats`

Return access tracking statistics for the current session user or org.

Query params: `scope` (`"default"` or `"org"`), `resource`, `read` (`"true"/"false"`), `weight`.

---

### Admin endpoints

All admin endpoints require an admin session token (obtained from `POST /admin/session` using `ADMIN_TOKEN`).

#### `POST /admin/session`

Authenticate as admin. Body: `{ "token": "<ADMIN_TOKEN>" }`. Returns `{ "token": "<session-token>" }`.

---

#### `GET /admin/config`

Returns the current live proxy config (from `config.json`).

---

#### `GET /admin/stats`

Returns uptime, session counts by type, event counts by kind, and current rate limit values.

---

#### `GET /admin/events`

Returns the last N events from the ring buffer. Query params: `limit` (max 500), `kind` (filter by event type).

---

#### `GET /admin/sessions`

Returns all active sessions (tokens truncated).

---

#### `GET /admin/api-config` / `POST /admin/api-config` / `PUT /admin/api-config/:id` / `DELETE /admin/api-config/:id`

Read and manage the API descriptor list (`api-config.json`).

---

## Connectors

A connector encapsulates the authentication and data-access logic for a specific environment (CRM, ERP, database, etc.). All connectors extend `BaseConnector`, which provides field/type mapping, normalization helpers, and bidirectional key translation.

### Built-in connectors

| Type | Class | Description |
|------|-------|-------------|
| `odoo` | `OdooConnector` | Odoo ERP via XML-RPC (`odoo-xmlrpc`). |
| `salesforce` | `SalesforceConnector` | Salesforce CRM via jsforce (user/password and OAuth 2.0). |
| `public` | `PublicConnector` | No-auth connector for evaluation sessions; returns empty/mocked data. |

### Writing a new connector

This section documents how to contribute a connector for a new environment (ERP, CRM, database, SaaS, etc.).

#### 1. Create `connectors/<name>.js`

Extend `BaseConnector` and implement the required methods. Only `login` and the read methods are mandatory; write operations are optional.

```js
const { BaseConnector } = require('../base-connector.js');
const { getLogger } = require('../logging');

const logger = getLogger('<name>-connector');

class MyConnector extends BaseConnector {

  constructor() {
    super();
    this.client = null;
  }

  // ── Required ────────────────────────────────────────────────────────────────

  /**
   * Authenticate against the backend and populate this.sessionInfo.
   * MUST set this.sessionInfo.orgId — it is used to derive the per-org
   * encryption key. Use a stable, unique identifier (e.g. tenant ID, DB name).
   */
  async login({ url, username, password, /* ...connector-specific fields */ }) {
    this.sessionInfo = { url, username, orgId: `myconnector-${username}` };
    this.client = await MySDK.connect({ url, username, password });
    logger.info('authenticated to MySystem at %s', url);
  }

  /**
   * Return session context: current user, permissions, and any connector
   * configuration hints the client needs (e.g. which field holds the user name).
   * Must return { context: { user, permissions, configuration } }.
   */
  async getSessionInfo() {
    const user = await this.client.getCurrentUser();
    return {
      ...this.sessionInfo,
      context: {
        user: { id: user.id, name: user.name, email: user.email, isAdmin: user.isAdmin },
        permissions: user.roles.map(r => ({ type: 'Role', id: r.id, name: r.name })),
        configuration: {
          userObject: 'users',
          userFields: ['id', 'name', 'email'],
          userNameField: 'email',
          idField: 'id'
        }
      }
    };
  }

  /**
   * Return a flat list of available object types (without field details).
   * Shape: [{ name: string, label?: string, queryable?: boolean, ... }]
   */
  async listObjectTypes() {
    const types = await this.client.getObjectTypes();
    return types.map(t => ({
      name: this.normalizeOutputObjectType(t.apiName),
      label: t.label,
      queryable: t.queryable
    }));
  }

  /**
   * Return metadata for a specific object type, including its fields.
   * Shape: { name: string, label?: string, fields: [{ name, label, type, ... }] }
   * Apply normalizeOutputObjectType / normalizeOutputKey so field/type aliases work.
   */
  async getObjectMetadata(objectType) {
    const backendType = this.normalizeInputObjectType(objectType);
    const meta = await this.client.describeObject(backendType);
    return {
      name: objectType,
      label: meta.label,
      fields: this.processFields(objectType, meta.fields.map(f => ({
        name: f.apiName,
        label: f.label,
        type: f.dataType
      })))
    };
  }

  /**
   * Fetch records for an object type.
   * options: { fields?: string[], limit?: number, order?: object, where?: object }
   * Apply normalizeInputObjectType / normalizeInputFieldNames before querying,
   * then normalizeOutputData on the result.
   */
  async getData(objectType, { fields, limit, order, where } = {}) {
    const backendType = this.normalizeInputObjectType(objectType);
    const backendFields = this.normalizeInputFieldNames(objectType, fields);
    const rows = await this.client.query(backendType, { fields: backendFields, limit, order, where });
    return this.normalizeOutputData(objectType, rows);
  }

  /**
   * Fetch a single record by ID.
   */
  async getRecordById(objectType, id, fields) {
    const backendType = this.normalizeInputObjectType(objectType);
    const backendFields = this.normalizeInputFieldNames(objectType, fields);
    const record = await this.client.getById(backendType, id, backendFields);
    return this.normalizeOutputData(objectType, record);
  }

  // ── Optional ─────────────────────────────────────────────────────────────────

  async createRecord(objectType, data) {
    const backendType = this.normalizeInputObjectType(objectType);
    const backendData = this.normalizeInputData(objectType, data);
    return this.client.create(backendType, backendData);
  }

  async updateData(objectType, id, data) {
    const backendType = this.normalizeInputObjectType(objectType);
    const backendData = this.normalizeInputData(objectType, data);
    return this.client.update(backendType, id, backendData);
  }

  async deleteData(objectType, id) {
    const backendType = this.normalizeInputObjectType(objectType);
    return this.client.delete(backendType, id);
  }

  async getObjectTypeFromId(id) {
    return this.client.getObjectTypeFromId(id);
  }

  async getAttachments(objectType, id, mimeTypePrefix) {
    return this.client.getAttachments(objectType, id, { mimeTypePrefix });
  }
}

module.exports = { MyConnector };
```

#### 2. Register the connector in `routes.js`

Add an import and register the type in `connectorMap`:

```js
const { MyConnector } = require('./connectors/<name>.js');

const connectorMap = {
  salesforce: SalesforceConnector,
  odoo: OdooConnector,
  public: PublicConnector,
  <name>: MyConnector,           // ← add this line
};
```

#### 3. Test your connector

Verify the full lifecycle manually before opening a pull request:

```bash
# 1. Start the proxy
npm run dev

# 2. Authenticate
curl -s -X POST http://localhost:3000/session \
  -H "Content-Type: application/json" \
  -d '{ "type": "<name>", "config": { ... } }' | jq .

# Copy the token from the response, then:

# 3. List object types
curl -s http://localhost:3000/metadata \
  -H "Authorization: Bearer <token>" | jq .

# 4. Get metadata for one object type
curl -s http://localhost:3000/metadata/<objectType> \
  -H "Authorization: Bearer <token>" | jq .

# 5. Read data
curl -s "http://localhost:3000/data/<objectType>?limit=5" \
  -H "Authorization: Bearer <token>" | jq .
```

Confirm that:
- `login` sets `sessionInfo.orgId` to a stable, unique value
- `getSessionInfo()` returns a well-formed context object
- `listObjectTypes()` returns a non-empty array for a real instance
- `getObjectMetadata()` includes a `fields` array with name and type
- `getData()` returns normalised records (field aliases applied if a mapping was set)

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines, code style, the connector contribution guide, and the Contributor License Agreement.

---

## Roadmap & changelog

- **[ROADMAP.md](ROADMAP.md)** — planned work and connector support status.
- **[CHANGELOG.md](CHANGELOG.md)** — release history.

Community connector contributions are welcome — see [Writing a new connector](#writing-a-new-connector).

---

## License

Apache 2.0 — see [LICENSE](LICENSE) for the full text.

Copyright (c) 2026 LocalFlow (localflow.fr)
