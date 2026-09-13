# Security Policy

## Supported version

Until the initial GitHub release is published, security fixes are prepared on the main development line. After release, only the latest published version is expected to receive security fixes unless a release notice says otherwise. The package is not published to npm.

## Reporting a vulnerability

Report suspected vulnerabilities privately to **Extreme Micro SL <hola@pyming.com>**. Do not open a public issue for an unpatched vulnerability, and do not include secrets, customer source, credentials, or exploit details in public channels.

Include the affected version, platform, serve mode, impact, reproduction steps, and the smallest non-sensitive evidence needed to investigate. We will acknowledge receipt when possible and coordinate disclosure after assessment and remediation. This policy does not promise a specific response or resolution time.

## Practical-local threat model

`odools-mcp` is a local stdio adapter for trusted development environments. Its security controls include:

- workspace-relative MCP input paths;
- canonical containment checks and rejection of lexical or symlink escapes;
- returned locations restricted to canonical configured roots and represented as rooted paths rather than arbitrary absolute response paths;
- bounded request, startup, result, watcher, restart, and stderr resources;
- pinned managed-runtime versions, URLs, sizes, hashes, archive checks, and installed-file inventory verification;
- no runtime download or installation during `serve`;
- conservative discovery that does not call Git, Docker, or the network, execute project code, or import Odoo;
- private generated configuration and log directories removed after discovered-mode shutdown.

The following are trusted: the invoking local account, workspace and addon source, adapter and OdooLS configuration, installed Node.js dependencies, explicitly selected executables, and runtime assets that match the pinned verification data.

The project is **not a sandbox** and does not claim to protect against a hostile local account, malicious workspace or configuration, compromised dependency, compromised upstream artifact already matching its expected digest, kernel-level attacker, privileged or concurrent filesystem manipulation, denial of service by trusted inputs, or exposure of the stdio MCP endpoint to untrusted parties. Do not expose the endpoint as a public or shared network service, and do not use the adapter against untrusted repositories without an additional isolation boundary.

OdooLS is separately maintained software. Reports about this adapter's installation, verification, discovery, process handling, path controls, lifecycle, or MCP boundary belong here. Vulnerabilities solely in OdooLS should also be reported through the upstream project's security process. This project is independent and is not affiliated with or endorsed by Odoo S.A. or the OdooLS maintainers.
