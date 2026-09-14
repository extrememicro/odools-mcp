import { chmod, copyFile, lstat, mkdtemp, mkdir, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { LspSession } from "../src/lsp/session.js";
import { SourceWatcher } from "../src/lsp/watcher.js";
import { ReadinessTracker } from "../src/lsp/readiness.js";
import { PathGuard, type SafeReadOperation } from "../src/security/path-guard.js";

const sessions: LspSession[] = [];
afterEach(async () => { await Promise.all(sessions.splice(0).map(async (session) => session.stop())); delete process.env.FAKE_LSP_NEVER_INITIALIZE; delete process.env.FAKE_LSP_CRASH_MARKER; delete process.env.FAKE_LSP_RECORD_FILE; });

async function fixture(overrides: Record<string, unknown> = {}) {
  const workspace = await mkdtemp(join(tmpdir(), "odools-session-"));
  const binary = resolve("test/fixtures/fake-lsp.mjs"); await chmod(binary, 0o755);
  const config = join(workspace, "odools.toml");
  await writeFile(config, "[[config]]\nname='default'\ndisable_javascript=true\n[[config]]\nname='production'\ndisable_javascript=true\n");
  return await loadConfig({ workspace, binary, config, quietMs: 100, requestTimeoutMs: 200, ...overrides });
}
async function start(overrides: Record<string, unknown> = {}): Promise<LspSession> { const session = new LspSession(await fixture(overrides)); sessions.push(session); await session.start(); return session; }
async function waitFor(predicate: () => boolean | Promise<boolean>, timeout = 3000): Promise<void> { const start = Date.now(); while (!await predicate()) { if (Date.now() - start > timeout) throw new Error("condition timed out"); await new Promise((resolve) => setTimeout(resolve, 25)); } }
async function received(session: LspSession): Promise<any> { return await session.request("test/getReceived", {}); }

function expectPidGone(pid: number): void { expect(() => process.kill(pid, 0)).toThrow(); }

describe("LSP session", () => {
  it("keeps reporting ready for warm requests and returns to ready after real loading", async () => {
    const session = await start();
    expect(session.readiness.snapshot().state).toBe("ready");
    // Warm semantic-style request: its own response must not flip state to indexing.
    await session.request("textDocument/definition", {});
    const afterRequest = session.readiness.snapshot();
    expect(afterRequest.state).toBe("ready"); expect(afterRequest.coreReady).toBe(true);
    expect(afterRequest.loading).toBe(false); expect(afterRequest.progressActive).toBe(0);
    // Real loading evidence after readiness must be reported, then return to ready.
    session.readiness.setLoading(true);
    expect(session.readiness.snapshot().state).toBe("indexing");
    session.readiness.setLoading(false);
    await waitFor(() => session.readiness.snapshot().state === "ready");
    await session.request("textDocument/references", {});
    expect(session.readiness.snapshot().state).toBe("ready");
  });

  it("keeps warm readiness through redundant transport notifications", async () => {
    const session = await start(); expect(session.readiness.snapshot().state).toBe("ready");
    await session.request("test/readinessNotifications", [
      { method: "$Odoo/loadingStatusUpdate", params: "stop" },
      { method: "$Odoo/setConfiguration", params: [] },
      { method: "$/progress", params: { token: "unknown", value: { kind: "end" } } },
    ]);
    const snapshot = session.readiness.snapshot();
    expect(snapshot.state).toBe("ready"); expect(snapshot.coreReady).toBe(true);
    expect(snapshot.loading).toBe(false); expect(snapshot.progressActive).toBe(0);
  });

  it("drives real loading and progress transitions through transport", async () => {
    const session = await start();
    await session.request("test/readinessNotifications", [
      { method: "$Odoo/loadingStatusUpdate", params: "start" },
      { method: "$/progress", params: { token: "index", value: { kind: "begin" } } },
    ]);
    expect(session.readiness.snapshot()).toMatchObject({ state: "indexing", loading: true, progressActive: 1 });
    await session.request("test/readinessNotifications", [
      { method: "$Odoo/loadingStatusUpdate", params: "stop" },
      { method: "$/progress", params: { token: "index", value: { kind: "end" } } },
    ]);
    expect(session.readiness.snapshot().state).toBe("indexing");
    await waitFor(() => session.readiness.snapshot().state === "ready");
  });

  it("uses the exact selected-config argument and answers workspace/configuration", async () => {
    const session = await start({ profile: "production" });
    const log = await received(session);
    expect(log.argv).toContain("--selected-config");
    expect(log.argv[log.argv.indexOf("--selected-config") + 1]).toBe("production");
    expect(log.argv).toContain("--logs-directory");
    const logsDirectory = await realpath(log.argv[log.argv.indexOf("--logs-directory") + 1]); const info = await lstat(logsDirectory);
    expect(logsDirectory).toMatch(/odools-session-.*\/logs$/); expect(logsDirectory.startsWith(`${session.config.workspace}/`)).toBe(false); expect(info.mode & 0o777).toBe(0o700);
    expect(log.selectedProfile).toBe("production");
    expect(log.configuredProfile).toBe("production");
  });

  it("accepts default tmpdir and sticky shared bases but rejects world-writable non-sticky bases", async () => {
    const original = process.env.XDG_RUNTIME_DIR;
    try {
      delete process.env.XDG_RUNTIME_DIR;
      const defaultSession = new LspSession(await fixture()); sessions.push(defaultSession); await defaultSession.start();
      const defaultLog = (await received(defaultSession)).argv; const defaultDir = defaultLog[defaultLog.indexOf("--logs-directory") + 1];
      expect((await lstat(defaultDir)).mode & 0o777).toBe(0o700); await defaultSession.stop();

      const stickyBase = await mkdtemp(join(tmpdir(), "odools-sticky-base-")); await chmod(stickyBase, 0o1777); process.env.XDG_RUNTIME_DIR = stickyBase;
      const stickySession = new LspSession(await fixture()); sessions.push(stickySession); await stickySession.start();
      const stickyArgv = (await received(stickySession)).argv; const stickyDir = stickyArgv[stickyArgv.indexOf("--logs-directory") + 1];
      expect(stickyDir.startsWith(`${stickyBase}/`)).toBe(true); expect((await lstat(stickyDir)).mode & 0o777).toBe(0o700); await stickySession.stop();

      const unsafeBase = await mkdtemp(join(tmpdir(), "odools-nonsticky-base-")); await chmod(unsafeBase, 0o0777); process.env.XDG_RUNTIME_DIR = unsafeBase;
      const unsafeSession = new LspSession(await fixture()); sessions.push(unsafeSession);
      await expect(unsafeSession.start()).rejects.toThrow(/unsafe operational temp base/);
    } finally { if (original === undefined) delete process.env.XDG_RUNTIME_DIR; else process.env.XDG_RUNTIME_DIR = original; }
  });

  it("uses distinct private operational log directories for concurrent sessions and cleans independently", async () => {
    const firstRecord = join(await mkdtemp(join(tmpdir(), "odools-first-record-")), "events.jsonl");
    const first = new LspSession(await fixture()); sessions.push(first); process.env.FAKE_LSP_RECORD_FILE = firstRecord; await first.start();
    const secondRecord = join(await mkdtemp(join(tmpdir(), "odools-second-record-")), "events.jsonl");
    const second = new LspSession(await fixture()); sessions.push(second); process.env.FAKE_LSP_RECORD_FILE = secondRecord; await second.start();
    const parseLogDir = async (record: string) => { const spawn = (await readFile(record, "utf8")).trim().split("\n").map((line) => JSON.parse(line)).find((event) => event.event === "spawn"); return await realpath(spawn.argv[spawn.argv.indexOf("--logs-directory") + 1]); };
    const firstLogs = await parseLogDir(firstRecord); const secondLogs = await parseLogDir(secondRecord); expect(firstLogs).not.toBe(secondLogs);
    for (const [logs, session] of [[firstLogs, first], [secondLogs, second]] as const) { expect(logs.startsWith(`${session.config.workspace}/`)).toBe(false); expect((await lstat(logs)).mode & 0o777).toBe(0o700); }
    await first.stop(); await expect(lstat(firstLogs)).rejects.toThrow(); expect((await lstat(secondLogs)).isDirectory()).toBe(true);
    await second.stop(); await expect(lstat(secondLogs)).rejects.toThrow();
  });

  it("strictly rejects unsafe configured logs directories", async () => {
    const base = await fixture();
    const inside = join(base.workspace, "logs"); await mkdir(inside);
    await expect(loadConfig({ ...base, guard: undefined, binary: base.binary, runtimeDir: undefined, logsDirectory: inside })).rejects.toThrow(/outside workspace/);
    const binaryDirectory = await mkdtemp(join(tmpdir(), "odools-unsafe-binary-"));
    try {
      const binary = join(binaryDirectory, "fake-lsp.mjs");
      await copyFile(base.binary, binary); await chmod(binary, 0o755);
      const runtimeLogs = await mkdtemp(join(binaryDirectory, "unsafe-logs-"));
      await expect(loadConfig({ ...base, guard: undefined, binary, runtimeDir: undefined, logsDirectory: runtimeLogs })).rejects.toThrow(/outside workspace and managed runtime/);
    } finally {
      await rm(binaryDirectory, { force: true, recursive: true });
    }
    const file = join(tmpdir(), `odools-logs-file-${Date.now()}`); await writeFile(file, "x");
    await expect(loadConfig({ ...base, guard: undefined, binary: base.binary, runtimeDir: undefined, logsDirectory: file })).rejects.toThrow(/non-symlink directory/);
    const target = await mkdtemp(join(tmpdir(), "odools-logs-target-")); const link = `${target}-link`; await symlink(target, link);
    await expect(loadConfig({ ...base, guard: undefined, binary: base.binary, runtimeDir: undefined, logsDirectory: link })).rejects.toThrow(/non-symlink directory/);
  });

  it("maps timeout and abort to cancellation", async () => {
    const session = await start(); const observed: Array<number | string> = [];
    session.on("cancelReceived", (id) => observed.push(id));
    await expect(session.request("slow", {}, 50)).rejects.toThrow(/timed out/);
    const controller = new AbortController(); const request = session.request("slow", {}, 1000, controller.signal); controller.abort();
    await expect(request).rejects.toThrow(/cancelled/); await waitFor(() => observed.length === 2);
    expect(observed).toEqual(session.cancellationIds);
  });

  it("cleans up the child after initialize timeout", async () => {
    process.env.FAKE_LSP_NEVER_INITIALIZE = "1"; const config = await fixture({ startupTimeoutMs: 1000 }); const session = new LspSession(config); sessions.push(session);
    const started = Date.now(); await expect(session.start()).rejects.toThrow(/timed out/); expect(Date.now() - started).toBeLessThan(1400);
    expect(session.childPid).toBeUndefined(); expectPidGone(session.lastChildPid!); expect(session.pendingCount).toBe(0); expect(session.readiness.snapshot().processAlive).toBe(false);
  });

  it("shares restart with a semantic waiter without duplicate spawn", async () => {
    const recordFile = join(await mkdtemp(join(tmpdir(), "odools-restart-spawns-")), "events.jsonl"); process.env.FAKE_LSP_RECORD_FILE = recordFile;
    const session = await start({ restartMaxAttempts: 1, restartBackoffMs: 100 }); const original = session.childPid!;
    await expect(session.request("test/crash", {}, 1000)).rejects.toThrow(/crashed/); await waitFor(() => session.readiness.snapshot().state === "restarting");
    await session.ensureStarted(); await waitFor(() => session.childPid !== undefined && session.childPid !== original);
    const events = (await readFile(recordFile, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    const spawns = events.filter((event) => event.event === "spawn"); const pids = spawns.map((event) => event.pid); expect(pids).toHaveLength(2); expect(new Set(pids).size).toBe(2);
    const logDirs = spawns.map((event) => { expect(event.argv).toContain("--logs-directory"); return event.argv[event.argv.indexOf("--logs-directory") + 1]; });
    expect(new Set(logDirs).size).toBe(1); expect((await lstat(logDirs[0])).isDirectory()).toBe(true);
    expect(session.readiness.snapshot().automaticRestart).toBe(true); expectPidGone(original);
  });

  it("stops during backoff after at least one watcher-managed document and asserts count zero/stopped/no replacement", async () => {
    const config = await fixture({ restartMaxAttempts: 1, restartBackoffMs: 100, watcherDebounceMs: 30 });
    const session = new LspSession(config); sessions.push(session); await session.start();
    const path = join(config.workspace, "watcher.py"); await writeFile(path, "watcher managed\n");
    await waitFor(() => session.readiness.snapshot().watcherDocumentCount > 0);
    const original = session.childPid!;
    await expect(session.request("test/crash", {}, 1000)).rejects.toThrow(/crashed/); await waitFor(() => session.readiness.snapshot().state === "restarting");
    const stopped = Date.now(); await session.stop(); expect(Date.now() - stopped).toBeLessThan(500);
    const snap = session.readiness.snapshot();
    expect(snap.watcherDocumentCount).toBe(0); expect(snap.watcherState).toBe("stopped");
    expect(session.childPid).toBeUndefined(); expect(session.lastChildPid).toBe(original); expectPidGone(original);
  });

  it("synchronizes validated bytes, never pathname-only add/change, and safely deletes", async () => {
    const config = await fixture({ watcherDebounceMs: 30, maxWatcherDocuments: 4, profile: "production" });
    const session = new LspSession(config); sessions.push(session); await session.start();
    const path = join(config.workspace, "model.py"); const uri = pathToFileURL(path).href;
    await writeFile(path, "one\n");
    await waitFor(async () => (await received(session)).didOpen.length === 1);
    await writeFile(path, "two\n");
    await waitFor(async () => (await received(session)).didChange.length === 1);
    await writeFile(join(config.workspace, "ignored.txt"), "no sync");
    const outside = await mkdtemp(join(tmpdir(), "odools-outside-")); await writeFile(join(outside, "evil.py"), "evil\n"); await symlink(join(outside, "evil.py"), join(config.workspace, "link.py"));
    await new Promise((resolve) => setTimeout(resolve, 150));
    await import("node:fs/promises").then(({ unlink }) => unlink(path));
    await waitFor(async () => (await received(session)).didChangeWatchedFiles.length === 1);
    const log = await received(session);
    expect(log.didOpen).toEqual([{ textDocument: { uri, languageId: "python", version: 1, text: "one\n" } }]);
    expect(log.didChange).toEqual([{ textDocument: { uri, version: 2 }, contentChanges: [{ text: "two\n" }] }]);
    expect(log.didClose).toEqual([{ textDocument: { uri } }]);
    expect(log.didChangeWatchedFiles).toEqual([{ changes: [{ uri, type: 3 }] }]);
    expect(JSON.stringify(log)).not.toContain("ignored.txt"); expect(JSON.stringify(log)).not.toContain("link.py");
  });

  it("suppresses session dispatch when a watched path swaps outside after descriptor open", async () => {
    const config = await fixture({ watcherDebounceMs: 30 });
    const watchedParent = join(config.workspace, "watched"); const displacedParent = join(config.workspace, "displaced");
    const outsideParent = await mkdtemp(join(tmpdir(), "odools-watched-swap-"));
    await import("node:fs/promises").then(({ mkdir }) => mkdir(watchedParent));
    const watchedPath = join(watchedParent, "swapped.py"); const outsidePath = join(outsideParent, "swapped.py");
    await writeFile(outsidePath, "outside = 1\n");
    let hookOperation: SafeReadOperation | undefined; let hookCalls = 0;
    config.guard = await PathGuard.create(config.workspace, config.allowedRoots, {
      afterOpen: async (requestedPath, _descriptorPath, operation) => {
        if (operation !== "watched" || requestedPath !== watchedPath) throw new Error(`unexpected path-guard hook: ${operation}`);
        hookCalls += 1; hookOperation = operation;
        await rename(watchedParent, displacedParent); await symlink(outsideParent, watchedParent);
      },
    });
    const session = new LspSession(config); sessions.push(session); await session.start();
    await writeFile(watchedPath, "outside = 2\n");
    await waitFor(() => hookCalls === 1); await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    const uri = pathToFileURL(watchedPath).href; const log = await received(session);
    expect(hookOperation).toBe("watched"); expect(hookCalls).toBe(1);
    expect(log.didOpen.filter((entry: any) => entry.textDocument?.uri === uri)).toEqual([]);
    expect(log.didChange.filter((entry: any) => entry.textDocument?.uri === uri)).toEqual([]);
    expect(log.didChangeWatchedFiles.filter((entry: any) => entry.changes?.some((change: any) => change.uri === uri))).toEqual([]);
  });

  it("bounds watcher-managed documents with deterministic LRU close", async () => {
    const session = await start({ watcherDebounceMs: 30, maxWatcherDocuments: 1 });
    const first = join(session.config.workspace, "a.py"); const second = join(session.config.workspace, "b.py");
    await writeFile(first, "a\n"); await waitFor(async () => (await received(session)).didOpen.length === 1);
    await writeFile(second, "b\n"); await waitFor(async () => (await received(session)).didOpen.length === 2);
    const log = await received(session);
    expect(log.didClose).toEqual([{ textDocument: { uri: pathToFileURL(first).href } }]);
    expect(session.documentCount).toBe(1); expect(session.readiness.snapshot()).toMatchObject({ watcherDocumentCount: 1, maxWatcherDocuments: 1 });
  });

  it("serializes overlapping watcher flush callbacks in exact batch order", async () => {
    const config = await fixture({ watcherEnabled: false });
    const firstPath = join(config.workspace, "first.py"); const secondPath = join(config.workspace, "second.py");
    await writeFile(firstPath, "first = 1\n"); await writeFile(secondPath, "second = 2\n");
    let active = 0; let maxActive = 0; let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolveGate) => { releaseFirst = resolveGate; });
    const payloads: string[][] = [];
    const watcher = new SourceWatcher(config.allowedRoots, config.guard, 20, async (changes) => {
      active += 1; maxActive = Math.max(maxActive, active);
      payloads.push(changes.map((change) => change.kind === "content" ? change.file.absolutePath : change.uri));
      if (payloads.length === 1) await firstGate;
      active -= 1;
    }, () => undefined);
    await watcher.start();
    try {
      await writeFile(firstPath, "first = 10\n");
      await waitFor(() => payloads.length === 1);
      await writeFile(secondPath, "second = 20\n");
      await new Promise((resolveWait) => setTimeout(resolveWait, 75));
      expect(payloads).toEqual([[firstPath]]);
      expect(maxActive).toBe(1);
      releaseFirst();
      await waitFor(() => payloads.length === 2 && active === 0);
      expect(payloads).toEqual([[firstPath], [secondPath]]);
      expect(maxActive).toBe(1);
    } finally { releaseFirst(); await watcher.close(); }
  });

  it("reports serialized delivery failures as bounded degraded watcher status and suppresses queued delivery after close", async () => {
    const config = await fixture({ watcherEnabled: false }); const path = join(config.workspace, "queued.py");
    const tracker = new ReadinessTracker(1, false); tracker.setConfiguration([]); tracker.setLoading(false);
    let deliveries = 0;
    const watcher = new SourceWatcher(config.allowedRoots, config.guard, 40, async () => { deliveries++; throw new Error("sink failed with private detail"); }, (error) => tracker.setRecovery({ watcherState: "failed", watcherError: error.message }));
    await watcher.start(); await writeFile(path, "first\n"); await waitFor(() => tracker.snapshot(Date.now() + 100).state === "degraded");
    expect(tracker.snapshot().watcherError).toMatch(/^watcher error: .*sink failed/);
    expect(tracker.snapshot().watcherError!.length).toBeLessThan(200);
    await writeFile(path, "second\n"); await new Promise((resolve) => setTimeout(resolve, 10)); await watcher.close();
    await new Promise((resolve) => setTimeout(resolve, 80)); expect(deliveries).toBe(1);
  });
});
