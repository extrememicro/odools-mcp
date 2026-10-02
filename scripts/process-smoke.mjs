import { execFileSync, spawn } from "node:child_process";
import { lstat, mkdtemp, readFile, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const [executableArgument, fixtureArgument, ...serveArguments] = process.argv.slice(2);
const executable = executableArgument ?? process.env.ODOOLS_PROCESS_SMOKE_EXECUTABLE;
const fixturePath = fixtureArgument ?? process.env.ODOOLS_PROCESS_SMOKE_FIXTURE;
const parseServeArgs = (value) => {
  if (!value) return [];
  const parsed = JSON.parse(value);
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) throw new Error("ODOOLS_PROCESS_SMOKE_SERVE_ARGS must be a JSON string array");
  return parsed;
};
const serveArgs = serveArguments.length ? serveArguments : parseServeArgs(process.env.ODOOLS_PROCESS_SMOKE_SERVE_ARGS);
if (!executable || !fixturePath || !serveArgs.length) throw new Error("Usage: process-smoke.mjs EXECUTABLE FIXTURE.json SERVE_ARGS... (or corresponding ODOOLS_PROCESS_SMOKE_* env vars)");
const fixture = JSON.parse(await readFile(fixturePath, "utf8"));
for (const key of ["definition", "references"]) if (!fixture[key]?.path || !fixture[key]?.line || !fixture[key]?.column) throw new Error(`Fixture requires ${key} path, line and column`);
const expected = ["declaration", "definition", "file_diagnostics", "hover", "references", "status"];
function optionValue(name) {
  const positions = serveArgs.flatMap((value, index) => value === name ? [index] : []);
  if (positions.length > 1) throw new Error(`Duplicate process-smoke serve argument: ${name}`);
  if (!positions.length) return undefined;
  const value = serveArgs[positions[0] + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value in process-smoke serve arguments`);
  return value;
}
const discoveryMode = serveArgs.includes("--discover-workspace");
const runtimeArgument = optionValue("--runtime-dir");
if (discoveryMode && !runtimeArgument) throw new Error("Discovery process smoke requires a parsable --runtime-dir");
const runtimeDir = runtimeArgument ? await realpath(resolve(runtimeArgument)) : undefined;
const smokeRuntimeRoot = await mkdtemp(resolve(tmpdir(), "odools-process-smoke-"));
const childEnvironment = { ...process.env, XDG_RUNTIME_DIR: smokeRuntimeRoot };
async function configSnapshot() {
  const entries = await readdir(smokeRuntimeRoot, { withFileTypes: true });
  if (entries.length > 10_000) throw new Error("Runtime directory entry count exceeds process-smoke bound");
  const matched = entries.filter((entry) => entry.name.startsWith("odools-config-") || entry.name.startsWith("odools-session-"));
  for (const entry of matched) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error(`Unsafe generated config entry: ${entry.name}`);
    const metadata = await lstat(resolve(smokeRuntimeRoot, entry.name));
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error(`Generated config entry changed type: ${entry.name}`);
  }
  return matched.map((entry) => entry.name).sort();
}
async function assertConfigCleanup(before, scenario) {
  if (!before) return;
  const after = await configSnapshot();
  if (JSON.stringify(after) !== JSON.stringify(before)) throw new Error(`${scenario} leaked or changed generated config dirs: before=${JSON.stringify(before)} after=${JSON.stringify(after)}`);
}
const limit = 64 * 1024;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function processRows() {
  let output;
  try { output = execFileSync("ps", ["-eo", "pid=,ppid=,comm="], { encoding: "utf8", timeout: 5_000 }); }
  catch (error) { throw new Error(`Process enumeration unsupported or failed: ${String(error)}`); }
  const rows = output.trim().split("\n").filter(Boolean).map((line) => {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
    if (!match) throw new Error(`Cannot parse process row: ${line}`);
    return { pid: Number(match[1]), ppid: Number(match[2]), command: match[3] };
  });
  if (!rows.length) throw new Error("Process enumeration returned no rows");
  return rows;
}
function descendants(pid) {
  const rows = processRows(); const found = new Set([pid]); let changed = true;
  while (changed) { changed = false; for (const row of rows) if (found.has(row.ppid) && !found.has(row.pid)) { found.add(row.pid); changed = true; } }
  found.delete(pid); return [...found];
}
function alive(pids) {
  processRows();
  return pids.filter((pid) => { try { process.kill(pid, 0); return true; } catch { return false; } });
}
async function sampleDescendants(pid, samples = 15) {
  const found = new Set();
  for (let sample = 0; sample < samples; sample++) { for (const child of descendants(pid)) found.add(child); await sleep(100); }
  return [...found];
}
async function waitGone(pids) {
  for (let attempt = 0; attempt < 50; attempt++) { const remaining = alive(pids); if (!remaining.length) return; await sleep(100); }
  throw new Error(`Processes survived teardown: ${alive(pids).join(",")}`);
}
function boundedCapture(stream, label, terminate) {
  let content = ""; let overflow;
  stream?.on("data", (chunk) => {
    if (overflow) return;
    const available = limit - Buffer.byteLength(content);
    if (chunk.length > available) { content += chunk.subarray(0, Math.max(0, available)).toString(); overflow = new Error(`${label} exceeded ${limit} bytes`); terminate(); }
    else content += chunk.toString();
  });
  return { content: () => content, error: () => overflow };
}
function makeTransport() {
  const transport = new StdioClientTransport({ command: executable, args: ["serve", ...serveArgs], env: childEnvironment, stderr: "pipe", maxBufferSize: limit });
  const stderr = boundedCapture(transport.stderr, "MCP stderr", () => { if (transport.pid) try { process.kill(transport.pid, "SIGTERM"); } catch { /* already exited */ } });
  return { transport, stderr };
}
async function normalSmoke() {
  const configBefore = await configSnapshot();
  const wrapped = makeTransport(); const client = new Client({ name: "odools-package-process-smoke", version: "1" }, { timeout: 180_000 }); let pid; let children = [];
  try {
    await client.connect(wrapped.transport); pid = wrapped.transport.pid;
    if (!pid) throw new Error("MCP process PID unavailable");
    children = await sampleDescendants(pid);
    if (children.length) throw new Error(`Dormant MCP unexpectedly has descendants: ${children.join(",")}`);
    const dormantEntries = await configSnapshot();
    if (!dormantEntries.some((entry) => entry.startsWith("odools-config-"))) throw new Error("Discovery generated config was not retained while dormant");
    if (dormantEntries.some((entry) => entry.startsWith("odools-session-"))) throw new Error("Dormant adapter created an OdooLS session directory");
    const listed = (await client.listTools()).tools.map(({ name }) => name).sort();
    if (JSON.stringify(listed) !== JSON.stringify(expected)) throw new Error(`Unexpected tools: ${listed.join(",")}`);
    const status = (await client.callTool({ name: "status", arguments: {} })).structuredContent;
    if (status?.state !== "dormant" || status.processAlive || status.watcherDocumentCount !== 0) throw new Error(`Runtime was not dormant: ${JSON.stringify(status)}`);
    if ((await sampleDescendants(pid)).length) throw new Error("Status activated a child process");
    for (const name of ["definition", "references"]) {
      const result = (await client.callTool({ name, arguments: fixture[name] }, undefined, { timeout: 180_000 })).structuredContent;
      if (result?.error || !Number.isInteger(result?.returned)) throw new Error(`${name} failed: ${JSON.stringify(result)}`);
      if (name === "definition" && result.returned < 1) throw new Error("Definition returned no locations");
      if (name === "definition") {
        children = await sampleDescendants(pid);
        if (!children.length) throw new Error("Semantic call did not activate OdooLS");
        const activeEntries = await configSnapshot();
        if (!activeEntries.some((entry) => entry.startsWith("odools-config-"))) throw new Error("Activated discovery run had no generated config directory");
        if (!activeEntries.some((entry) => entry.startsWith("odools-session-"))) throw new Error("Activated discovery run had no session operational directory");
      }
    }
    if (wrapped.stderr.error()) throw wrapped.stderr.error();
    return { listed, children };
  } finally {
    await client.close().catch(() => undefined);
    if (pid) await waitGone([pid, ...children]);
    await assertConfigCleanup(configBefore, "normal MCP close");
  }
}
async function rawShutdown(mode) {
  const configBefore = await configSnapshot();
  const grouped = process.platform !== "win32";
  const child = spawn(executable, ["serve", ...serveArgs], { detached: grouped, env: childEnvironment, stdio: ["pipe", "pipe", "pipe"] });
  const terminate = (signal) => { try { process.kill(grouped ? -child.pid : child.pid, signal); } catch { /* already exited */ } };
  const stdout = boundedCapture(child.stdout, `${mode} stdout`, () => terminate("SIGTERM"));
  const stderr = boundedCapture(child.stderr, `${mode} stderr`, () => terminate("SIGTERM"));
  const children = []; let closed = false; let deadlock;
  const closedPromise = new Promise((resolve) => child.once("close", () => { closed = true; resolve(); }));
  const accumulate = () => { for (const pid of descendants(child.pid)) if (!children.includes(pid)) children.push(pid); };
  const scenarioDeadline = Date.now() + 10_000;
  try {
    if (mode === "immediate-eof") child.stdin.end();
    else {
      await sleep(250); accumulate();
      if (children.length !== 0) throw new Error("startup-sigterm observed a child before semantic activation");
      terminate("SIGTERM");
    }
    while (!closed && Date.now() < scenarioDeadline) { accumulate(); await sleep(50); }
    if (!closed) { deadlock = new Error(`${mode} shutdown deadlock: parent exceeded 10000ms deadline`); terminate("SIGTERM"); }
  } finally {
    const cleanupDeadline = Date.now() + 2_000;
    while (!closed && Date.now() < cleanupDeadline) { accumulate(); await sleep(50); }
    if (!closed) terminate("SIGKILL");
    await Promise.race([closedPromise, sleep(2_000)]);
    accumulate();
    await waitGone([child.pid, ...children]);
    await assertConfigCleanup(configBefore, mode);
  }
  if (deadlock) throw deadlock;
  if (stdout.error()) throw stdout.error(); if (stderr.error()) throw stderr.error();
  if (stdout.content().length) throw new Error(`${mode} emitted non-protocol stdout: ${JSON.stringify(stdout.content())}`);
  return children.length;
}
const normal = await normalSmoke();
const immediateChildren = await rawShutdown("immediate-eof");
const signalChildren = await rawShutdown("startup-sigterm");
await rm(smokeRuntimeRoot, { recursive: true, force: true });
process.stdout.write(`${JSON.stringify({ status: "process-smoke-passed", tools: normal.listed.length, definition: true, references: true, normalChildren: normal.children.length, immediateChildren, signalChildren, generatedConfigCleanup: runtimeDir ? "verified" : "skipped-explicit-config-no-runtime-dir" })}\n`);
