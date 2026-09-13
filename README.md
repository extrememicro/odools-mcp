# odools-mcp

`odools-mcp` is a local Model Context Protocol (MCP) adapter that exposes precise, position-based Odoo code navigation through the official, unmodified OdooLS runtime. It provides exactly four read-only tools:

- `odools_status`
- `odools_definition`
- `odools_declaration`
- `odools_references`

The adapter is maintained by **Extreme Micro SL <hola@pyming.com>** at <https://github.com/extrememicro/odools-mcp>. It is independent software: it is not affiliated with or endorsed by Odoo S.A. or the OdooLS maintainers. It does not fork, vendor, or modify OdooLS.

The adapter is licensed under **AGPL-3.0-or-later**. The separately installed official OdooLS runtime and TypeScript retain their own licenses; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Release status and supported runtime

Version `0.1.0` is intended for an initial GitHub-only release. It is not published to npm, and the package remains `private: true` to prevent accidental npm publication.

The managed runtime supports **Linux x64** with Node.js 20 or newer and pins:

- official OdooLS **1.5.2 Beta**;
- TypeScript/tsserver **6.0.2**.

## Why this adapter exists

Odoo development benefits from several complementary kinds of evidence:

- **Graph or semantic indexing** supports conceptual discovery, architectural understanding, and impact analysis.
- **Exact text and source inspection** supports exhaustive verification of literal names, XML IDs, strings, and implementation details.
- **Live Odoo/runtime inspection** is authoritative for registry state, database data, access rules, and effective inherited views.
- **OdooLS position-based semantics** add language-server navigation across supported Python, XML, JavaScript, and OWL relationships.

OdooLS is therefore a focused navigation source, not a natural-language discovery system and not a replacement for source or live-runtime inspection. OpenCode V2 currently has no active native LSP runtime/tool surface for agents, while local stdio MCP servers are supported. This adapter exposes the useful bounded subset through that working interface. Claude Code and Codex CLI can use the same stdio server.

The initial design deliberately rejected:

- duplicating Odoo-specific semantics inside graph or indexing engines;
- embedding or permanently forking OdooLS;
- exposing unrestricted generic LSP passthrough.

Keeping the adapter in a separate repository preserves a small protocol and security boundary and lets it consume official OdooLS unchanged. An OdooLS fork should be considered only when a real upstream fix is required, ideally with that fix contributed upstream.

### Why OdooLS 1.5.2 Beta

Selection was evidence-driven rather than based only on the newest version number. In local comparative evaluation, 1.5.2 retained the useful 1.4 control behavior while adding worthwhile JavaScript/OWL navigation gains. The trade-offs remain explicit: 1.5.2 is a beta, startup can be substantial, observed OdooLS resident memory was approximately **1.3–1.5 GiB** in the evaluated workspace, and some Odoo relations remain unsupported or incomplete. These are local observations, not a claim of a published universal benchmark; results vary by workspace and machine.

## Lifecycle and tool behavior

The MCP connection is lightweight and initially **dormant**:

1. The client connects to `odools-mcp` over stdio without starting OdooLS.
2. `odools_status` reports lifecycle and readiness without activating OdooLS.
3. The first definition, declaration, or references call performs one shared cold activation and waits for readiness.
4. Concurrent cold calls share that activation; subsequent calls reuse the warm backend.
5. After activation, bounded source watching keeps open relevant files fresh, and bounded automatic restart can recover from a backend crash.
6. Status exposes states including `dormant`, `activating`, `indexing`, `ready`, `degraded`, `restarting`, `failed`, `stopping`, and `stopped`, plus JavaScript, watcher, and restart diagnostics.

Semantic calls accept a workspace-relative `path` and one-based `line` and `column`. Input columns count Unicode code points; the adapter converts them to OdooLS/LSP UTF-16 positions internally. Returned ranges are converted back to one-based Unicode code-point positions. Results contain rooted locations (`workspace`, `addon-1`, and so on), are bounded by `maxLocations`, contain no snippets, and never expose arbitrary absolute response paths.

## Install from GitHub

There is no npm registry distribution. Clone or download the source from <https://github.com/extrememicro/odools-mcp>, then build it and create a local npm link so the `odools-mcp` executable is available on `PATH`:

```sh
npm ci
npm run build
npm link
odools-mcp --version
```

When a GitHub release package is available, extract it and install its production dependencies locally:

```sh
tar -xzf pyming-odools-mcp-0.1.0.tgz
cd package
npm install --omit=dev --ignore-scripts
node dist/cli.js --version
```

The client examples below assume that `odools-mcp` is available on `PATH`. If a local link is not appropriate, replace `odools-mcp` in a client command with `node` followed by the absolute path to the built entry point, for example `node /path/to/odools-mcp/dist/cli.js`.

The package does not contain OdooLS or TypeScript runtime assets.

## Managed runtime

Install and verify the exact pinned runtime before serving:

```sh
odools-mcp install-runtime \
  --version 1.5.2 \
  --runtime-dir "$HOME/.local/share/odools-mcp/runtime-1.5.2"

odools-mcp verify-runtime \
  --runtime-dir "$HOME/.local/share/odools-mcp/runtime-1.5.2"
```

Both commands emit JSON. Installation supports only the pinned version and platform, verifies pinned URLs, sizes, hashes, archive structure, and the resulting inventory, and refuses to replace an existing runtime that fails verification. `serve` only verifies an existing runtime; it never downloads or installs one.

For an offline preseed, obtain all three exact pinned assets on a connected machine and provide them together:

```sh
odools-mcp install-runtime \
  --version 1.5.2 \
  --runtime-dir "$HOME/.local/share/odools-mcp/runtime-1.5.2" \
  --odools-archive ./odoo-linux-x86_64-1.5.2.tar.gz \
  --typeshed-archive ./typeshed.zip \
  --typescript-archive ./typescript-6.0.2.tgz
```

Preseeded assets receive the same size and digest checks. A partial preseed is rejected.

## Serve modes

### Native conservative discovery

For dynamic current-project use, prefer:

```sh
odools-mcp serve --discover-workspace
```

Optional overrides are:

```sh
odools-mcp serve --discover-workspace \
  --workspace <path> \
  --python <path> \
  --runtime-dir <path>
```

Without `--workspace`, discovery starts at the MCP process working directory and searches a bounded number of parent directories. It supports:

- validated Doodba layouts, selecting exactly `<doodba-root>/odoo/custom/src` as the workspace;
- conservative conventional source trees with Odoo core markers and immediate-child addon repositories.

Discovery canonicalizes paths, identifies immediate-child addon roots by addon manifests, and resolves Python from `--python`, an eligible Doodba `.venv`, or `python3` on `PATH`. It fails closed for ambiguous layouts, non-Odoo locations, invalid executables, and relevant symlink escapes. It does not call Git, Docker, or the network, execute project code, import Odoo, or parse arbitrary Python. Generated OdooLS TOML, tsserver shim, and private log directories are temporary and are cleaned after shutdown.

The default managed runtime directory is `$XDG_DATA_HOME/odools-mcp/runtime-1.5.2`, or `$HOME/.local/share/odools-mcp/runtime-1.5.2` when `XDG_DATA_HOME` is unset. It must already pass verification.

### Explicit adapter configuration

For a fixed integration, create adapter JSON and run:

```sh
odools-mcp serve --config <adapter.json>
```

Managed example (also see [`examples/adapter-managed.json`](examples/adapter-managed.json)):

```json
{
  "workspace": "./odoo/custom/src",
  "runtimeDir": "./.odools-runtime",
  "config": "./odools.toml",
  "profile": "default",
  "allowedRoots": []
}
```

Explicit binary example (also see [`examples/adapter-explicit.json`](examples/adapter-explicit.json)):

```json
{
  "workspace": "./odoo/custom/src",
  "binary": "./tools/odools/odoo_ls_server",
  "config": "./odools.toml",
  "profile": "default",
  "tsserver": "./tools/typescript/bin/tsserver",
  "tsserverVersion": "6.0.2",
  "allowedRoots": []
}
```

Exactly one of `runtimeDir` and `binary` is required. Explicit `binary` mode must use OdooLS 1.5.2; if `tsserver` is configured, `tsserverVersion` must be `6.0.2`. Relative paths are resolved from the MCP process working directory, not from the adapter JSON location. `allowedRoots` permits returned locations outside the workspace; MCP input paths remain workspace-relative.

Optional bounded controls include `requestTimeoutMs`, `startupTimeoutMs`, `quietMs`, `maxLocations`, `restartMaxAttempts`, `restartWindowMs`, `restartBackoffMs`, `watcherEnabled`, `watcherDebounceMs`, and `maxWatcherDocuments`.

`--config` and `--discover-workspace` are mutually exclusive. Unknown, duplicate, positional, missing-value, and cross-mode arguments are rejected.

## Client setup

These examples target local stdio MCP clients: **OpenCode V2**, **Claude Code** (not Claude Desktop), and **OpenAI Codex CLI** (not Codex web or the OpenAI API). Replace placeholders and quote paths as appropriate. They follow the official [OpenCode V2 MCP documentation](https://opencode.ai/v2/docs/mcp-servers/), [Claude Code MCP documentation](https://docs.anthropic.com/en/docs/claude-code/mcp), [Codex MCP documentation](https://developers.openai.com/codex/mcp), and [Codex CLI reference](https://developers.openai.com/codex/cli/reference).

### OpenCode V2

For dynamic discovery in the current project:

```jsonc
{
  "mcp": {
    "servers": {
      "odools": {
        "type": "local",
        "command": ["odools-mcp", "serve", "--discover-workspace"]
      }
    }
  }
}
```

Explicit configuration alternative:

```jsonc
"command": ["odools-mcp", "serve", "--config", "/absolute/path/to/adapter.json"]
```

OpenCode eagerly connects configured MCP servers. That starts only the small adapter: the heavy OdooLS backend remains dormant until the first semantic tool call. An optional OpenCode V2 activation plugin maintained separately in PYMING dotfiles can conditionally register this MCP only in plausible Odoo locations. It is a location-activation optimization, not a dependency of the public adapter; direct global configuration remains supported.

### Claude Code

Dynamic current-project discovery:

```sh
claude mcp add --transport stdio --scope user odools -- \
  odools-mcp serve --discover-workspace
```

Explicit configuration alternative:

```sh
claude mcp add --transport stdio --scope user odools -- \
  odools-mcp serve --config /absolute/path/to/adapter.json
```

Inspect or remove it with `claude mcp list`, `claude mcp get odools`, and `claude mcp remove --scope user odools`.

### OpenAI Codex CLI

Dynamic current-project discovery:

```sh
codex mcp add odools -- odools-mcp serve --discover-workspace
```

Explicit configuration alternative:

```sh
codex mcp add odools -- \
  odools-mcp serve --config /absolute/path/to/adapter.json
```

Inspect or remove it with `codex mcp list`, `codex mcp get odools`, and `codex mcp remove odools`.

## Limitations

- Navigation quality and supported relations are bounded by OdooLS 1.5.2 Beta. Empty, partial, or unsupported results are possible.
- Definition, declaration, and references are position-based navigation, not conceptual or natural-language search.
- Cold startup and indexing can be slow and memory-intensive on large Odoo trees. A cancelled caller stops waiting, while other callers can continue sharing the same activation; process shutdown cancels activation.
- `coreReady` and JavaScript readiness are reported separately. JavaScript/OWL support can be unavailable while core navigation remains usable.
- The watcher covers a bounded set of relevant source files and is not a general-purpose indexing service.
- Discovery is intentionally conservative. Unusual or ambiguous layouts should use explicit adapter JSON and OdooLS TOML.
- The adapter does not inspect live database, registry, access-rule, or effective-view state.
- Linux x64 is the only managed runtime platform.

## Security

The project uses a **practical-local threat model**. Workspace source, configured roots, configuration, dependencies, selected executables, and the invoking local account are trusted. Input files are opened through workspace-relative path controls; lexical and symlink escapes are rejected. Returned files are constrained to canonical configured roots and represented as rooted paths.

This is not a sandbox against hostile local users, malicious workspaces/configuration, compromised dependencies, privileged filesystem manipulation, or untrusted access to the stdio endpoint. Do not expose it as a network service or use it on untrusted repositories. See [SECURITY.md](SECURITY.md) and report vulnerabilities privately to **hola@pyming.com**.

## License and contributing

Copyright Extreme Micro SL. Licensed under [AGPL-3.0-or-later](LICENSE).

Contributions are welcome through <https://github.com/extrememicro/odools-mcp>. Read [CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md), and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) before submitting a change.
