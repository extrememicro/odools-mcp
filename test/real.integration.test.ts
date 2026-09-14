import { access } from "node:fs/promises";
import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { verifyRuntime } from "../src/runtime/manager.js";
import { discoverWorkspace } from "../src/discovery.js";
import { generateOdooConfig } from "../src/generated-config.js";
import { OdooLsMcpServer } from "../src/server.js";
import type { GeneratedOdooConfig } from "../src/types.js";

const enabled = process.env.ODOOLS_REAL_INTEGRATION === "1";
const suite = enabled ? describe : describe.skip;

suite("real generated discovery OdooLS integration", () => {
  let generated: GeneratedOdooConfig | undefined;
  let server: OdooLsMcpServer | undefined;
  let client: Client | undefined;

  afterAll(async () => {
    await client?.close();
    await server?.stop();
    await generated?.cleanup();
  });

  it("discovers, generates, loads and starts pinned OdooLS to readiness", async () => {
    const workspace = resolve(process.env.ODOOLS_REAL_WORKSPACE ?? "");
    const runtimeDir = resolve(process.env.ODOOLS_REAL_RUNTIME ?? "");
    await access(resolve(runtimeDir, "odoo_ls_server"));
    const discovery = await discoverWorkspace(workspace, process.env.ODOOLS_REAL_PYTHON);
    generated = await generateOdooConfig(discovery, runtimeDir);
    const config = await loadConfig({
      ...generated.adapter,
      startupTimeoutMs: 180_000,
      requestTimeoutMs: 30_000,
      quietMs: 1_500,
    });
    expect(config.binary).toBe(resolve(runtimeDir, "odoo_ls_server"));

    server = new OdooLsMcpServer(config);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "generated-integration", version: "1" });
    await Promise.all([server.start(serverTransport), client.connect(clientTransport)]);
    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name).sort()).toEqual([
      "declaration",
      "definition",
      "references",
      "status",
    ]);
    const dormant = (await client.callTool({ name: "status", arguments: {} })).structuredContent as Record<string, unknown>;
    expect(dormant).toMatchObject({ state: "dormant", processAlive: false, watcherDocumentCount: 0 });
    expect(server.lsp.childPid).toBeUndefined();
    const semanticPath = process.env.ODOOLS_REAL_SEMANTIC_PATH;
    const semanticLine = Number(process.env.ODOOLS_REAL_SEMANTIC_LINE ?? "0");
    const semanticColumn = Number(process.env.ODOOLS_REAL_SEMANTIC_COLUMN ?? "1");
    if (!semanticPath || semanticLine < 1) throw new Error("Set ODOOLS_REAL_SEMANTIC_PATH and ODOOLS_REAL_SEMANTIC_LINE for real integration");
    const definition = await client.callTool({ name: "definition", arguments: { path: semanticPath, line: semanticLine, column: semanticColumn } });
    expect(definition.isError).not.toBe(true); expect(server.lsp.childPid).toBeTypeOf("number");
    const activatedPid = server.lsp.childPid;
    const references = await client.callTool({ name: "references", arguments: { path: semanticPath, line: semanticLine, column: semanticColumn } });
    expect(references.isError).not.toBe(true); expect(server.lsp.childPid).toBe(activatedPid);
    let ready: Record<string, unknown> | undefined; const deadline = Date.now() + 30_000;
    do {
      await new Promise((settle) => setTimeout(settle, 250));
      ready = (await client.callTool({ name: "status", arguments: {} })).structuredContent as Record<string, unknown>;
    } while (!ready.coreReady && Date.now() < deadline);
    expect(ready.coreReady).toBe(true);
    await expect(verifyRuntime(runtimeDir)).resolves.toMatchObject({ binary: resolve(runtimeDir, "odoo_ls_server") });
    await client.close(); client = undefined; await server.stop(); server = undefined; await generated.cleanup(); generated = undefined;
    await expect(verifyRuntime(runtimeDir)).resolves.toMatchObject({ binary: resolve(runtimeDir, "odoo_ls_server") });
  }, 210_000);
});
