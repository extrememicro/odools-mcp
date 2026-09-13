import { execFileSync, spawn } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const [fixtureArgument, ...serveArguments] = process.argv.slice(2);
const fixture = fixtureArgument ?? process.env.ODOOLS_PROCESS_SMOKE_FIXTURE ?? resolve(root, "test", "fixtures", "process-smoke.json");
const parseServeArgs = (value) => {
  if (!value) return [];
  const parsed = JSON.parse(value);
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) throw new Error("ODOOLS_PROCESS_SMOKE_SERVE_ARGS must be a JSON string array");
  return parsed;
};
const serveArgs = serveArguments.length ? serveArguments : parseServeArgs(process.env.ODOOLS_PROCESS_SMOKE_SERVE_ARGS);
try { await access(fixture, constants.R_OK); }
catch { throw new Error(`Package smoke fixture is unavailable at ${fixture}.`); }
if (!serveArgs.length) throw new Error("Package smoke requires serve arguments after FIXTURE or ODOOLS_PROCESS_SMOKE_SERVE_ARGS as a JSON string array.");
const tempRoot = resolve(root, "@tmp");
await mkdir(tempRoot, { recursive: true });
const work = await mkdtemp(join(tempRoot, "package-smoke-"));
const project = join(work, "project");
const expected = new Set([
  "CONTRIBUTING.md", "LICENSE", "README.md", "SECURITY.md", "THIRD_PARTY_NOTICES.md",
  "dist/cli.js", "dist/config.js", "dist/discovery.js", "dist/generated-config.js", "dist/lifecycle.js", "dist/lsp/framing.js", "dist/lsp/positions.js", "dist/lsp/readiness.js", "dist/lsp/session.js", "dist/lsp/watcher.js", "dist/navigation.js",
  "dist/runtime/archive.js", "dist/runtime/constants.js", "dist/runtime/download.js", "dist/runtime/manager.js", "dist/runtime/process.js", "dist/security/path-guard.js", "dist/server.js", "dist/types.js",
  "examples/adapter-explicit.json", "examples/adapter-managed.json", "examples/opencode-v2.jsonc", "package.json",
]);
function run(command, args, cwd = root) { return execFileSync(command, args, { cwd, encoding: "utf8", maxBuffer: 2 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"], timeout: 120_000, killSignal: "SIGKILL" }); }
async function runProcessSmoke(args) {
  const grouped = process.platform !== "win32";
  const child = spawn(process.execPath, args, { cwd: root, detached: grouped, stdio: ["ignore", "pipe", "pipe"] });
  const targetPid = grouped ? -child.pid : child.pid;
  const signal = (name) => { try { process.kill(targetPid, name); } catch (error) { if (error?.code !== "ESRCH") throw error; } };
  const alive = () => { try { process.kill(targetPid, 0); return true; } catch (error) { if (error?.code === "ESRCH") return false; throw error; } };
  const waitGone = async (timeoutMs) => {
    const deadline = Date.now() + timeoutMs;
    while (alive() && Date.now() < deadline) await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
    return !alive();
  };
  let overflow;
  const capture = (target) => (chunk) => {
    if (overflow) return;
    if (Buffer.byteLength(target.value) + chunk.length > 2 * 1024 * 1024) { overflow = new Error("process-smoke output exceeded 2 MiB"); signal("SIGTERM"); return; }
    target.value += chunk.toString();
  };
  const out = { value: "" }; const err = { value: "" }; child.stdout.on("data", capture(out)); child.stderr.on("data", capture(err));
  let closed = false;
  const closedPromise = new Promise((resolvePromise) => child.once("close", (code, closeSignal) => { closed = true; resolvePromise({ code, signal: closeSignal }); }));
  let deadlineTimer; let primaryError; let result; const cleanupErrors = [];
  try {
    const deadlineMs = 180_000;
    const deadline = new Promise((_, reject) => { deadlineTimer = setTimeout(() => reject(new Error(`process-smoke exceeded outer ${deadlineMs}ms deadline: ${err.value.slice(0, 2000)}`)), deadlineMs); });
    result = await Promise.race([closedPromise, deadline]);
    if (overflow) primaryError = overflow;
    else if (result.code !== 0) primaryError = new Error(`process-smoke failed (${String(result.code ?? result.signal)}): ${err.value.slice(0, 2000)}`);
  } catch (error) { primaryError = error; }
  finally {
    clearTimeout(deadlineTimer);
    try {
      if (alive()) signal("SIGTERM");
      if (!(await waitGone(1_000))) signal("SIGKILL");
      if (!(await waitGone(2_000))) cleanupErrors.push(new Error(`process-smoke process ${targetPid} survived TERM/KILL cleanup`));
      if (!closed) await Promise.race([closedPromise, new Promise((_, reject) => setTimeout(() => reject(new Error("process-smoke close event not observed after cleanup")), 2_000))]);
      if (alive()) cleanupErrors.push(new Error(`process-smoke process ${targetPid} remains alive after close`));
    } catch (error) { cleanupErrors.push(error); }
  }
  if (primaryError && cleanupErrors.length) throw new AggregateError([primaryError, ...cleanupErrors], "process-smoke failed and cleanup failed");
  if (primaryError) throw primaryError;
  if (cleanupErrors.length) throw new AggregateError(cleanupErrors, "process-smoke cleanup failed");
  return out.value;
}
let operationError; let report;
try {
  await mkdir(project, { recursive: true });
  const packRaw = run("npm", ["pack", "--json", "--pack-destination", work]);
  const jsonStart = packRaw.indexOf("[\n");
  if (jsonStart < 0) throw new Error(`npm pack did not return manifest JSON: ${packRaw.slice(0, 500)}`);
  const packed = JSON.parse(packRaw.slice(jsonStart))[0];
  const paths = new Set(packed.files.map(({ path }) => path));
  const missing = [...expected].filter((path) => !paths.has(path)); const extra = [...paths].filter((path) => !expected.has(path));
  if (missing.length || extra.length) throw new Error(`Package manifest mismatch; missing=${missing.join(",")} extra=${extra.join(",")}`);
  const tarball = join(work, packed.filename);
  await access(tarball, constants.R_OK);
  run("npm", ["init", "-y"], project);
  run("npm", ["install", "--ignore-scripts", tarball], project);
  const bin = join(project, "node_modules", ".bin", "odools-mcp");
  await access(bin, constants.X_OK);
  const installedCli = join(project, "node_modules", "@pyming", "odools-mcp", "dist", "cli.js");
  if (!(await readFile(installedCli, "utf8")).startsWith("#!/usr/bin/env node\n")) throw new Error("Installed CLI shebang missing");
  if (!run(bin, ["--help"], project).startsWith("Usage: odools-mcp ")) throw new Error("Installed CLI help failed");
  if (run(bin, ["--version"], project).trim() !== "0.1.0") throw new Error("Installed CLI version failed");
  const smoke = (await runProcessSmoke([join(root, "scripts", "process-smoke.mjs"), bin, resolve(fixture), ...serveArgs])).trim();
  report = { status: "package-smoke-passed", tarball: packed.filename, files: paths.size, installedBin: bin, process: JSON.parse(smoke) };
} catch (error) { operationError = error; }
let cleanupError;
try { await chmod(work, 0o700); await rm(work, { recursive: true, force: true }); }
catch (error) { cleanupError = error; }
if (operationError && cleanupError) throw new AggregateError([operationError, cleanupError], "package smoke failed and temporary cleanup failed");
if (operationError) throw operationError;
if (cleanupError) throw new AggregateError([cleanupError], "package smoke temporary cleanup failed");
process.stdout.write(`${JSON.stringify(report)}\n`);
