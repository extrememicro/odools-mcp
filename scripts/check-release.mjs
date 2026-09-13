import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { checkSourceHygiene } from "./check-source-hygiene.mjs";

const root = new URL("../", import.meta.url);
const packageJson = JSON.parse(await readFile(new URL("package.json", root), "utf8"));
const expectedMetadata = {
  name: "@pyming/odools-mcp",
  version: "0.1.0",
  private: true,
  license: "AGPL-3.0-or-later",
  author: "Extreme Micro SL <hola@pyming.com>",
  homepage: "https://github.com/extrememicro/odools-mcp#readme",
};
for (const [key, expected] of Object.entries(expectedMetadata)) {
  if (packageJson[key] !== expected) throw new Error(`Unexpected package metadata ${key}: ${JSON.stringify(packageJson[key])}`);
}
if (packageJson.repository?.url !== "git+https://github.com/extrememicro/odools-mcp.git") throw new Error("Unexpected repository URL");
if (packageJson.bugs?.url !== "https://github.com/extrememicro/odools-mcp/issues") throw new Error("Unexpected bugs URL");
if (JSON.stringify(packageJson.maintainers) !== JSON.stringify([expectedMetadata.author])) throw new Error("Unexpected maintainers");

const licenseBytes = await readFile(new URL("LICENSE", root));
const licenseSha256 = createHash("sha256").update(licenseBytes).digest("hex");
const expectedLicenseSha256 = "57c8ff33c9c0cfc3ef00e650a1cc910d7ee479a8bc509f6c9209a7c2a11399d6";
if (licenseSha256 !== expectedLicenseSha256) throw new Error(`LICENSE SHA-256 mismatch: ${licenseSha256}`);

const notices = await readFile(new URL("THIRD_PARTY_NOTICES.md", root), "utf8");
for (const required of ["OdooLS 1.5.2 Beta", "LGPL-3.0", "TypeScript 6.0.2", "Apache-2.0"]) {
  if (!notices.includes(required)) throw new Error(`Third-party notices omit ${required}`);
}

const readme = await readFile(new URL("README.md", root), "utf8");
const clientDocumentation = [
  ["Claude Code", "https://docs.anthropic.com/en/docs/claude-code/mcp", "claude mcp add --transport stdio --scope user odools --"],
  ["OpenCode V2", "https://opencode.ai/v2/docs/mcp-servers/", "\"mcp\": {"],
  ["OpenAI Codex CLI", "https://developers.openai.com/codex/mcp", "codex mcp add odools --"],
];
for (const [client, documentation, snippet] of clientDocumentation) {
  for (const required of [client, documentation, snippet, "serve", "--config"]) {
    if (!readme.includes(required)) throw new Error(`README ${client} setup omits ${required}`);
  }
}
const normalizedReadme = readme.toLowerCase();
const requireMatch = (text, pattern, message) => {
  if (!pattern.test(text)) throw new Error(message);
};

requireMatch(readme, /\bnpm\s+link\b/, "README installation omits npm link");
requireMatch(readme, /\bodools-mcp\s+--version\b/, "README installation omits executable verification");
requireMatch(readme, /\bPATH\b/, "README installation does not explain PATH availability");
requireMatch(
  readme,
  /\bnode\s+\/[^\s`]*odools-mcp\/dist\/cli\.js\b/,
  "README omits the absolute Node entry-point alternative",
);
requireMatch(
  readme,
  /\bpyming-odools-mcp-0\.1\.0\.tgz\b/,
  "README omits the expected scoped-package tarball name",
);

const openCodeExample = JSON.parse(await readFile(new URL("examples/opencode-v2.jsonc", root), "utf8"));
const openCodeCommand = openCodeExample?.mcp?.servers?.odools?.command;
if (
  !Array.isArray(openCodeCommand)
  || openCodeCommand[0] !== "odools-mcp"
  || openCodeCommand[1] !== "serve"
  || !openCodeCommand.includes("--discover-workspace")
) {
  throw new Error("OpenCode example does not use native workspace discovery");
}

const contributing = await readFile(new URL("CONTRIBUTING.md", root), "utf8");
for (const command of ["npm run check-source", "npm run test:hygiene-negative", "npm run test:package"]) {
  if (!contributing.includes(command)) throw new Error(`CONTRIBUTING omits ${command}`);
}
requireMatch(
  contributing,
  /ODOOLS_PROCESS_SMOKE_FIXTURE\s*=\s*[^\s\\]+/,
  "CONTRIBUTING package smoke omits the fixture environment variable",
);
const smokeArgsMatch = contributing.match(/ODOOLS_PROCESS_SMOKE_SERVE_ARGS\s*=\s*'([^'\n]+)'/);
if (!smokeArgsMatch) throw new Error("CONTRIBUTING package smoke omits JSON serve arguments");
let smokeArgs;
try {
  smokeArgs = JSON.parse(smokeArgsMatch[1]);
} catch (error) {
  throw new Error("CONTRIBUTING package smoke serve arguments are not valid JSON", { cause: error });
}
for (const argument of ["--discover-workspace", "--workspace", "--runtime-dir"]) {
  if (!smokeArgs.includes(argument)) throw new Error(`CONTRIBUTING package smoke serve arguments omit ${argument}`);
}

const rationaleConcepts = [
  ["native LSP limitation", ["no active native lsp runtime/tool surface", "does not currently expose active native lsp tools"]],
  ["local stdio MCP support", ["local stdio mcp servers"]],
  ["position-based semantics", ["position-based semantics", "position-based language semantics"]],
  ["bounded navigation role", ["focused navigation source", "not a natural-language discovery"]],
  ["generic graph or semantic discovery", ["graph or semantic indexing", "graph/semantic indexing"]],
  ["conceptual discovery", ["conceptual discovery"]],
  ["architecture understanding", ["architectural understanding", "architecture understanding"]],
  ["impact analysis", ["impact analysis"]],
  ["exact source inspection", ["exact text and source inspection", "exact text/source inspection"]],
  ["literal verification", ["exhaustive verification of literal", "exhaustive literal verification"]],
  ["live runtime inspection", ["live odoo/runtime inspection"]],
  ["runtime sources of truth", ["registry state, database data, access rules, and effective inherited views"]],
  ["rejected semantic duplication", ["duplicating odoo-specific semantics inside graph or indexing engines"]],
  ["rejected permanent fork", ["embedding or permanently forking odools"]],
  ["rejected generic passthrough", ["unrestricted generic lsp passthrough", "unrestricted generic lsp bridge"]],
  ["narrow repository boundary", ["separate repository", "small protocol and security boundary"]],
  ["official unmodified runtime", ["official, unmodified odools runtime"]],
  ["upstream-oriented fork policy", ["fix contributed upstream", "upstream contribution"]],
  ["pinned beta release", ["1.5.2 beta"]],
  ["evidence-driven selection", ["evidence-driven"]],
  ["startup caveat", ["startup can be substantial"]],
  ["memory caveat", ["resident memory"]],
  ["platform caveat", ["linux x64"]],
];
for (const [concept, alternatives] of rationaleConcepts) {
  if (!alternatives.some((text) => normalizedReadme.includes(text))) throw new Error(`README rationale omits generic concept: ${concept}`);
}
const forbiddenCompanionBrands = ["Socrati" + "Code", "Ser" + "ena"];
for (const brand of forbiddenCompanionBrands) {
  if (normalizedReadme.includes(brand.toLowerCase())) throw new Error(`README rationale names a forbidden companion discovery/search brand: ${brand}`);
}

await checkSourceHygiene(fileURLToPath(new URL("../", import.meta.url)));

const packed = JSON.parse(execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
  cwd: root,
  encoding: "utf8",
  maxBuffer: 2 * 1024 * 1024,
}));
const files = packed[0]?.files?.map((entry) => entry.path).sort();
const expectedFiles = [
  "CONTRIBUTING.md",
  "LICENSE",
  "README.md",
  "SECURITY.md",
  "THIRD_PARTY_NOTICES.md",
  "dist/cli.js",
  "dist/config.js",
  "dist/discovery.js",
  "dist/generated-config.js",
  "dist/lifecycle.js",
  "dist/lsp/framing.js",
  "dist/lsp/positions.js",
  "dist/lsp/readiness.js",
  "dist/lsp/session.js",
  "dist/lsp/watcher.js",
  "dist/navigation.js",
  "dist/runtime/archive.js",
  "dist/runtime/constants.js",
  "dist/runtime/download.js",
  "dist/runtime/manager.js",
  "dist/runtime/process.js",
  "dist/security/path-guard.js",
  "dist/server.js",
  "dist/types.js",
  "examples/adapter-explicit.json",
  "examples/adapter-managed.json",
  "examples/opencode-v2.jsonc",
  "package.json",
].sort();
if (expectedFiles.length !== 28) throw new Error(`Internal package manifest count is ${expectedFiles.length}, expected 28`);
if (JSON.stringify(files) !== JSON.stringify(expectedFiles)) throw new Error(`Unexpected package manifest:\n${JSON.stringify(files, null, 2)}`);
const forbidden = /(^|\/)(node_modules|@tmp|test|tests|benchmark|benchmarks|corpus|\.git|@reports|@logs|@data|@exports)(\/|$)|\.(?:tgz|log)$/;
const bad = files.filter((path) => forbidden.test(path));
if (bad.length > 0) throw new Error(`Forbidden package paths: ${bad.join(", ")}`);
process.stdout.write(`${JSON.stringify({ status: "release-checked", packageFiles: files.length, licenseSha256 })}\n`);
