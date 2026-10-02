import { execFileSync } from "node:child_process";
import { access, readdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootUrl = new URL("../", import.meta.url);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const expectedPackageFiles = [
  "CONTRIBUTING.md",
  "LICENSE",
  "README.md",
  "SECURITY.md",
  "THIRD_PARTY_NOTICES.md",
  "dist/cli.js",
  "dist/config.js",
  "dist/diagnostic.js",
  "dist/discovery.js",
  "dist/file-diagnostics.js",
  "dist/generated-config.js",
  "dist/hover.js",
  "dist/lifecycle.js",
  "dist/lsp/diagnostics.js",
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

await Promise.all(expectedPackageFiles.map((path) => access(new URL(path, rootUrl))));
const cli = await readFile(new URL("dist/cli.js", rootUrl), "utf8");
if (!cli.startsWith("#!/usr/bin/env node\n")) throw new Error("Built CLI lacks its executable shebang");
const distFiles = await readdir(new URL("dist/", rootUrl), { recursive: true });
const unexpectedBuildFiles = distFiles.filter((path) => typeof path === "string" && (path.endsWith(".js.map") || path.includes("/test/") || path.startsWith("test/")));
if (unexpectedBuildFiles.length > 0) throw new Error(`Unexpected build output: ${unexpectedBuildFiles.join(", ")}`);

const packOutput = execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
  cwd: root,
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"],
});
const packResult = JSON.parse(packOutput);
if (!Array.isArray(packResult) || packResult.length !== 1 || !Array.isArray(packResult[0].files)) throw new Error("Unexpected npm pack --dry-run output");
const actualPackageFiles = packResult[0].files.map(({ path }) => path).sort();
if (JSON.stringify(actualPackageFiles) !== JSON.stringify(expectedPackageFiles)) {
  const missing = expectedPackageFiles.filter((path) => !actualPackageFiles.includes(path));
  const unexpected = actualPackageFiles.filter((path) => !expectedPackageFiles.includes(path));
  throw new Error(`Npm tarball manifest mismatch; missing: ${missing.join(", ") || "none"}; unexpected: ${unexpected.join(", ") || "none"}`);
}
process.stdout.write(`${JSON.stringify({ status: "package-manifest-checked", files: actualPackageFiles.length })}\n`);
