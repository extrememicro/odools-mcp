#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { loadConfig } from "./config.js";
import { installRuntime, verifyRuntime, type PreseedAssets } from "./runtime/manager.js";
import { LifecycleCoordinator, ShutdownCoordinator } from "./lifecycle.js";
import { DiagnosticMcpServer, OdooLsMcpServer } from "./server.js";
import { discoverWorkspace } from "./discovery.js";
import { createDiscoveryDiagnostic, safeDiscoverySummary } from "./diagnostic.js";
import { generateOdooConfig, GeneratedConfigError } from "./generated-config.js";
import type { DiscoveredOdooWorkspace, GeneratedOdooConfig } from "./types.js";

function option(args: string[], name: string, required = false): string | undefined {
  const index = args.indexOf(name); const value = index >= 0 ? args[index + 1] : undefined;
  if (required && (!value || value.startsWith("--"))) throw new Error(`${name} requires a value`);
  return value;
}

export function parseServeArgs(args: string[]): {
  useDiscovery: boolean;
  configPath?: string;
  workspace?: string;
  python?: string;
  runtimeDir?: string;
} {
  // Repair 5: strict single-pass parser; rejects duplicate/unknown/positional/missing-value/value-as-flag/cross-mode. Preserves install/verify parsers (option fn). Tested in discovery.test.ts for all cases. Inspected odoo-ls CLI behavior for profile/config.
  let useDiscovery = false;
  let configPath: string | undefined;
  let workspace: string | undefined;
  let python: string | undefined;
  let runtimeDir: string | undefined;
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (!arg.startsWith("--")) {
      throw new Error(`Positional argument not allowed: ${arg}`);
    }
    if (seen.has(arg)) {
      throw new Error(`Duplicate flag: ${arg}`);
    }
    seen.add(arg);
    if (arg === "--discover-workspace") {
      useDiscovery = true;
      continue;
    }
    if (!["--config", "--workspace", "--python", "--runtime-dir"].includes(arg)) {
      throw new Error(`Unknown flag: ${arg}`);
    }
    const valueIndex = i + 1;
    if (valueIndex >= args.length || args[valueIndex]!.startsWith("--")) {
      throw new Error(`${arg} requires a value (missing or value-as-flag)`);
    }
    const value = args[valueIndex]!;
    i++; // consume value
    if (arg === "--config") configPath = value;
    else if (arg === "--workspace") workspace = value;
    else if (arg === "--python") python = value;
    else runtimeDir = value;
  }
  if (useDiscovery && configPath) {
    throw new Error("--config and --discover-workspace are mutually exclusive");
  }
  if (!useDiscovery && !configPath) {
    throw new Error("serve requires either --config <adapter.json> or --discover-workspace");
  }
  if (configPath && (workspace || python || runtimeDir)) {
    throw new Error("--config cannot be combined with discovery-only flags");
  }
  return { useDiscovery, configPath, workspace, python, runtimeDir };
}

export interface DiscoveryServerDependencies {
  discover: typeof discoverWorkspace;
  generate: typeof generateOdooConfig;
  load: typeof loadConfig;
}

const discoveryServerDefaults: DiscoveryServerDependencies = { discover: discoverWorkspace, generate: generateOdooConfig, load: loadConfig };

export async function prepareDiscoveryServer(
  workspace: string,
  python?: string,
  runtimeDir?: string,
  dependencies: DiscoveryServerDependencies = discoveryServerDefaults,
): Promise<{ server: OdooLsMcpServer | DiagnosticMcpServer; cleanup?: () => Promise<void> }> {
  let discovered: DiscoveredOdooWorkspace;
  try {
    discovered = await dependencies.discover(workspace, python, runtimeDir);
  } catch (error) {
    return diagnosticPreparation(error, "filesystem");
  }

  let generated: GeneratedOdooConfig;
  try {
    generated = await dependencies.generate(discovered, runtimeDir);
  } catch (error) {
    const source = error instanceof GeneratedConfigError && error.stage === "temporary-config" ? "generated-config" : "runtime";
    return diagnosticPreparation(error, source);
  }

  try {
    const config = await dependencies.load(generated.adapter);
    return { server: new OdooLsMcpServer(config, discovered.discovery), cleanup: generated.cleanup };
  } catch (error) {
    await generated.cleanup().catch(() => process.stderr.write("[odools-mcp] temporary discovery cleanup failed safely\n"));
    return diagnosticPreparation(error, "generated-config");
  }
}

function diagnosticPreparation(error: unknown, source: "filesystem" | "runtime" | "generated-config") {
  const diagnostic = createDiscoveryDiagnostic(error, source);
  process.stderr.write(`[odools-mcp] ${safeDiscoverySummary(diagnostic)}\n`);
  return { server: new DiagnosticMcpServer(diagnostic) };
}

async function serve(args: string[]): Promise<void> {
  const lifecycle = new LifecycleCoordinator();
  let cleanupTemp: (() => Promise<void>) | undefined;
  let cleaned = false;
  let stopRequested = false;

  const doCleanup = async () => {
    if (cleanupTemp && !cleaned) {
      cleaned = true; // idempotent shared cleanup
      await cleanupTemp().catch(() => process.stderr.write("[odools-mcp] temporary discovery cleanup failed safely\n"));
    }
  };

  const shutdown = new ShutdownCoordinator(() => lifecycle.shutdown(), doCleanup);
  const requestStop = (): Promise<void> => { stopRequested = true; return shutdown.request(); };

  process.once("SIGINT", requestStop);
  process.once("SIGTERM", requestStop);
  process.stdin.once("end", requestStop);
  process.once("beforeExit", requestStop);

  const parsed = parseServeArgs(args);

  try {
    let server: OdooLsMcpServer | DiagnosticMcpServer;
    if (parsed.configPath) {
      // Preserve serve --config <adapter.json> unchanged (AC contract)
      const raw = JSON.parse(await readFile(resolve(parsed.configPath), "utf8")) as unknown;
      server = new OdooLsMcpServer(await loadConfig(raw));
    } else {
      const prepared = await prepareDiscoveryServer(parsed.workspace || process.cwd(), parsed.python, parsed.runtimeDir);
      server = prepared.server;
      cleanupTemp = prepared.cleanup;
      if (stopRequested) { await doCleanup(); return; }
    }
    await lifecycle.start(server);
  } catch (error) {
    await doCleanup();
    throw error;
  }
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (command === "--help" || command === "-h") {
    process.stdout.write("Usage: odools-mcp <serve|install-runtime|verify-runtime> [options]\n");
    process.stdout.write("  serve [--config <adapter.json> | --discover-workspace [--workspace <path>] [--python <path>] [--runtime-dir <path>]]\n");
    process.stdout.write("    (discovery uses pinned 1.5.2 odoo-ls from inspected tag; strict parser rejects all invalid combos per repair 5)\n");
    return;
  }
  if (command === "--version" || command === "-v") {
    process.stdout.write("0.1.0\n");
    return;
  }
  if (command === "serve") return serve(args);
  if (command === "verify-runtime") {
    const runtimeDir = option(args, "--runtime-dir", true)!;
    const paths = await verifyRuntime(runtimeDir);
    process.stdout.write(`${JSON.stringify({ status: "verified", runtimeDir: resolve(runtimeDir), binary: paths.binary, tsserver: paths.tsserver })}\n`);
    return;
  }
  if (command === "install-runtime") {
    const version = option(args, "--version", true)!; const runtimeDir = option(args, "--runtime-dir", true)!;
    const values = [option(args, "--odools-archive"), option(args, "--typeshed-archive"), option(args, "--typescript-archive")];
    if (values.some(Boolean) && !values.every(Boolean)) throw new Error("Offline preseed requires all three archive options");
    const preseed: PreseedAssets | undefined = values.every(Boolean) ? { odools: values[0]!, typeshed: values[1]!, typescript: values[2]! } : undefined;
    const paths = await installRuntime({ version, runtimeDir, preseed });
    process.stdout.write(`${JSON.stringify({ status: "installed", version, runtimeDir: resolve(runtimeDir), binary: paths.binary, tsserver: paths.tsserver, offline: Boolean(preseed) })}\n`);
    return;
  }
  throw new Error("Usage: odools-mcp <serve|install-runtime|verify-runtime> [options]");
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`odools-mcp: ${message}\n`); process.exitCode = 1;
});
