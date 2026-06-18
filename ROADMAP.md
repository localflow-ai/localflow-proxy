# Roadmap

Directions under consideration for the LocalFlow Proxy — not commitments or a release schedule.

## Connector support

| Connector | Status |
|-----------|--------|
| Odoo | ✅ Done |
| Salesforce | ✅ Done |
| SQL (generic) | 🚧 In progress |
| Zoho CRM | Planned |
| HubSpot | Planned |
| QuickBooks Online | Planned |
| Xero | Planned |
| NetSuite | Planned |
| ERPNext / Frappe | Planned |
| Dynamics 365 Business Central | Planned |
| SuiteCRM | Planned |
| Freshsales | Planned |

Community contributions for any of these — or any other connector — are welcome. See [Writing a new connector](README.md#writing-a-new-connector).

## LLM bridge

- **Streaming responses (SSE).** A streaming variant of `POST /common/genai` that sets `stream: true` on the upstream provider (OpenAI/Anthropic SSE, Gemini `streamGenerateContent`) and relays token deltas to the client as Server-Sent Events, for incremental ("typewriter") rendering. **Cross-repo:** needs a matching streaming client in `@localflow/core` (e.g. `callLLMStream()`) and incremental rendering in `localflow-assistant`. Most useful for plain chat — the metadata-first path needs the complete JSON (`{answer, formula}`) before it can run the formula.

For shipped changes, see [CHANGELOG.md](CHANGELOG.md).
