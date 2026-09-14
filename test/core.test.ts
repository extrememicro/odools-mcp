import { mkdtemp, mkdir, rename, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { encodeFrame, LspFrameParser } from "../src/lsp/framing.js";
import { codePointColumnToUtf16, utf16ColumnToCodePoint } from "../src/lsp/positions.js";
import { ReadinessTracker } from "../src/lsp/readiness.js";
import { PathGuard } from "../src/security/path-guard.js";

describe("LSP framing", () => {
  it("parses split UTF-8 frames", () => {
    const parser = new LspFrameParser(); const messages: unknown[] = [];
    parser.on("message", (value) => messages.push(value));
    const frame = encodeFrame({ value: "😀" }); parser.push(frame.subarray(0, 9)); parser.push(frame.subarray(9));
    expect(messages).toEqual([{ value: "😀" }]);
  });
  it("rejects malformed and oversized frames", () => {
    const parser = new LspFrameParser(10); const errors: Error[] = []; parser.on("error", (e) => errors.push(e));
    parser.push(Buffer.from("Content-Length: 100\r\n\r\n")); expect(errors[0]?.message).toMatch(/exceeds/);
    parser.push(Buffer.from("Content-Length: x\r\n\r\n")); expect(errors[1]?.message).toMatch(/Malformed/);
  });
});

describe("positions", () => {
  it("converts same-line non-BMP columns", () => {
    expect(codePointColumnToUtf16("a😀b", 3)).toBe(3);
    expect(utf16ColumnToCodePoint("a😀b", 3)).toBe(3);
    expect(() => utf16ColumnToCodePoint("a😀b", 2)).toThrow(/surrogate/);
  });
});

describe("readiness", () => {
  it("requires valid config, loading stop, progress end, quiet and live process", () => {
    const tracker = new ReadinessTracker(100, false); tracker.setConfiguration([]); tracker.setLoading(false); tracker.progressBegin("a");
    expect(tracker.snapshot(Date.now() + 1000).coreReady).toBe(false); tracker.progressEnd("a");
    const ready = tracker.snapshot(Date.now() + 1000); expect(ready.coreReady).toBe(true); expect(ready.state).toBe("ready"); expect(ready.javascriptState).toBe("disabled");
  });
  it("fails on fatal core diagnostic_config messages", () => {
    const tracker = new ReadinessTracker(1, true); tracker.setConfiguration([]); tracker.addConfigurationDiagnostics([{ level: 2, message: "Odoo path does not exist" }]); tracker.setLoading(false);
    expect(tracker.snapshot(Date.now() + 100).state).toBe("failed");
  });
  it("degrades only JavaScript for tsserver diagnostic_config messages", () => {
    const tracker = new ReadinessTracker(1, true); tracker.setConfiguration([]); tracker.setJavascriptStatus(false);
    tracker.addConfigurationDiagnostics([{ level: 2, message: "Unable to start tsserver with the command: missing" }]); tracker.setLoading(false);
    const snapshot = tracker.snapshot(Date.now() + 100);
    expect(snapshot.coreReady).toBe(true); expect(snapshot.state).toBe("degraded"); expect(snapshot.javascriptState).toBe("unavailable");
  });
  it("classifies mixed, stdlib and informational diagnostics independently", () => {
    const mixed = new ReadinessTracker(1, true); mixed.setConfiguration([]); mixed.setLoading(false);
    mixed.addConfigurationDiagnostics([{ level: 2, message: "Unable to start tsserver; stdlib path does not exist" }]);
    expect(mixed.snapshot(Date.now() + 100).fatalConfiguration).toBe(true); expect(mixed.snapshot().javascriptState).toBe("unavailable");
    const info = new ReadinessTracker(1, true); info.setConfiguration([]); info.setLoading(false);
    info.addConfigurationDiagnostics([{ level: 1, message: "Configuration selected; stdlib found and tsserver available" }]);
    expect(info.snapshot(Date.now() + 100).fatalConfiguration).toBe(false); expect(info.snapshot().javascriptState).toBe("pending");
  });
  it("keeps JavaScript pending until actual jsLsStatus", () => {
    const tracker = new ReadinessTracker(1, true); tracker.setConfiguration([]); tracker.setLoading(false);
    expect(tracker.snapshot(Date.now() + 100).javascriptState).toBe("pending");
    tracker.setJavascriptStatus(true); expect(tracker.snapshot(Date.now() + 100).javascriptState).toBe("ready");
  });
  it("keeps reporting ready when ordinary response traffic only touches activity", () => {
    const tracker = new ReadinessTracker(100, false); tracker.setAlive(true); tracker.setConfiguration([]); tracker.setLoading(false);
    const at = Date.now() + 1000;
    const ready = tracker.snapshot(at); expect(ready.state).toBe("ready");
    // Ordinary inbound response for a semantic request: activity advances, state must stay truthful.
    tracker.touch();
    const afterResponse = tracker.snapshot(at);
    expect(afterResponse.state).toBe("ready"); expect(afterResponse.coreReady).toBe(true);
    expect(afterResponse.loading).toBe(false); expect(afterResponse.progressActive).toBe(0);
    expect(afterResponse.lastActivityAt).toBeGreaterThanOrEqual(ready.lastActivityAt);
  });
  it("reports indexing only for explicit loading or work-done progress evidence", () => {
    const tracker = new ReadinessTracker(100, false); tracker.setAlive(true); tracker.setConfiguration([]); tracker.setLoading(false);
    expect(tracker.snapshot(Date.now() + 1000).state).toBe("ready");
    tracker.setLoading(true);
    expect(tracker.snapshot(Date.now() + 1000).state).toBe("indexing");
    tracker.setLoading(false);
    expect(tracker.snapshot(Date.now() + 1000).state).toBe("ready");
    tracker.progressBegin("indexing-token");
    const progressing = tracker.snapshot(Date.now() + 1000);
    expect(progressing.state).toBe("indexing"); expect(progressing.progressActive).toBe(1);
    tracker.progressEnd("indexing-token");
    expect(tracker.snapshot(Date.now() + 1000).state).toBe("ready");
  });
  it("re-opens the quiet window for real indexing evidence but not for traffic", () => {
    const tracker = new ReadinessTracker(100, false); tracker.setAlive(true); tracker.setConfiguration([]); tracker.setLoading(false);
    const now = Date.now();
    // Real loading evidence restarts the quiet window: not ready until quietMs elapsed after loading stopped.
    tracker.setLoading(true); tracker.setLoading(false);
    expect(tracker.snapshot(now).state).toBe("indexing");
    expect(tracker.snapshot(now + 1000).state).toBe("ready");
    // Traffic alone never re-opens it.
    tracker.touch(); expect(tracker.snapshot(now + 1000).state).toBe("ready");
  });
  it("waits the configured quiet period during cold activation before reporting ready", () => {
    const tracker = new ReadinessTracker(1_000, false);
    tracker.setAlive(true); tracker.setConfiguration([]); tracker.setLoading(false);
    const now = Date.now();
    expect(tracker.isReady(now)).toBe(false); expect(tracker.snapshot(now).state).toBe("indexing");
    expect(tracker.isReady(now + 999)).toBe(false);
    expect(tracker.isReady(now + 1_000)).toBe(true); expect(tracker.snapshot(now + 1_000).state).toBe("ready");
  });
  it("ignores redundant loading stop but signals a real loading cycle", () => {
    const tracker = new ReadinessTracker(100, false); tracker.setAlive(true); tracker.setConfiguration([]); tracker.setLoading(false);
    const readyAt = Date.now() + 1000; expect(tracker.snapshot(readyAt).state).toBe("ready");
    tracker.setLoading(false); expect(tracker.snapshot(readyAt).state).toBe("ready");
    tracker.setLoading(true); expect(tracker.snapshot().state).toBe("indexing");
    tracker.setLoading(false); expect(tracker.snapshot().state).toBe("indexing");
    expect(tracker.snapshot(Date.now() + 1000).state).toBe("ready");
  });
  it("fingerprints configuration so unchanged repeats are inert and material changes signal", () => {
    const tracker = new ReadinessTracker(100, false); tracker.setAlive(true);
    const initial = [{ level: 1, message: "profile default" }]; tracker.setConfiguration(initial); tracker.setLoading(false);
    const readyAt = Date.now() + 1000; expect(tracker.snapshot(readyAt).state).toBe("ready");
    tracker.setConfiguration([{ level: 1, message: "profile default" }]);
    expect(tracker.snapshot(readyAt).state).toBe("ready");
    tracker.setConfiguration([{ level: 1, message: "profile changed" }]);
    expect(tracker.snapshot().state).toBe("indexing");
    expect(tracker.snapshot(Date.now() + 1000).state).toBe("ready");
  });
  it("ignores duplicate and unknown progress tokens but preserves balanced transitions", () => {
    const tracker = new ReadinessTracker(100, false); tracker.setAlive(true); tracker.setConfiguration([]); tracker.setLoading(false);
    const readyAt = Date.now() + 1000; expect(tracker.snapshot(readyAt).state).toBe("ready");
    tracker.progressEnd("missing"); expect(tracker.snapshot(readyAt).state).toBe("ready");
    tracker.progressBegin("work"); expect(tracker.snapshot().state).toBe("indexing");
    tracker.progressBegin("work"); expect(tracker.snapshot().progressActive).toBe(1);
    tracker.progressEnd("work"); expect(tracker.snapshot().state).toBe("indexing");
    expect(tracker.snapshot(Date.now() + 1000).state).toBe("ready");
    tracker.progressEnd("work"); expect(tracker.snapshot(Date.now() + 1000).state).toBe("ready");
  });
});

describe("path confinement", () => {
  it("accepts encoded names and rejects traversal/symlink escape/output schemes", async () => {
    const base = await mkdtemp(join(tmpdir(), "odools-")); const workspace = join(base, "workspace"); const outside = join(base, "outside");
    await mkdir(workspace); await mkdir(outside); await writeFile(join(workspace, "sp ace#%.py"), "x"); await writeFile(join(outside, "secret"), "x"); await symlink(join(outside, "secret"), join(workspace, "link"));
    const guard = await PathGuard.create(workspace, [workspace]); const input = await guard.input("sp ace#%.py");
    expect(input.uri).toContain("sp%20ace%23%25.py"); await expect(guard.input("../outside/secret")).rejects.toThrow(/escape/); await expect(guard.input("link")).rejects.toThrow(/symbolic links|symlink/);
    const returned = await guard.returned(input.uri); expect(returned.root).toBe("workspace"); expect(returned.rootPath).toBe("sp ace#%.py");
    await expect(guard.returned("https://example.com/a")).rejects.toThrow(/file/); await expect(guard.returned(new URL(`file://${join(outside, "secret")}`).href)).rejects.toThrow(/escape/);
  });
  it("identifies allowed external roots without parent-relative paths", async () => {
    const base = await mkdtemp(join(tmpdir(), "odools-roots-")); const workspace = join(base, "workspace"); const addon = join(base, "addon");
    await mkdir(workspace); await mkdir(addon); const target = join(addon, "models.py"); await writeFile(target, "x");
    const guard = await PathGuard.create(workspace, [workspace, addon]); const returned = await guard.returned(new URL(`file://${target}`).href);
    expect(returned.root).toBe("addon-1"); expect(returned.rootPath).toBe("models.py"); expect(returned.rootPath).not.toContain("..");
  });
  it("detects deterministic input and returned-location swaps after open", async () => {
    const base = await mkdtemp(join(tmpdir(), "odools-race-")); const workspace = join(base, "workspace"); await mkdir(workspace);
    const inputPath = join(workspace, "input.py"); await writeFile(inputPath, "safe"); let swapped = false;
    const guard = await PathGuard.create(workspace, [workspace], { afterOpen: async (requested) => {
      if (!swapped) { swapped = true; await rename(requested, `${requested}.old`); await writeFile(requested, "replacement"); }
    } });
    await expect(guard.input("input.py")).rejects.toThrow(/changed during secure read/);
    const outputPath = join(workspace, "output.py"); await writeFile(outputPath, "safe"); swapped = false;
    await expect(guard.returned(new URL(`file://${outputPath}`).href)).rejects.toThrow(/changed during secure read/);
  });
});
