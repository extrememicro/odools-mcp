# Contributing

Thank you for improving `odools-mcp`, an independent adapter maintained by **Extreme Micro SL <hola@pyming.com>** at <https://github.com/extrememicro/odools-mcp>.

## Before opening a change

- Use a current Linux x64 development environment with Node.js 20 or newer.
- Discuss substantial behavior, protocol, dependency, runtime-pin, discovery, lifecycle, or threat-model changes in an issue before implementation.
- Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md), not in a public issue.
- Keep the adapter independent: do not vendor, embed, fork, or patch OdooLS in this repository. Propose a fork only for an actual upstream fix, preferably with an upstream contribution path.
- Preserve the public boundary of exactly six read-only MCP leaves—`status`, `definition`, `declaration`, `references`, `hover`, and `file_diagnostics`—unless a separately reviewed release decision changes it.
- Do not add credentials, customer/private source, local absolute paths, runtime archives, generated packages, logs, private benchmark corpora, or agent artifacts.
- Keep the package private and GitHub-only unless maintainers make a separate distribution decision; do not prepare or perform npm publication.

## Development checks

```sh
npm ci
npm run typecheck
npm run lint
npm run check-source
npm run test:hygiene-negative
npm test
npm run build
npm run check-package
npm run check-release
npm audit --omit=dev
npm pack --dry-run
```

Run the packaged executable smoke test separately with a fixture whose definition and reference positions exist in a verified public or synthetic integration workspace, and with a verified runtime installation. Replace the generic absolute placeholders before running:

```sh
ODOOLS_PROCESS_SMOKE_FIXTURE=/path/to/integration-process-smoke.json \
ODOOLS_PROCESS_SMOKE_SERVE_ARGS='["--discover-workspace","--workspace","/path/to/integration-workspace","--runtime-dir","/path/to/verified-runtime"]' \
npm run test:package
```

`ODOOLS_PROCESS_SMOKE_SERVE_ARGS` is a JSON string array containing the complete `serve` arguments. The package smoke starts the packed executable with those arguments, so `--discover-workspace` alone is insufficient: the workspace, runtime, and fixture must form a reproducible integration setup.

Use double quotes in JavaScript and TypeScript. Keep changes focused, deterministic, and covered by targeted tests. Runtime integration tests require a local Odoo source workspace and the pinned official OdooLS runtime; never commit their local configuration, source corpus, logs, or generated temporary files.

## Design expectations

Changes should preserve these public properties unless an approved design explicitly replaces them:

- official, unmodified OdooLS 1.5.2 Beta and TypeScript/tsserver 6.0.2 in the managed Linux x64 runtime;
- dormant MCP connection, shared activation on the first semantic call, warm reuse, and bounded post-activation watching/restart;
- raw `status` remaining non-activating;
- direct raw-MCP callers migrating from the pre-release `odools_*` leaf names to `status`, `definition`, `declaration`, and `references`; the configured MCP server name `odools` does not change;
- native conservative discovery remaining fail-closed and free of Git, Docker, network, or project-code execution;
- explicit configuration remaining available independently of any editor-specific activation plugin;
- workspace-relative inputs, rooted output paths, and one-based Unicode code-point public positions;
- no unrestricted generic LSP passthrough and no write tools.

## Pull requests

Explain the user-visible behavior and threat-model impact, list checks run, and identify every skipped environment-dependent test. Update public documentation when commands, serve modes, discovery rules, output conventions, platform support, runtime pins, lifecycle behavior, limitations, dependencies, or security assumptions change.

By contributing, you agree that your contribution is provided under the repository's **AGPL-3.0-or-later** license. Third-party components retain their own terms as described in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). This contribution guidance is not legal advice.
