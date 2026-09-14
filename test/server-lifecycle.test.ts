import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { chmod, mkdtemp, readFile, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { OdooLsMcpServer } from "../src/server.js";

class RejectingTransport implements Transport {
  onclose?: () => void; onerror?: (error: Error) => void; onmessage?: (message: JSONRPCMessage) => void;
  constructor(private readonly rejectStart: boolean, private readonly rejectClose: boolean) {}
  async start(): Promise<void> { if (this.rejectStart) throw new Error("connect rejected"); }
  async send(): Promise<void> {}
  async close(): Promise<void> { if (this.rejectClose) throw new Error("close rejected"); this.onclose?.(); }
}

async function makeServer(overrides: Record<string, unknown> = {}): Promise<OdooLsMcpServer> {
  const workspace = await mkdtemp(join(tmpdir(), "odools-server-")); const binary = resolve("test/fixtures/fake-lsp.mjs"); await chmod(binary, 0o755);
  const config = join(workspace, "odools.toml"); await writeFile(config, "[[config]]\nname='default'\ndisable_javascript=true\n");
  return new OdooLsMcpServer(await loadConfig({ workspace, binary, config, quietMs: 100, requestTimeoutMs: 200, ...overrides }));
}
async function spawnPids(recordFile: string): Promise<number[]> {
  const records = (await readFile(recordFile, "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  return records.filter((record) => record.event === "spawn").map((record) => record.pid);
}

function expectPidGone(pid: number): void { expect(() => process.kill(pid, 0)).toThrow(); }
function expectClean(server: OdooLsMcpServer): void {
  expect(server.lsp.childPid).toBeUndefined(); expect(server.lsp.pendingCount).toBe(0); expect(server.lsp.documentCount).toBe(0);
  expect(server.lsp.readiness.snapshot().processAlive).toBe(false);
}

describe("MCP/LSP lifecycle composition", () => {
  it("connects dormant, lists exactly four tools, and activates once for concurrent and immediate warm semantic calls", async () => {
    const recordFile = join(await mkdtemp(join(tmpdir(), "odools-spawns-")), "spawns.jsonl"); process.env.FAKE_LSP_RECORD_FILE = recordFile;
    const server = await makeServer({ quietMs: 100 }); const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "1" }); await Promise.all([server.start(serverTransport), client.connect(clientTransport)]);
    expect((await client.listTools()).tools.map((tool) => tool.name).sort()).toEqual(["declaration", "definition", "references", "status"]);
    for (let index = 0; index < 2; index++) {
      const status = await client.callTool({ name: "status", arguments: {} });
      expect(status.structuredContent).toMatchObject({ state: "dormant", processAlive: false, watcherState: "stopped", watcherDocumentCount: 0, activationPolicy: "on-semantic-tool" });
      expect(server.lsp.lastChildPid).toBeUndefined();
    }
    const path = "model.py"; await writeFile(join(server.lsp.config.workspace, path), "value = 1\n");
    const calls = ["definition", "references", "declaration"].map((name) => client.callTool({ name, arguments: { path, line: 1, column: 1 } }));
    const results = await Promise.all(calls); expect(results.every((result) => result.isError !== true), JSON.stringify(results)).toBe(true);
    expect(results.map((result) => result.structuredContent)).toEqual(results.map(() => expect.objectContaining({ coldStart: true, startupDurationMs: expect.any(Number) })));
    expect(await spawnPids(recordFile)).toHaveLength(1);
    const warm = await client.callTool({ name: "definition", arguments: { path, line: 1, column: 1 } });
    expect(warm.structuredContent).toMatchObject({ coldStart: false }); expect(warm.structuredContent).not.toHaveProperty("startupDurationMs");
    expect(await spawnPids(recordFile)).toHaveLength(1);
    expect(server.lsp.childPid).toBeTypeOf("number"); expect(server.lsp.readiness.snapshot()).toMatchObject({ watcherState: "watching", automaticRestart: true });
    const pid = server.lsp.childPid!; await client.close(); await server.stop(); expectClean(server); expectPidGone(pid); delete process.env.FAKE_LSP_RECORD_FILE;
  });
  it("rejects a pre-aborted waiter without spawning", async () => {
    const recordFile = join(await mkdtemp(join(tmpdir(), "odools-pre-abort-")), "spawns.jsonl"); process.env.FAKE_LSP_RECORD_FILE = recordFile;
    const server = await makeServer(); const controller = new AbortController(); controller.abort();
    await expect(server.lsp.ensureStarted(controller.signal)).rejects.toThrow(/cancelled/);
    await expect(readFile(recordFile, "utf8")).rejects.toThrow(); expect(server.lsp.lastChildPid).toBeUndefined(); await server.stop(); delete process.env.FAKE_LSP_RECORD_FILE;
  });
  it("does not accumulate AbortSignal listeners for more than twenty shared activation waiters", async () => {
    const recordFile = join(await mkdtemp(join(tmpdir(), "odools-many-waiters-")), "spawns.jsonl"); process.env.FAKE_LSP_RECORD_FILE = recordFile;
    const server = await makeServer({ quietMs: 1000 }); const controller = new AbortController(); const warnings: Error[] = [];
    const onWarning = (warning: Error) => warnings.push(warning); process.on("warning", onWarning);
    try {
      const results = await Promise.all(Array.from({ length: 25 }, () => server.lsp.ensureStarted(controller.signal)));
      expect(results.every((result) => result.coldStart && typeof result.startupDurationMs === "number")).toBe(true);
      expect(await spawnPids(recordFile)).toHaveLength(1); await new Promise((resolveWait) => setImmediate(resolveWait));
      expect(warnings.filter((warning) => warning.name === "MaxListenersExceededWarning")).toEqual([]);
    } finally { process.removeListener("warning", onWarning); await server.stop(); delete process.env.FAKE_LSP_RECORD_FILE; }
  });
  it("reports a caller joining after the child spawned but before initialization as cold", async () => {
    const server = await makeServer({ quietMs: 1000 }); const creator = server.lsp.ensureStarted();
    for (let attempt = 0; attempt < 100 && !server.lsp.childPid; attempt++) await new Promise((resolveWait) => setTimeout(resolveWait, 5));
    expect(server.lsp.childPid).toBeTypeOf("number");
    const joined = server.lsp.ensureStarted();
    await expect(creator).resolves.toMatchObject({ coldStart: true, startupDurationMs: expect.any(Number) });
    await expect(joined).resolves.toMatchObject({ coldStart: true, startupDurationMs: expect.any(Number) });
    await server.stop();
  });
  it("keeps shared activation alive when one waiter aborts", async () => {
    const server = await makeServer(); const first = new AbortController();
    const cancelled = server.lsp.ensureStarted(first.signal); const successful = server.lsp.ensureStarted(); first.abort();
    await expect(cancelled).rejects.toThrow(/cancelled/); await expect(successful).resolves.toMatchObject({ coldStart: true, startupDurationMs: expect.any(Number) });
    expect(server.lsp.childPid).toBeTypeOf("number"); await server.stop(); expectClean(server);
  });
  it("returns stable activation errors and retries after repair", async () => {
    const server = await makeServer(); const original = server.lsp.config.config; const moved = `${original}.moved`; await rename(original, moved);
    await expect(server.lsp.ensureStarted()).rejects.toThrow(/^GENERATED_CONFIG_INVALID:/);
    expect(server.lsp.readiness.snapshot()).toMatchObject({ state: "dormant", processAlive: false, watcherState: "stopped" });
    await rename(moved, original); await expect(server.lsp.ensureStarted()).resolves.toMatchObject({ coldStart: true });
    await server.stop(); expectClean(server);
  });
  it("does not activate OdooLS when MCP connect rejects and stop remains idempotent", async () => {
    const server = await makeServer();
    await expect(server.start(new RejectingTransport(true, false))).rejects.toThrow("connect rejected");
    expect(server.lsp.lastChildPid).toBeUndefined(); expectClean(server); await server.stop(); expectClean(server);
  });
  it("always stops a dormant session when MCP close rejects", async () => {
    const server = await makeServer(); await server.start(new RejectingTransport(false, true)); expect(server.lsp.lastChildPid).toBeUndefined();
    await expect(server.stop()).rejects.toThrow("close rejected"); expectClean(server);
    await server.stop(); expectClean(server);
  });
});
