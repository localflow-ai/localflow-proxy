# LocalFlow Proxy

> **Apache 2.0 License** — See [LICENSE](#license) at the bottom of this file.

The LocalFlow Proxy is the server-side component of the [LocalFlow](https://localflow.fr) ecosystem. It acts as a secure middleware layer between the browser application and external services: it manages sessions, encrypts and forwards LLM API keys, proxies whitelisted external APIs callable from analysis formulas, extracts PDF text, and bridges CRM/ERP connections through a unified REST interface.

**Related repositories:**
- [localflow-core](https://github.com/localflow-ai/localflow-core) — the client-side AI assistant library
- [localflow-app](https://github.com/localflow-ai/localflow-app) — the LocalFlow application

---

## Table of contents

1. [How it fits in LocalFlow](#how-it-fits-in-localflow)
2. [Features](#features)
3. [Getting started](#getting-started)
4. [Configuration](#configuration)
5. [API reference](#api-reference)
6. [Connectors](#connectors)
7. [Contributing](#contributing)
8. [License](#license)

---

## How it fits in LocalFlow

```
Browser (localflow-app)
        │
        │  HTTPS — session token in Authorization header
        ▼
LocalFlow Proxy                 ← this repository
        │
        ├── /common/genai  ──────► Gemini (or other LLM)
        ├── /common/api-proxy ───► Whitelisted external APIs
        ├── /common/extract-pdf ► PDF extraction (Python/pdfplumber)
        ├── /session             Session auth (Odoo, Salesforce, public)
        ├── /metadata            CRM/ERP object metadata
        └── /data                CRM/ERP CRUD operations
```

The proxy holds all secrets (LLM keys, CRM credentials, master encryption key). The browser never sees them. LLM API keys entered by users are encrypted with AES-256-GCM using a per-organisation derived key before being stored by the client, and are decrypted only inside the proxy at request time.

---

## Features

- **Session management** — token-based sessions (24 h sliding TTL, up to 1 000 concurrent sessions) over any registered connector
- **LLM forwarding** — decrypt user API key, forward request to Gemini (pluggable); the key is never sent to the browser in plaintext
- **External API proxy** — whitelist-based forwarding of external API calls made from sandboxed analysis formulas; supports API-key injection (query param, header, body, route placeholder), OAuth 2.0 token exchange, URL rewrite rules, and per-source rate limiting
- **PDF extraction** — layout-preserving text extraction via Python/pdfplumber with optional page-search filtering
- **CRM connectors** — Odoo (XML-RPC) and Salesforce (jsforce) out of the box; a `public` no-auth connector for evaluation sessions
- **Field and object-type mapping** — session-scoped bidirectional field/type aliases so the client can use its own naming conventions regardless of the backend's
- **Encryption helpers** — AES-256-GCM encrypt/decrypt endpoints so the client can store encrypted credentials without ever holding the master key
- **Rate limiting** — per-IP quota on public sessions (Bottleneck); throttled PDF extraction queue

---

## Getting started

### Prerequisites

- Node.js 18+
- npm 9+
- Python 3 with `pdfplumber` installed (`pip install pdfplumber`) — required for PDF extraction
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

Create a `.env` file in the project root (see [Configuration](#configuration) for all options):

```env
MASTER_ENCRYPTION_KEY=your_64_character_hex_string_here
```

### 4. Run

```bash
# Development (auto-restart on file change)
npm run dev

# Production
npm start
```

The server starts on `http://localhost:3000`.

### Production deployment

The included `start-proxy.sh` script starts the server with `nohup` and redirects output to `proxy.log`:

```bash
pkill -f "node index.js"   # stop any running instance
./start-proxy.sh
```

---

## Configuration

### Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `MASTER_ENCRYPTION_KEY` | **Yes** | 64-character hex string (32 bytes). Used to derive per-org AES-256-GCM encryption keys. Generate with `openssl rand -hex 32`. |
| `API_CONFIG_FILE` | No | Path to the API descriptors JSON file. Defaults to `./api-config.json`. The file is hot-reloaded whenever it changes on disk. |

### API descriptor file (`api-config.json`)

The `api-config.json` file defines which external APIs analysis formulas are allowed to call through the `/common/api-proxy` endpoint. Edit the file directly then run:

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

All endpoints (except `POST /session`) require a `Bearer <token>` in the `Authorization` header (or `X-Proxy-Token` for `/common/api-proxy`). Tokens are obtained from `POST /session`.

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

#### `POST /common/genai`

Forward a request to the Gemini API using the caller's encrypted API key.

```json
{
  "encryptedApiKey": "<proxy-encrypted key>",
  "model": "gemini-3-flash-preview",
  "contents": [ ... ]
}
```

The proxy decrypts the key and forwards the rest of the payload verbatim to the Gemini API.

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

We welcome contributions — bug fixes, new connectors, new features, and documentation improvements. Please read this section carefully before submitting a pull request.

### How to contribute

1. **Open an issue first** for significant changes (new connectors, breaking changes, large refactors). This avoids wasted effort if the direction doesn't fit the project.
2. Fork the repository and create a branch from `main`.
3. Make your changes, following the code style of the surrounding files (CommonJS modules, pino for logging, no `any` casts).
4. Test manually using the curl workflow described in [Test your connector](#3-test-your-connector), and against a real instance of the target system if possible.
5. Open a pull request with a clear description of what the change does and why.

### Code style

- CommonJS (`require`/`module.exports`) — do not mix ESM syntax
- Use `pino` via `getLogger('<module-name>')` for all logging
- No commented-out code blocks in merged PRs
- Keep connector files self-contained: one file per connector, no shared state outside the class instance

### Intellectual property and Contributor License

**By submitting a contribution to this project (pull request, patch, or any other form), you certify all of the following:**

1. **Ownership** — The contribution is your original work. You have not copied it from a source whose license is incompatible with the Apache License 2.0.

2. **Right to contribute** — You have the legal right to grant the rights described below. In particular:
   - If you created the contribution in the course of employment, you have obtained the written permission of your employer, or your employment agreement explicitly permits open-source contributions of this nature.
   - The contribution does not, to the best of your knowledge, infringe or misappropriate any third party's intellectual property rights (patents, copyrights, trade secrets, or otherwise).

3. **License grant** — You grant LocalFlow and all recipients of this project a perpetual, worldwide, non-exclusive, royalty-free, irrevocable license to use, reproduce, prepare derivative works of, publicly display, publicly perform, sublicense, and distribute your contribution and such derivative works, under the terms of the Apache License, Version 2.0.

4. **No withdrawal** — You understand that once merged, your contribution becomes part of the project's permanent history and cannot be unilaterally withdrawn.

5. **Public record** — You understand that your contribution and the information associated with it (including your name and contact details, as provided with the contribution) will be retained indefinitely in the project's public version history.

> This constitutes a lightweight Contributor License Agreement (CLA). No separate document needs to be signed — submitting a contribution constitutes your acceptance of these terms. This approach is modelled on the [Apache Individual Contributor License Agreement](https://www.apache.org/licenses/icla.pdf) and the [Developer Certificate of Origin](https://developercertificate.org).

If you are unsure whether your contribution is free of third-party IP encumbrances (e.g. you are implementing a connector for a proprietary system and are unsure about reverse-engineering restrictions in your jurisdiction), open an issue and discuss it before investing time in the implementation.

### Reporting issues

Please open a [GitHub issue](https://github.com/localflow-ai/localflow-proxy/issues) and include:
- Node.js and npm versions
- The connector type (if relevant)
- Steps to reproduce
- Observed vs. expected behaviour

Do **not** include credentials, encryption keys, or other secrets in issue reports.

---

## Roadmap

Connectors planned or in progress:

| Connector | Status |
|-----------|--------|
| Odoo | ✅ Done |
| Salesforce | ✅ Done |
| Zoho CRM | Planned |
| HubSpot | Planned |
| QuickBooks Online | Planned |
| Xero | Planned |
| NetSuite | Planned |
| ERPNext / Frappe | Planned |
| Dynamics 365 Business Central | Planned |
| SuiteCRM | Planned |
| Freshsales | Planned |
| SQL (generic) | In progress |

Community contributions for any of these (or any other connector) are welcome — see [Writing a new connector](#writing-a-new-connector).

---

## License

```
                                 Apache License
                           Version 2.0, January 2004
                        http://www.apache.org/licenses/

   TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION

   1. Definitions.

      "License" shall mean the terms and conditions for use, reproduction,
      and distribution as defined by Sections 1 through 9 of this document.

      "Licensor" shall mean the copyright owner or entity authorized by
      the copyright owner that is granting the License.

      "Legal Entity" shall mean the union of the acting entity and all
      other entities that control, are controlled by, or are under common
      control with that entity.

      "You" (or "Your") shall mean an individual or Legal Entity
      exercising permissions granted by this License.

      "Source" form shall mean the preferred form for making modifications,
      including but not limited to software source code, documentation
      source, and configuration files.

      "Object" form shall mean any form resulting from mechanical
      transformation or translation of a Source form, including but
      not limited to compiled object code, generated documentation,
      and conversions to other media types.

      "Work" shall mean the work of authorship made available under
      the License, as indicated by a copyright notice that is included in
      or attached to the work.

      "Derivative Works" shall mean any work that is based on the Work,
      for which the editorial revisions, annotations, elaborations, or other
      modifications represent, as a whole, an original work of authorship.

      "Contribution" shall mean any work of authorship submitted to the
      Licensor for inclusion in the Work.

      "Contributor" shall mean Licensor and any Legal Entity on behalf of
      whom a Contribution has been received by the Licensor and included
      within the Work.

   2. Grant of Copyright License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      copyright license to reproduce, prepare Derivative Works of,
      publicly display, publicly perform, sublicense, and distribute the
      Work and such Derivative Works in Source or Object form.

   3. Grant of Patent License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      patent license to make, use, sell, offer for sale, import, and
      otherwise transfer the Work.

   4. Redistribution. You may reproduce and distribute copies of the
      Work or Derivative Works thereof in any medium, with or without
      modifications, and in Source or Object form, provided that You
      meet the following conditions:

      (a) You must give any other recipients of the Work or Derivative Works
          a copy of this License; and

      (b) You must cause any modified files to carry prominent notices
          stating that You changed the files; and

      (c) You must retain, in the Source form of any Derivative Works
          that You distribute, all copyright, patent, trademark, and
          attribution notices from the Source form of the Work; and

      (d) If the Work includes a "NOTICE" text file, You must include a
          readable copy of the attribution notices contained within such
          NOTICE file.

   5. Submission of Contributions. Unless You explicitly state otherwise,
      any Contribution submitted for inclusion in the Work shall be under
      the terms and conditions of this License.

   6. Trademarks. This License does not grant permission to use the trade
      names, trademarks, service marks, or product names of the Licensor.

   7. Disclaimer of Warranty. Unless required by applicable law or agreed
      to in writing, Licensor provides the Work on an "AS IS" BASIS,
      WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or
      implied, including, without limitation, any conditions of TITLE,
      NON-INFRINGEMENT, MERCHANTABILITY, or FITNESS FOR A PARTICULAR
      PURPOSE. You are solely responsible for determining the
      appropriateness of using or reproducing the Work.

   8. Limitation of Liability. In no event and under no legal theory
      shall any Contributor be liable to You for damages, including any
      direct, indirect, special, incidental, or exemplary damages of
      any character arising as a result of this License or out of the use
      or inability to use the Work.

   9. Accepting Warranty or Additional Liability. While redistributing
      the Work, you may offer acceptance of warranty, liability, or other
      obligations consistent with this License. However, in accepting such
      obligations, You may act only on Your own behalf and on Your sole
      responsibility, not on behalf of any other Contributor.

   END OF TERMS AND CONDITIONS

   Copyright (c) 2026 LocalFlow (localflow.fr)

   Licensed under the Apache License, Version 2.0 (the "License");
   you may not use this file except in compliance with the License.
   You may obtain a copy of the License at

       http://www.apache.org/licenses/LICENSE-2.0

   Unless required by applicable law or agreed to in writing, software
   distributed under the License is distributed on an "AS IS" BASIS,
   WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   See the License for the specific language governing permissions and
   limitations under the License.
```
