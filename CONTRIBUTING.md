# Contributing to LocalFlow Proxy

We welcome contributions — bug fixes, new connectors, new features, and documentation improvements. Please read this document carefully before submitting a pull request.

## How to contribute

1. **Open an issue first** for significant changes (new connectors, breaking changes, large refactors). This avoids wasted effort if the direction doesn't fit the project.
2. Fork the repository and create a branch from `main`.
3. Make your changes, following the code style of the surrounding files (CommonJS modules, pino for logging, no `any` casts).
4. Test manually using the curl workflow described in the [connector guide](README.md#3-test-your-connector), and against a real instance of the target system if possible.
5. Open a pull request with a clear description of what the change does and why.

## Code style

- CommonJS (`require`/`module.exports`) — do not mix ESM syntax
- Use `pino` via `getLogger('<module-name>')` for all logging
- No commented-out code blocks in merged PRs
- Keep connector files self-contained: one file per connector, no shared state outside the class instance

## Intellectual property and Contributor License

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

## Reporting issues

Please open a [GitHub issue](https://github.com/localflow-ai/localflow-proxy/issues) and include:
- Node.js and npm versions
- The connector type (if relevant)
- Steps to reproduce
- Observed vs. expected behaviour

Do **not** include credentials, encryption keys, or other secrets in issue reports.
