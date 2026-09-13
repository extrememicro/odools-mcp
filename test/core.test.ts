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
