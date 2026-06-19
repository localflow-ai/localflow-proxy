# Authorization & Permissions — Spec

> Status: **design spec, not yet implemented.** Reference for the upcoming
> permission model in `localflow-proxy`, `@localflow/core`, and the apps.

LocalFlow runs **one proxy per org** (strong tenant isolation). Each org decides,
per session, which actions a user may perform — to match the org's required
security level.

## 1. Principles (non-negotiable)

1. **The proxy enforces; the client only hints.** The browser is attacker-controllable
   (devtools, patched client, raw `curl`). Any permission with a security/cost
   consequence is enforced at the proxy. Client checks are UX (hide/disable) only.
2. **Deny by default / least privilege.** The effective set starts empty; layers grant.
3. **Fail closed.** If the permission config is missing/unparseable, deny.
4. **Decouple authz from authn.** Permissions depend only on a standardized identity
   `{ type, userId, groups }`, never on which connector authenticated the user. This is
   what lets enterprise directories (AD/LDAP/OIDC) plug in later (§9).
5. **One vocabulary.** Capability keys are defined once (exported from `@localflow/core`)
   and shared by the proxy (enforce) and apps (UX) so they can't drift.
6. **Auditable.** Every *denied* (and security-relevant *allowed*) action is logged.

## 2. Enforced vs Advisory — read this first

Some actions never reach the proxy, so they **cannot** be truly enforced — they are
**advisory** (client-side deterrents), and must be labelled as such (never sold as
guarantees). The rest are **enforced** server-side.

- **Enforced** — the action goes through the proxy (LLM calls, API calls, PDF
  extraction, CRM reads, sizes, quotas).
- **Advisory** — the action is local-only or trivially bypassable (loading a local
  CSV that stays in the browser, copy/paste, exporting a file the user can already see).

## 3. Identity contract

Every session resolves to:

```ts
interface SessionIdentity {
  type: 'public' | 'authenticated'
  userId: string        // stable, opaque id from the auth source (NOT email)
  groups: string[]      // opaque group ids; always [] today, populated by a future directory connector (§9)
}
```

The permission resolver (§7) is a **pure function of this identity**. `groups` exists
now (always empty) so adding a directory connector later is not a breaking change.

## 4. Capabilities

String keys, granted as a set. Absent = denied.

| Key | Meaning | Tier | Enforced at |
|-----|---------|------|-------------|
| `ai.use` | Call the LLM at all (chat **and** analysis generation) | **Enforced** | `POST /common/genai` |
| `ai.attachImage` | Include images in an LLM call | **Enforced** | `/common/genai` (reject `image/*` attachments) |
| `ai.attachFile` | Send other raw files to the LLM ("send to AI") | **Enforced** | `/common/genai` (reject non-image attachments) |
| `pdf.extract` | Extract text from a PDF via the proxy (prerequisite for PDF analysis) | **Enforced** | `POST /common/extract-pdf` |
| `ai.byok` | Supply your own LLM API key | **Enforced** | `/common/genai` (accept/ignore `apiKey`) |
| `api.use` | Let analyses call external APIs via the proxy | **Enforced** | `/common/api-proxy` (+ `apis` allow-list) |
| `crm.read` | Read CRM/ERP data via the proxy connectors | **Enforced** | `/data/*`, `/metadata/*` |
| `data.uploadTabular` | Load CSV/Excel locally (metadata-first) | *Advisory* | client only (file stays in browser; the LLM step is gated by `ai.use`) |
| `data.uploadOther` | Load other local files | *Advisory* | client only |
| `analysis.runLocal` | Run a saved/existing analysis on local data (no LLM) | *Advisory* | client only (pure local execution) |
| `analysis.share` | Export/share an analysis to a file | *Advisory* | client only (can't stop exfiltration of visible data) |
| `chat.copyPaste` | Allow copy/paste in the chat UI | *Advisory* | client only (DLP-style deterrent) |

Notes:
- **PDF analysis** = `pdf.extract` (get the text) + `ai.use` (send text to the LLM). Gating
  `pdf.extract` is the real control — no extraction, no text to send.
- **Generating an analysis from a CSV** = `data.uploadTabular` (advisory) + `ai.use` (enforced);
  the proxy can't distinguish a CSV-derived genai call from a typed one, so `ai.use` is the
  real gate. Restricting `data.uploadTabular` only hides the UI affordance.
- The existing `config.json` `safeMode` maps to denying `ai.attachImage` + `ai.attachFile`
  (keep it as a legacy alias, or derive it).

## 5. Limits (numeric)

| Key | Meaning | Tier | `null` |
|-----|---------|------|--------|
| `maxPromptChars` | Max characters per LLM message | **Enforced** (`/common/genai`) | unlimited |
| `maxUploadBytes` | Max size of a file sent **to the proxy** (attachment / PDF) | **Enforced** (`/common/genai`, `/common/extract-pdf`) | unlimited |
| `genaiPerDay` | Per-user daily LLM calls (supersedes per-IP for authed users) | **Enforced** (`/common/genai`) | unlimited |
| `apiPerDay` | Per-user daily external-API calls | **Enforced** (`/common/api-proxy`) | unlimited |

(“No size limit” is expressed as `null`, not a separate capability.)

## 6. Allow-lists

| Key | Meaning | Tier |
|-----|---------|------|
| `models` | Allowed LLM `modelId`s, or `["*"]` | **Enforced** (`/common/genai`) |
| `apis` | Allowed external-API ids, or `["*"]` | **Enforced** (`/common/api-proxy`) |

## 7. `permissions.json`

A dedicated file (consistent with `llm-configs.json` / `api-config.json`), **hot-reloaded**
on change like the others. Layers:

```jsonc
{
  "public":        { "capabilities": [ ... ], "limits": { ... }, "models": [ ... ], "apis": [ ... ] },
  "authenticated": { "capabilities": [ ... ], "limits": { ... }, "models": [ ... ], "apis": [ ... ] },

  // Reserved for a future directory connector (AD/LDAP/OIDC). Not honored yet.
  "groups":        { "<groupId>": { "capabilities": [ ... ], "limits": { ... } } },

  // Per-user, additive on top of `authenticated` (+ groups). Keyed by the stable userId.
  "users":         { "<userId>": { "capabilities": [ ...add... ], "limits": { ...override... } } }
}
```

### Resolution — `resolve(type, userId, groups) → EffectivePermissions`

1. **Base** = `public` (for `type === 'public'`) or `authenticated` (for `authenticated`).
2. *(future)* union each matching `groups[g]` layer.
3. union `users[userId]` if present.
4. **Merge rules:**
   - `capabilities`: **union** (additive). Absent ⇒ denied.
   - `limits`: most-specific layer wins (user → group → base); `null` = unlimited.
   - `models` / `apis`: union; any `"*"` ⇒ all allowed.
5. Unknown authenticated user ⇒ just `authenticated`. Missing/broken file ⇒ **deny all** (fail closed).
6. *(future)* a `deny: [...]` per layer to subtract — not in v1.

### `EffectivePermissions` (what the resolver returns / the endpoint serves)

```jsonc
{
  "capabilities": ["ai.use", "data.uploadTabular", "api.use", "analysis.runLocal"],
  "limits": { "maxPromptChars": 20000, "maxUploadBytes": 10485760, "genaiPerDay": 200, "apiPerDay": 2000 },
  "models": ["gemini-flash", "claude-sonnet"],
  "apis": ["*"]
}
```

## 8. API surface

### `GET /permissions` (auth required; works for public + authenticated tokens)
Returns the **resolved** `EffectivePermissions` for the current session. The client renders
its UI from this (hide/disable, show limits, mark advisory items as deterrents) and re-fetches
when it needs to (config hot-reloads). The raw `permissions.json` is never exposed.

### Enforcement (independent of the client)
| Endpoint | Checks |
|----------|--------|
| `POST /common/genai` | `ai.use`; attachments → `ai.attachImage` / `ai.attachFile`; `models`; `maxPromptChars`; `maxUploadBytes`; `genaiPerDay`; `ai.byok` for `apiKey` |
| `POST /common/extract-pdf` | `pdf.extract`; `maxUploadBytes` |
| `ALL /common/api-proxy` | `api.use`; `apis` allow-list; `apiPerDay` |
| `/data/*`, `/metadata/*` | `crm.read` |

`@localflow/core`: exports the capability/limit key enum + `EffectivePermissions` type, and a
`ProxyClient.getPermissions()` that calls `GET /permissions`.

## 9. Future: enterprise directories (AD / LDAP / OIDC / SCIM)

Not built now — but the design above keeps the door open at near-zero cost:
- A future **identity connector** (OIDC/SAML for SSO, or LDAP) authenticates and fills
  `sessionInfo.{ userId, groups }`. The `POST /session { type, config }` flow generalizes to an
  `oidc`/`ldap` type; the token-session model is unchanged.
- `userId` = the directory's stable id (AD `objectGUID`, OIDC `sub`). `groups` = opaque strings.
- The proxy maps **group → permission set** in the reserved `groups` section; the console gains a
  "map directory groups to capabilities" screen. SCIM can auto-provision later.
- Group ids stay opaque — no directory-specific logic leaks into the resolver or apps.
- **Migration note:** switching an org's auth source changes its `userId` space, so per-user
  overrides from the old source won't carry over. Handle at migration time.

## 10. Roles (future sugar)

Roles are **named presets** that expand to a capability set — an admin/console convenience,
never a separate enforcement mechanism. Example presets (capabilities only; limits/models/apis
configured per layer):

| Role | Capabilities |
|------|--------------|
| **VIEWER** | `data.uploadTabular`, `analysis.runLocal` (run analyses on own data; no LLM, no chat) |
| **SAFE** | VIEWER + `ai.use`, `api.use` (chat + analysis generation + APIs; nothing that ships raw files out) |
| **PRIVILEGED** | SAFE + `ai.attachImage`, `ai.attachFile`, `data.uploadOther` |
| **MANAGER** | PRIVILEGED + `analysis.share` |
| **DOC_MANAGER** | MANAGER + `pdf.extract` |

Until roles exist, the same result is achieved with `authenticated` defaults + per-user
additions.
