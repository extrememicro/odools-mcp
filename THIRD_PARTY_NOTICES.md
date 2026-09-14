# Third-Party Notices

`odools-mcp` is an independent adapter maintained by Extreme Micro SL and licensed under **GNU Affero General Public License v3.0 or later (AGPL-3.0-or-later)**. Third-party software retains its own copyright and license terms. Nothing in this file relicenses those components or changes their terms. This inventory is informational and is not legal advice.

References to Odoo and OdooLS identify interoperability targets. This project is not affiliated with or endorsed by Odoo S.A. or the OdooLS maintainers.

## Separately installed managed runtime

The managed Linux x64 runtime consists of pinned, separately licensed components. They are downloaded or supplied as offline preseed assets during runtime installation; they are not copied into this repository or its package archive.

- **OdooLS 1.5.2 Beta** — the official, unmodified `odoo/odoo-ls` release, licensed separately under **GNU Lesser General Public License v3.0 (LGPL-3.0)**. Source and license: <https://github.com/odoo/odoo-ls/tree/1.5.2>.
- **TypeScript 6.0.2 / tsserver** — Microsoft TypeScript, licensed separately under **Apache License 2.0 (Apache-2.0)**. Source and license: <https://github.com/microsoft/TypeScript>.

OdooLS is not forked, vendored, modified, or relicensed by `odools-mcp`. TypeScript is likewise a runtime component rather than part of the AGPL adapter's source.

## npm production dependencies

The production dependency inventory was derived from `package-lock.json` entries not marked `dev` and cross-checked against each installed package's `package.json` name, version, and declared license. At the documented lockfile baseline it contains 108 installed package entries, including nested copies, with these declared SPDX families:

| Declared license | Entries |
| --- | ---: |
| MIT | 92 |
| Apache-2.0 | 4 |
| ISC | 7 |
| BSD-3-Clause | 3 |
| BSD-2-Clause | 1 |
| Python-2.0 | 1 |

The direct production dependencies are:

| Package | Version | Declared license |
| --- | --- | --- |
| `@modelcontextprotocol/sdk` | 1.30.0 | MIT |
| `chokidar` | 4.0.3 | MIT |
| `js-yaml` | 4.3.2 | MIT |
| `smol-toml` | 1.8.0 | BSD-3-Clause |
| `tar-stream` | 3.1.7 | MIT |
| `yauzl` | 3.4.0 | MIT |
| `zod` | 4.6.1 | MIT |

Transitive dependencies and their exact versions are recorded in the repository's `package-lock.json`. Re-evaluate this summary whenever the production dependency lock changes.
