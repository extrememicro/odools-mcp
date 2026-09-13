#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { loadConfig } from "./config.js";
import { installRuntime, verifyRuntime, type PreseedAssets } from "./runtime/manager.js";
import { LifecycleCoordinator, ShutdownCoordinator } from "./lifecycle.js";
import { OdooLsMcpServer } from "./server.js";
import { discoverWorkspace } from "./discovery.js";
import { generateOdooConfig } from "./generated-config.js";
import type { GeneratedOdooConfig } from "./types.js";

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

async function serve(args: string[]): Promise<void> {
  const lifecycle = new LifecycleCoordinator();
  let cleanupTemp: (() => Promise<void>) | undefined;
  let cleaned = false;
  let stopRequested = false;

  const doCleanup = async () => {
    if (cleanupTemp && !cleaned) {
      cleaned = true; // idempotent shared cleanup
      await cleanupTemp().catch((e) => process.stderr.write(`odools-mcp cleanup: ${String(e)}\n`));
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
    let config: any;
    if (parsed.configPath) {
      // Preserve serve --config <adapter.json> unchanged (AC contract)
      const raw = JSON.parse(await readFile(resolve(parsed.configPath), "utf8")) as unknown;
      config = await loadConfig(raw);
    } else {
      // Discovery mode - AC-DISC-01 to AC-DISC-05
      const ws = parsed.workspace || process.cwd();
      const discovered = await discoverWorkspace(ws, parsed.python, parsed.runtimeDir);
      const generated: GeneratedOdooConfig = await generateOdooConfig(discovered, parsed.runtimeDir);
      cleanupTemp = generated.cleanup; // capture ownership before any later operation can fail
      if (stopRequested) { await doCleanup(); return; }
      config = await loadConfig(generated.adapter);
    }
    await lifecycle.start(new OdooLsMcpServer(config));
  } catch (error) {
    await doCleanup(); // startup failures clean immediately
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
