import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const SOURCE_ALLOWLIST = [
  ".gitignore",
  "CONTRIBUTING.md",
  "LICENSE",
  "README.md",
  "SECURITY.md",
  "THIRD_PARTY_NOTICES.md",
  "eslint.config.js",
  "examples/adapter-explicit.json",
  "examples/adapter-managed.json",
  "examples/opencode-v2.jsonc",
  "package-lock.json",
  "package.json",
  "scripts/check-package.mjs",
  "scripts/check-release.mjs",
  "scripts/check-source-hygiene.mjs",
  "scripts/clean.mjs",
  "scripts/package-smoke.mjs",
  "scripts/process-smoke.mjs",
  "src/cli.ts",
  "src/config.ts",
  "src/diagnostic.ts",
  "src/discovery.ts",
  "src/generated-config.ts",
  "src/lifecycle.ts",
  "src/lsp/framing.ts",
  "src/lsp/positions.ts",
  "src/lsp/readiness.ts",
  "src/lsp/session.ts",
  "src/lsp/watcher.ts",
  "src/navigation.ts",
  "src/runtime/archive.ts",
  "src/runtime/constants.ts",
  "src/runtime/download.ts",
  "src/runtime/manager.ts",
  "src/runtime/process.ts",
  "src/security/path-guard.ts",
  "src/server.ts",
  "src/types.ts",
  "test/archive-security.test.ts",
  "test/core.test.ts",
  "test/diagnostic-server.test.ts",
  "test/discovery.test.ts",
  "test/download.test.ts",
  "test/fixtures/fake-lsp.mjs",
  "test/fixtures/probe.mjs",
  "test/fixtures/process-smoke.json",
  "test/lifecycle.test.ts",
  "test/process.test.ts",
  "test/real.integration.test.ts",
  "test/runtime.test.ts",
  "test/server-lifecycle.test.ts",
  "test/session.test.ts",
  "tsconfig.build.json",
  "tsconfig.json",
].sort();

const GENERATED_DIRECTORIES = new Set([".git", ".nyc_output", "@tmp", "coverage", "dist", "node_modules"]);
const MAX_TEXT_BYTES = 1024 * 1024;
const PLACEHOLDER_VALUE = /^(?:<[^>]+>|\$\{[^}]+\}|\$[A-Z_][A-Z0-9_]*|example|placeholder|redacted|changeme|xxx+)$/i;

async function enumerateFiles(root, directory = root) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && GENERATED_DIRECTORIES.has(entry.name)) continue;
    const absolute = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await enumerateFiles(root, absolute));
    else if (entry.isFile() || entry.isSymbolicLink()) result.push(relative(root, absolute).split(sep).join("/"));
    else throw new Error(`Unsupported filesystem entry: ${relative(root, absolute)}`);
  }
  return result.sort();
}

function inspectName(path) {
  const segments = path.split("/");
  const forbiddenDirectory = segments.find((segment) => /^@(?:data|exports|logs|reports|scripts)$/i.test(segment));
  if (forbiddenDirectory) return `forbidden artifact directory ${forbiddenDirectory}`;
  if (segments.some((segment) => /^(?:client|customer|private)(?:[-_.]|$)/i.test(segment))) return "private/client artifact name";
  if (/\.(?:7z|env|gz|log|pem|pfx|tar|tgz|zip)$/i.test(path) || basename(path) === ".env") return "forbidden secret/archive/log filename";
  return undefined;
}

function inspectText(path, text) {
  const checks = [
    [/\/(?:home|Users)\/[A-Za-z0-9._-]+\//, "absolute local path"],
    [/[A-Za-z]:\\Users\\[^\\\s]+\\/i, "absolute local path"],
    [/-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/, "private key"],
  ];
  for (const [pattern, label] of checks) if (pattern.test(text)) return `${label} in ${path}`;
  const assignment = /\b(password|passwd|pwd|token|api[_-]?key|secret)\b\s*=\s*["']([^"'\r\n]+)["']/gi;
  for (const match of text.matchAll(assignment)) {
    if (!PLACEHOLDER_VALUE.test(match[2])) return `credential assignment in ${path}`;
  }
  return undefined;
}

export async function checkSourceHygiene(rootArgument) {
  const root = resolve(rootArgument);
  const files = await enumerateFiles(root);
  const allowed = new Set(SOURCE_ALLOWLIST);
  const missing = SOURCE_ALLOWLIST.filter((path) => !files.includes(path));
  const extra = files.filter((path) => !allowed.has(path));
  if (missing.length || extra.length) throw new Error(`Source allowlist mismatch; missing=${JSON.stringify(missing)} extra=${JSON.stringify(extra)}`);

  for (const path of files) {
    const nameFinding = inspectName(path);
    if (nameFinding) throw new Error(`${nameFinding}: ${path}`);
    const absolute = join(root, path);
    const info = await stat(absolute);
    if (info.size > MAX_TEXT_BYTES) throw new Error(`Source file exceeds bounded scan size: ${path}`);
    const content = await readFile(absolute);
    if (content.includes(0)) throw new Error(`Binary source file is not allowed: ${path}`);
    const textFinding = inspectText(path, content.toString("utf8"));
    if (textFinding) throw new Error(textFinding);
  }

  try {
    await stat(join(root, ".git"));
    const tracked = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" }).split("\0").filter(Boolean).sort();
    if (JSON.stringify(tracked) !== JSON.stringify(SOURCE_ALLOWLIST)) throw new Error("Tracked files do not equal the source allowlist");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  return files.length;
}

async function negativeSelfTest() {
  const fixture = await mkdtemp(join(tmpdir(), "odools-hygiene-"));
  try {
    for (const path of SOURCE_ALLOWLIST) {
      await mkdir(dirname(join(fixture, path)), { recursive: true });
      await writeFile(join(fixture, path), "safe fixture\n");
    }
    await writeFile(join(fixture, "unexpected-source.ts"), "export {};\n");
    await checkSourceHygiene(fixture).then(() => { throw new Error("Extra-file negative fixture unexpectedly passed"); }, (error) => {
      if (!String(error).includes("unexpected-source.ts")) throw error;
    });
    await rm(join(fixture, "unexpected-source.ts"));
    await writeFile(join(fixture, "README.md"), `${"to" + "ken"} = "actual-secret-value"\n`);
    await checkSourceHygiene(fixture).then(() => { throw new Error("Content negative fixture unexpectedly passed"); }, (error) => {
      if (!String(error).includes("credential assignment")) throw error;
    });
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
  process.stdout.write(`${JSON.stringify({ status: "source-hygiene-negative-tests-passed", cases: 2 })}\n`);
}

const invokedPath = process.argv[1] ? await realpath(process.argv[1]).catch(() => "") : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  if (process.argv.includes("--self-test")) await negativeSelfTest();
  else {
    const root = fileURLToPath(new URL("../", import.meta.url));
    const count = await checkSourceHygiene(root);
    process.stdout.write(`${JSON.stringify({ status: "source-hygiene-checked", files: count })}\n`);
  }
}
