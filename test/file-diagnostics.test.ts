import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { LspSession } from "../src/lsp/session.js";
import { DiagnosticsStore } from "../src/lsp/diagnostics.js";
import { FileDiagnosticsProvider } from "../src/file-diagnostics.js";

const finding = { message: "fixture issue", range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } };
it("distinguishes absent, timeout, empty, stale and version-matched observations", async () => {
  const store = new DiagnosticsStore(); store.open("file:///a.py", 1);
  expect(await store.wait("file:///a.py", 0)).toMatchObject({ status: "not_received", received: false });
  expect(await store.wait("file:///a.py", 1)).toMatchObject({ status: "timed_out", timedOut: true });
  store.publish({ uri: "file:///a.py", version: 1, diagnostics: [] });
  expect(store.snapshot("file:///a.py")).toMatchObject({ status: "received", diagnostics: [], freshness: "version_matched" });
  store.open("file:///a.py", 2);
  store.publish({ uri: "file:///a.py", version: 1, diagnostics: [] });
  expect(await store.wait("file:///a.py", 1)).toMatchObject({ status: "stale", timedOut: true });
  store.publish({ uri: "file:///a.py", diagnostics: [finding] });
  expect(store.snapshot("file:///a.py")).toMatchObject({ freshness: "unversioned_uncertain", diagnostics: [finding] });
  store.clear(); expect(store.snapshot("file:///a.py").received).toBe(false);
});

it("bounds and isolates publications, strips nested paths and cancels waits", async () => {
  const store = new DiagnosticsStore(); store.open("file:///a.py", 1);
  store.publish({ uri: "file:///outside.py", diagnostics: [finding] });
  expect(store.snapshot("file:///outside.py").received).toBe(false);
  store.publish({ uri: "file:///a.py", diagnostics: Array.from({ length: 101 }, () => ({ ...finding, message: "a".repeat(5000), relatedInformation: [{ uri: "file:///secret" }] })) });
  const result = store.snapshot("file:///a.py");
  expect(result.truncated).toBe(true); expect(result.diagnostics).toHaveLength(100);
  expect(result.diagnostics[0]!.message).toHaveLength(4096);
  expect(JSON.stringify(result)).not.toContain("secret");
  const controller = new AbortController(); const waiting = store.wait("file:///b.py", 1000, controller.signal);
  controller.abort(); await expect(waiting).rejects.toThrow("cancelled"); expect(store.listenerCount("publication")).toBe(0);
});

it("does not let an inherited pre-open unversioned publication satisfy a positive wait", async () => {
  vi.useFakeTimers();
  try {
    // Pre-open indexing result (no version) is adopted as uncertain at open; the engine then publishes for the open version.
    const store = new DiagnosticsStore(); store.open("file:///c.csv", 1);
    store.publish({ uri: "file:///c.csv", diagnostics: [] });
    expect(store.snapshot("file:///c.csv")).toMatchObject({ status: "received", freshness: "unversioned_uncertain", publishedVersion: null });
    expect(await store.wait("file:///c.csv", 0)).toMatchObject({ freshness: "unversioned_uncertain", timedOut: false });
    const waiting = store.wait("file:///c.csv", 10000);
    let settled = false; void waiting.then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(0); expect(settled).toBe(false);
    // A further unversioned publication is still uncertain and must not end the wait.
    store.publish({ uri: "file:///c.csv", diagnostics: [] });
    await vi.advanceTimersByTimeAsync(0); expect(settled).toBe(false);
    store.publish({ uri: "file:///c.csv", version: 1, diagnostics: [{ ...finding, code: "OLS05001" }] });
    expect(await waiting).toMatchObject({ status: "received", freshness: "version_matched", publishedVersion: 1, documentVersion: 1, timedOut: false, diagnostics: [{ message: "fixture issue" }] });
    expect(store.listenerCount("publication")).toBe(0);

    // Timeout preserves truthful uncertainty instead of reporting a match or absence.
    store.open("file:///d.csv", 1); store.publish({ uri: "file:///d.csv", diagnostics: [finding] });
    const timing = store.wait("file:///d.csv", 50);
    await vi.advanceTimersByTimeAsync(50);
    expect(await timing).toMatchObject({ status: "received", freshness: "unversioned_uncertain", publishedVersion: null, timedOut: true, diagnostics: [finding] });
    expect(store.listenerCount("publication")).toBe(0);

    // Cancellation while waiting past an uncertain observation detaches listeners and timer.
    const controller = new AbortController(); const cancelled = store.wait("file:///d.csv", 10000, controller.signal);
    store.publish({ uri: "file:///d.csv", diagnostics: [] });
    controller.abort(); await expect(cancelled).rejects.toThrow("cancelled");
    expect(store.listenerCount("publication")).toBe(0); expect(vi.getTimerCount()).toBe(0);
  } finally { vi.useRealTimers(); }
});

let root: string | undefined;
let session: LspSession | undefined;
afterEach(async () => { await session?.stop(); if (root) await rm(root, { recursive: true, force: true }); });

it("adopts bounded early disk publications without claiming snapshot correspondence", async () => {
  root = await mkdtemp(resolve(tmpdir(), "early-diagnostics-"));
  const path = resolve(root, "model.py"); await writeFile(path, "original");
  const uri = pathToFileURL(path).href;
  const store = new DiagnosticsStore(root);
  store.publish({ uri, version: -100, diagnostics: Array.from({ length: 101 }, () => ({ ...finding, message: "x".repeat(5000) })) });
  await writeFile(path, "changed before open");
  store.open(uri, 1);
  expect(store.snapshot(uri)).toMatchObject({ status: "received", documentVersion: 1, publishedVersion: -100, freshness: "unversioned_uncertain", truncated: true });
  expect(store.snapshot(uri).diagnostics).toHaveLength(100);
  expect(store.snapshot(uri).diagnostics[0]!.message).toHaveLength(4096);
  store.open(uri, 2);
  store.publish({ uri, version: -100, diagnostics: [] });
  expect(store.snapshot(uri).status).toBe("stale");
  store.publish({ uri, version: 1, diagnostics: [] });
  expect(store.snapshot(uri).status).toBe("stale");
  store.publish({ uri, version: 2, diagnostics: [finding] });
  store.publish({ uri, version: -100, diagnostics: [] });
  store.publish({ uri, diagnostics: [] });
  expect(store.snapshot(uri)).toMatchObject({ freshness: "version_matched", publishedVersion: 2, diagnostics: [finding] });
  store.remove(uri); store.open(uri, 1);
  expect(store.snapshot(uri).received).toBe(false);
  store.remove(uri); store.publish({ uri, version: 1, diagnostics: [finding] }); store.open(uri, 1);
  expect(store.snapshot(uri).received).toBe(false);
  store.publish({ uri, version: 1, diagnostics: [finding] });
  expect(store.snapshot(uri).freshness).toBe("version_matched");
  store.remove(uri); store.publish({ uri, version: -100, diagnostics: [finding] }); store.clear(); store.open(uri, 1);
  expect(store.snapshot(uri).received).toBe(false);
});

it("rejects malformed/external and symlink-escape early publications and caps documents", async () => {
  root = await mkdtemp(resolve(tmpdir(), "early-isolation-"));
  const workspace = resolve(root, "workspace"); await mkdir(workspace);
  const outside = resolve(root, "outside.py"); await writeFile(outside, "outside");
  const escape = resolve(workspace, "escape.py"); await symlink(outside, escape);
  const store = new DiagnosticsStore(workspace);
  for (const uri of ["bad", "https://example.com/model.py", "file:///bad%00.py", pathToFileURL(outside).href, pathToFileURL(escape).href, pathToFileURL(workspace).href]) {
    store.publish({ uri, version: -100, diagnostics: [finding] }); store.open(uri, 1);
    expect(store.snapshot(uri).received).toBe(false);
    store.remove(uri);
  }
  const uris: string[] = [];
  for (let i = 0; i < 257; i++) {
    const path = resolve(workspace, `${i}.py`); await writeFile(path, "fixture");
    const uri = pathToFileURL(path).href; uris.push(uri);
    store.publish({ uri, version: -100, diagnostics: [finding] });
  }
  store.open(uris[0]!, 1); expect(store.snapshot(uris[0]!).received).toBe(false);
  store.open(uris[256]!, 1); expect(store.snapshot(uris[256]!).freshness).toBe("unversioned_uncertain");
  store.publish({ uri: uris[256], version: 1, diagnostics: [{ message: "invalid" }] });
  expect(store.snapshot(uris[256]!).publishedVersion).toBe(-100);
  const alias = resolve(workspace, "alias.py"); await symlink(resolve(workspace, "255.py"), alias);
  store.publish({ uri: pathToFileURL(alias).href, version: -100, diagnostics: [] });
  store.open(uris[255]!, 1); expect(store.snapshot(uris[255]!).diagnostics).toEqual([]);
  // Saturated tombstones fail closed, never permitting an evicted generation.
  for (const uri of uris) store.remove(uri);
  for (const uri of [uris[0]!, uris[256]!]) {
    store.publish({ uri, version: -100, diagnostics: [finding] }); store.open(uri, 1);
    expect(store.snapshot(uri).received).toBe(false);
    store.publish({ uri, version: 1, diagnostics: [finding] });
    expect(store.snapshot(uri).freshness).toBe("version_matched");
  }
  store.clear(); store.publish({ uri: uris[0], version: -100, diagnostics: [] }); store.open(uris[0]!, 1);
  expect(store.snapshot(uris[0]!).freshness).toBe("unversioned_uncertain");
});

it("ignores real shutdown publications during restartable teardown and detaches old parser generation", async () => {
  root = await mkdtemp(resolve(tmpdir(), "diagnostics-shutdown-"));
  const path = resolve(root, "model.py"); await writeFile(path, "pass\n");
  const configPath = resolve(root, "odools.toml"); await writeFile(configPath, "[[config]]\nname='default'\ndisable_javascript=true\n");
  const config = await loadConfig({ workspace: root, binary: resolve("test/fixtures/fake-lsp.mjs"), config: configPath });
  session = new LspSession(config); await session.start();
  const active = session;
  // Exercise non-permanent teardown used by failed activation, followed by reactivation.
  const internal = active as unknown as { stopInternal(cancel: boolean): Promise<void>; parser: { on(event: string, cb: (message: any) => void): void; emit(event: string, message: unknown): void } };
  const parser = internal.parser;
  const uri = pathToFileURL(path).href;
  const payload = { uri, version: -100, diagnostics: [finding] };
  const seen: unknown[] = [];
  parser.on("message", (message) => { if (message.method === "textDocument/publishDiagnostics") seen.push(message.params); });
  const publish = vi.spyOn(active.diagnostics, "publish");
  await active.request("test/shutdownPublication", payload);
  await internal.stopInternal(false);
  expect(seen).toEqual([payload]); expect(publish).not.toHaveBeenCalled();
  await active.ensureStarted();
  parser.emit("message", { method: "textDocument/publishDiagnostics", params: payload });
  expect(publish).not.toHaveBeenCalled();
  const replacementPid = active.childPid;
  expect(replacementPid).toBeDefined();
  const lastError = active.readiness.snapshot().lastError;
  parser.emit("error", new Error("obsolete parser failure"));
  await expect(active.request("test/received", {}, 1000)).resolves.toBeDefined();
  expect(active.childPid).toBe(replacementPid);
  expect(() => process.kill(replacementPid!, 0)).not.toThrow();
  expect(active.readiness.snapshot().lastError).toBe(lastError);
  active.diagnostics.open(uri, 1); expect(active.diagnostics.snapshot(uri).received).toBe(false);
  active.diagnostics.publish({ uri, version: 1, diagnostics: [finding] });
  expect(active.diagnostics.snapshot(uri).freshness).toBe("version_matched");
});
it("discards early observations across child restart and stop", async () => {
  root = await mkdtemp(resolve(tmpdir(), "diagnostics-restart-"));
  const path = resolve(root, "model.py"); await writeFile(path, "pass\n");
  const configPath = resolve(root, "odools.toml"); await writeFile(configPath, "[[config]]\nname='default'\ndisable_javascript=true\n");
  const config = await loadConfig({ workspace: root, binary: resolve("test/fixtures/fake-lsp.mjs"), config: configPath, restartMaxAttempts: 1, restartBackoffMs: 50 });
  session = new LspSession(config); await session.start();
  const active = session; const pid = active.childPid;
  const uri = pathToFileURL(path).href;
  active.diagnostics.publish({ uri, version: -100, diagnostics: [finding] });
  await expect(active.request("test/crash", {}, 1000)).rejects.toThrow(/crashed/);
  await active.ensureStarted();
  expect(active.childPid).not.toBe(pid);
  active.diagnostics.open(uri, 1);
  expect(active.diagnostics.snapshot(uri).received).toBe(false);
  active.diagnostics.remove(uri); active.diagnostics.publish({ uri, version: -100, diagnostics: [finding] });
  await active.stop(); active.diagnostics.open(uri, 1);
  expect(active.diagnostics.snapshot(uri).received).toBe(false);
});

it.each(["py", "xml", "csv"])("isolated %s issue/fix push fixture traverses session and provider", async (extension) => {
  root = await mkdtemp(resolve(tmpdir(), "odools-diagnostics-"));
  await writeFile(resolve(root, "odools.toml"), "[[config]]\nname='default'\ndisable_javascript=true\n");
  const path = `diagnostic-fixture.${extension}`;
  await writeFile(resolve(root, path), "DIAGNOSTIC_FIXTURE_ISSUE");
  const config = await loadConfig({ workspace: root, binary: resolve("test/fixtures/fake-lsp.mjs"), config: resolve(root, "odools.toml"), watcher: false, quietMs: 100 });
  session = new LspSession(config); const provider = new FileDiagnosticsProvider(config, session);
  await expect(provider.call("../outside.py")).rejects.toThrow();
  expect(session.readiness.snapshot().state).toBe("dormant");
  const issue = await provider.call(path, 1000);
  expect(issue).toMatchObject({ status: "received", documentVersion: 1, clean: null }); expect(issue.diagnostics).toHaveLength(1);
  await writeFile(resolve(root, path), "fixed");
  expect(await provider.call(path, 1000)).toMatchObject({ status: "received", documentVersion: 2, publishedVersion: 2, diagnostics: [], clean: null });
});
