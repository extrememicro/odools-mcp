import { access, constants, lstat, mkdir, mkdtemp, writeFile, rm, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import type { DiscoveredOdooWorkspace, GeneratedOdooConfig } from "./types.js";
import { verifyRuntime } from "./runtime/manager.js";
import { ENGINE_VERSION } from "./config.js";

export type GeneratedConfigFailureStage = "runtime" | "temporary-config";

export class GeneratedConfigError extends Error {
  constructor(public readonly stage: GeneratedConfigFailureStage, public readonly code: string) {
    super(code);
    this.name = "GeneratedConfigError";
  }
}

export interface GeneratedConfigDependencies {
  verify: typeof verifyRuntime;
  makeTempDirectory: typeof mkdtemp;
  write: typeof writeFile;
}

const defaults: GeneratedConfigDependencies = { verify: verifyRuntime, makeTempDirectory: mkdtemp, write: writeFile };

function safeTomlString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`;
}

function safeShellArgument(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export function generateOdooToml(
  discovery: DiscoveredOdooWorkspace,
  shimPath: string,
  stdlibPath: string,
): string {
  const addonPaths = discovery.addonRoots.map(safeTomlString).join(", ");
  // Keys and types match OdooLS 1.5.2, commit ec189919c30ab0ece0d63410695e6a49d891a821.
  return `[[config]]
name = "default"
odoo_path = ${safeTomlString(discovery.odooPath)}
addons_paths = [${addonPaths}]
python_path = ${safeTomlString(discovery.python)}
disable_javascript = false
stdlib = ${safeTomlString(stdlibPath)}
tsserver_command = ${safeTomlString(shimPath)}
ts_check = false
disable_semantic_tokens_python = true
disable_semantic_tokens_javascript = true
disable_semantic_tokens_xml = true
`;
}

export async function generateOdooConfig(
  discovery: DiscoveredOdooWorkspace,
  runtimeDirOverride?: string,
  dependencies: GeneratedConfigDependencies = defaults,
): Promise<GeneratedOdooConfig> {
  const runtimeDir = runtimeDirOverride || resolve(
    process.env.XDG_DATA_HOME || resolve(process.env.HOME || "~", ".local", "share"),
    "odools-mcp",
    `runtime-${ENGINE_VERSION}`,
  );
  const runtime = await dependencies.verify(runtimeDir).catch(() => {
    throw new GeneratedConfigError("runtime", "ODOOLS_RUNTIME_CONFIGURATION_FAILED");
  });
  let tempDir: string | undefined;
  try {
    const stdlibPath = resolve(runtimeDir, "typeshed", "stdlib");
    if (!(await stat(stdlibPath).catch(() => undefined))?.isDirectory()) throw new Error("Missing runtime stdlib");
    const runtimeBase = process.env.XDG_RUNTIME_DIR || tmpdir();
    await mkdir(runtimeBase, { recursive: true, mode: 0o700 });
    tempDir = await dependencies.makeTempDirectory(resolve(runtimeBase, "odools-config-"));
    if (((await stat(tempDir)).mode & 0o777) !== 0o700) throw new Error("Unsafe temporary directory mode");
    const tomlPath = resolve(tempDir, "odools.toml");
    const shimPath = resolve(tempDir, "tsserver");
    await dependencies.write(shimPath, `#!/bin/sh\nexec ${safeShellArgument(runtime.tsserver)} "$@"\n`, { mode: 0o700 });
    const shimInfo = await lstat(shimPath);
    await access(shimPath, constants.X_OK);
    if (!shimInfo.isFile() || shimInfo.isSymbolicLink()) throw new Error("Unsafe generated shim");
    await dependencies.write(tomlPath, generateOdooToml(discovery, shimPath, stdlibPath), { mode: 0o600 });
    const adapter = { workspace: discovery.workspace, runtimeDir, config: tomlPath, profile: "default", allowedRoots: discovery.addonRoots, tsserverVersion: "6.0.2" as const };
    const ownedTempDir = tempDir;
    const cleanup = async (): Promise<void> => { await rm(ownedTempDir, { recursive: true, force: true }).catch(() => {}); };
    return { adapter, tomlPath, cleanup };
  } catch (error) {
    if (tempDir) await rm(tempDir, { recursive: true, force: true }).catch(() => {});
    if (error instanceof GeneratedConfigError) throw error;
    throw new GeneratedConfigError("temporary-config", "ODOOLS_TEMP_CONFIG_GENERATION_FAILED");
  }
}
