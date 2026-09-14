import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { prepareDiscoveryServer, type DiscoveryServerDependencies } from "../src/cli.js";
import { createDiscoveryDiagnostic, safeDiscoverySummary } from "../src/diagnostic.js";
import { generateOdooConfig, GeneratedConfigError } from "../src/generated-config.js";
import { DiscoveryError } from "../src/discovery.js";
import { DiagnosticMcpServer, OdooLsMcpServer } from "../src/server.js";
import type { DiscoveredOdooWorkspace, GeneratedOdooConfig } from "../src/types.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function connect(server: DiagnosticMcpServer | OdooLsMcpServer) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "diagnostic-test", version: "1" });
  await server.start(serverTransport); await client.connect(clientTransport);
  return { client, server };
}

function discovered(workspace: string): DiscoveredOdooWorkspace {
  return {
    workspace, odooPath: workspace, addonRoots: [], isDoodba: false, python: process.execPath,
    discovery: { mode: "conventional", source: "filesystem", status: "ready", effectiveRootCount: 0, unknownConditionResolvedCount: 2_000_000, warnings: ["bounded"], warningsTruncated: false },
  };
}

function generated(adapter: Record<string, unknown>, cleanup = vi.fn(async () => {})): GeneratedOdooConfig {
  return { adapter, tomlPath: "/temporary/odools.toml", cleanup };
}

function dependencies(overrides: Partial<DiscoveryServerDependencies>): DiscoveryServerDependencies {
  return {
    discover: vi.fn(async (workspace) => discovered(workspace)),
    generate: vi.fn(async () => { throw new Error("not configured"); }),
    load: vi.fn(loadConfig),
    ...overrides,
  };
}

async function toolNames(client: Client) {
  return (await client.listTools()).tools.map(({ name }) => name).sort();
}

const FOUR_TOOLS = ["declaration", "definition", "references", "status"];

describe("discovery diagnostic MCP mode", () => {
  it("keeps all tools callable without backend or watcher activation and shuts down idempotently", async () => {
    const diagnostic = createDiscoveryDiagnostic(new DiscoveryError("ODOOLS_DISCOVERY_MISSING_GENERATED_STATE", "secret"));
    const server = new DiagnosticMcpServer(diagnostic);
    expect("lsp" in server).toBe(false);
    const connected = await connect(server);
    expect(await toolNames(connected.client)).toEqual(FOUR_TOOLS);
    const status = (await connected.client.callTool({ name: "status", arguments: {} })).structuredContent as any;
    expect(status).toMatchObject({ state: "failed", backendProcessState: "failed", processAlive: false, watcherEnabled: false, watcherState: "disabled" });
    for (const name of FOUR_TOOLS.filter((name) => name !== "status")) {
      const result = (await connected.client.callTool({ name, arguments: { path: "models/x.py", line: 1, column: 1 } })).structuredContent as any;
      expect(result).toMatchObject({ state: "failed", returned: 0, truncated: false, locations: [], noResult: false });
      expect(result.error).toEqual(status.discovery.error);
    }
    await connected.client.close();
    await connected.server.stop();
    await connected.server.stop();
  });

  it("separates generation failure and creates no cleanup ownership", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const prepared = await prepareDiscoveryServer("/project", undefined, undefined, dependencies({ generate: vi.fn(async () => { throw new Error("secret stack"); }) }));
    stderr.mockRestore();
    expect(prepared.server).toBeInstanceOf(DiagnosticMcpServer);
    expect(prepared.cleanup).toBeUndefined();
    const connected = await connect(prepared.server);
    expect(await toolNames(connected.client)).toEqual(FOUR_TOOLS);
    const status = (await connected.client.callTool({ name: "status", arguments: {} })).structuredContent as any;
    expect(status.discovery).toMatchObject({ source: "runtime", error: { code: "ODOOLS_RUNTIME_CONFIGURATION_FAILED" } });
    await connected.client.close(); await connected.server.stop();
  });

  it.each(["makeTempDirectory", "write"] as const)("classifies representative %s generation failure without leaking messages", async (fault) => {
    const runtime = await mkdtemp(join(tmpdir(), "odools-generation-fault-")); roots.push(runtime);
    await mkdir(join(runtime, "typeshed", "stdlib"), { recursive: true });
    const failure = new Error("https://user:secret@example.invalid/private");
    const deps = {
      verify: vi.fn(async () => ({ binary: "/runtime/odoo-ls", tsserver: "/runtime/tsserver", manifest: "/runtime/manifest" })),
      makeTempDirectory: fault === "makeTempDirectory" ? vi.fn(async () => { throw failure; }) : vi.fn(async () => mkdtemp(join(runtime, "config-"))),
      write: fault === "write" ? vi.fn(async () => { throw failure; }) : vi.fn(writeFile),
    };
    await expect(generateOdooConfig(discovered(runtime), runtime, deps)).rejects.toMatchObject({ stage: "temporary-config", code: "ODOOLS_TEMP_CONFIG_GENERATION_FAILED" });
    const diagnostic = createDiscoveryDiagnostic(new GeneratedConfigError("temporary-config", "ODOOLS_TEMP_CONFIG_GENERATION_FAILED"), "generated-config");
    expect(diagnostic).toMatchObject({ source: "generated-config", error: { code: "ODOOLS_TEMP_CONFIG_GENERATION_FAILED" } });
    expect(JSON.stringify(diagnostic)).not.toContain("secret");
  });

  it("classifies typed runtime verification failure independently", () => {
    const diagnostic = createDiscoveryDiagnostic(new GeneratedConfigError("runtime", "ODOOLS_RUNTIME_CONFIGURATION_FAILED"), "runtime");
    expect(diagnostic).toMatchObject({ source: "runtime", error: { code: "ODOOLS_RUNTIME_CONFIGURATION_FAILED" } });
  });

  it("cleans post-generation adapter validation failure exactly once", async () => {
    const cleanup = vi.fn(async () => {});
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const prepared = await prepareDiscoveryServer("/project", undefined, undefined, dependencies({
      generate: vi.fn(async () => generated({}, cleanup)), load: vi.fn(async () => { throw new Error("sensitive"); }),
    }));
    stderr.mockRestore();
    expect(cleanup).toHaveBeenCalledTimes(1);
    const connected = await connect(prepared.server);
    const status = (await connected.client.callTool({ name: "status", arguments: {} })).structuredContent as any;
    expect(status.discovery).toMatchObject({ source: "generated-config", error: { code: "ODOOLS_GENERATED_ADAPTER_INVALID" } });
    await connected.client.close(); await connected.server.stop(); await connected.server.stop();
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it("retains success metadata and cleanup while backend remains lazy then starts once", async () => {
    const root = await mkdtemp(join(tmpdir(), "odools-diagnostic-success-")); roots.push(root);
    const binary = resolve("test/fixtures/fake-lsp.mjs"); await chmod(binary, 0o755);
    const configPath = join(root, "odools.toml"); const inputPath = join(root, "model.py"); const records = join(root, "records.jsonl");
    await writeFile(configPath, "[[config]]\nname='default'\ndisable_javascript=true\n"); await writeFile(inputPath, "value = 1\n");
    const config = await loadConfig({ workspace: root, binary, config: configPath, quietMs: 100, requestTimeoutMs: 500 });
    const cleanup = vi.fn(async () => {});
    const prepared = await prepareDiscoveryServer(root, undefined, undefined, dependencies({ generate: vi.fn(async () => generated({}, cleanup)), load: vi.fn(async () => config) }));
    expect(prepared.server).toBeInstanceOf(OdooLsMcpServer); expect(prepared.cleanup).toBe(cleanup);
    const connected = await connect(prepared.server);
    const status = (await connected.client.callTool({ name: "status", arguments: {} })).structuredContent as any;
    expect(status.state).toBe("dormant");
    expect(status.discovery).toEqual({ ...discovered(root).discovery, unknownConditionResolvedCount: 1_000_000 });
    expect(await readFile(records, "utf8").catch(() => "")).toBe("");
    process.env.FAKE_LSP_RECORD_FILE = records;
    try {
      await connected.client.callTool({ name: "definition", arguments: { path: inputPath, line: 1, column: 1 } });
      await connected.client.callTool({ name: "definition", arguments: { path: inputPath, line: 1, column: 1 } });
    } finally { delete process.env.FAKE_LSP_RECORD_FILE; await connected.client.close(); await connected.server.stop(); }
    const spawns = (await readFile(records, "utf8")).split("\n").filter((line) => line.includes('"event":"spawn"'));
    expect(spawns).toHaveLength(1); expect(cleanup).not.toHaveBeenCalled();
    await prepared.cleanup?.(); expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it("sanitizes unknown errors, bounds fields, and classifies recovery", () => {
    const diagnostic = createDiscoveryDiagnostic(new Error("https://user:password@example.invalid/" + "x".repeat(2_000)));
    expect(diagnostic.error.code).toBe("ODOOLS_DISCOVERY_FAILED"); expect(JSON.stringify(diagnostic)).not.toContain("password");
    expect(diagnostic.error.details).toEqual([]); expect(diagnostic.error.actions.length).toBeLessThanOrEqual(4); expect(safeDiscoverySummary(diagnostic).length).toBeLessThanOrEqual(320);
    expect(createDiscoveryDiagnostic(new DiscoveryError("ODOOLS_DISCOVERY_MISSING_GENERATED_STATE", "secret")).error.actions.join(" ")).toContain("invoke stop start");
    expect(createDiscoveryDiagnostic(new DiscoveryError("ODOOLS_DISCOVERY_AMBIGUOUS_ORDINARY_DUPLICATE", "secret")).error.actions.join(" ")).toContain("ambiguous");
    expect(createDiscoveryDiagnostic(new DiscoveryError("ODOOLS_DISCOVERY_ESCAPING_GENERATED_TARGET", "secret")).error).toMatchObject({ recoverable: false, retryAfterRestart: false });
  });
});
