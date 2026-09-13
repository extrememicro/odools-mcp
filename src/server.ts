import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { z } from "zod";
import { ENGINE_CHANNEL, ENGINE_VERSION, type AdapterConfig } from "./config.js";
import { LspSession } from "./lsp/session.js";
import { Navigator } from "./navigation.js";

const inputSchema = { path: z.string().min(1), line: z.number().int().positive(), column: z.number().int().positive() };
const provenanceSchema = {
  engine: z.literal("OdooLS"), version: z.literal(ENGINE_VERSION), channel: z.literal(ENGINE_CHANNEL),
  positionEncoding: z.literal("utf-16"), snippets: z.literal(false),
};
const stateSchema = z.enum(["dormant", "activating", "indexing", "restarting", "ready", "degraded", "failed", "stopping", "stopped"]);
const pointSchema = z.object({ line: z.number().int().positive(), column: z.number().int().positive() });
const locationSchema = z.object({ root: z.string().regex(/^(workspace|addon-[1-9][0-9]*)$/), rootPath: z.string().min(1), range: z.object({ start: pointSchema, end: pointSchema }) });
const statusOutputSchema = {
  ...provenanceSchema, workspace: z.string(), typescript: z.object({ path: z.string().nullable(), version: z.string().nullable() }),
  activationPolicy: z.literal("on-semantic-tool"), backendProcessState: stateSchema,
  state: stateSchema, coreReady: z.boolean(), javascriptReady: z.boolean(), javascriptState: z.enum(["disabled", "pending", "ready", "unavailable"]),
  loading: z.boolean(), progressActive: z.number().int().nonnegative(), configurationSeen: z.boolean(), configurationDiagnostics: z.array(z.string()),
  javascriptDiagnostics: z.array(z.string()), fatalConfiguration: z.boolean(), processAlive: z.boolean(), lastActivityAt: z.number(),
  automaticRestart: z.boolean(), restartCount: z.number().int().nonnegative(), lastCrash: z.string().nullable(), lastError: z.string().nullable(),
  watcherEnabled: z.boolean(), watcherState: z.enum(["disabled", "starting", "watching", "stopped", "failed"]), watcherError: z.string().nullable(), watcherDocumentCount: z.number().int().nonnegative(), maxWatcherDocuments: z.number().int().nonnegative(), fallback: z.string(),
};
const navigationOutputSchema = {
  ...provenanceSchema, state: stateSchema, returned: z.number().int().nonnegative(), truncated: z.boolean(), locations: z.array(locationSchema),
  noResult: z.boolean(), coldStart: z.boolean().optional(), startupDurationMs: z.number().int().nonnegative().optional(), error: z.string().nullable(), fallback: z.string().nullable(),
};
const provenance = { engine: "OdooLS", version: ENGINE_VERSION, channel: ENGINE_CHANNEL, positionEncoding: "utf-16", snippets: false } as const;

function response(data: Record<string, unknown>, isError = false) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data) }], structuredContent: data, isError };
}

export class OdooLsMcpServer {
  readonly lsp: LspSession;
  readonly mcp = new McpServer({ name: "@pyming/odools-mcp", version: "0.1.0" });
  private readonly navigator: Navigator;
  private mcpConnected = false;
  private mcpClosed = false;

  constructor(private readonly config: AdapterConfig) {
    this.lsp = new LspSession(config); this.navigator = new Navigator(config, this.lsp);
    this.mcp.registerTool("odools_status", {
      description: "Report truthful OdooLS core/JavaScript readiness and pinned runtime provenance", inputSchema: {}, outputSchema: statusOutputSchema,
    }, async () => {
      const snapshot = this.lsp.readiness.snapshot();
      return response({
      ...provenance, workspace: this.config.workspace, typescript: { path: this.config.tsserverPath ?? null, version: this.config.tsserverVersion ?? null },
      activationPolicy: "on-semantic-tool", backendProcessState: snapshot.state,
      ...snapshot, fallback: "Use exact search/read while semantic readiness is unavailable.",
    }); });
    for (const [name, method] of Object.entries({ odools_definition: "textDocument/definition", odools_declaration: "textDocument/declaration", odools_references: "textDocument/references" }) as Array<[string, "textDocument/definition" | "textDocument/declaration" | "textDocument/references"]>) {
      this.mcp.registerTool(name, { description: `Resolve precise Odoo-aware ${name.slice(7)} locations`, inputSchema, outputSchema: navigationOutputSchema }, async (args, extra) => {
        try {
          const result = await this.navigator.call(method, args.path, args.line, args.column, extra.signal);
          return response({ ...provenance, state: this.lsp.readiness.snapshot().state, ...result, noResult: result.returned === 0, error: null, fallback: result.returned ? null : "Verify the exact position with read/grep; this relationship may be unsupported by OdooLS." });
        } catch (error) {
          return response({ ...provenance, state: this.lsp.readiness.snapshot().state, returned: 0, truncated: false, locations: [], noResult: false, error: String(error), fallback: "Check odools_status, configuration and path; use exact search/read until ready." }, true);
        }
      });
    }
  }

  async start(transport: Transport = new StdioServerTransport()): Promise<void> {
    try { await this.mcp.connect(transport); this.mcpConnected = true; }
    catch (error) {
      try { await this.lsp.stop(); }
      catch (cleanupError) { throw new AggregateError([error, cleanupError], "MCP connect and LSP cleanup failed"); }
      throw error;
    }
  }
  cancelStart(): void { void this.lsp.stop().catch(() => undefined); }

  async stop(): Promise<void> {
    const errors: unknown[] = [];
    if (this.mcpConnected && !this.mcpClosed) {
      this.mcpClosed = true;
      try { await this.mcp.close(); } catch (error) { errors.push(error); }
    }
    try { await this.lsp.stop(); } catch (error) { errors.push(error); }
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, "MCP and LSP shutdown failed");
  }
}
