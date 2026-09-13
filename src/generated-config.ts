import { access, constants, lstat, mkdir, mkdtemp, writeFile, rm, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import type { DiscoveredOdooWorkspace, GeneratedOdooConfig } from "./types.js";
import { verifyRuntime } from "./runtime/manager.js";
import { ENGINE_VERSION } from "./config.js";

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
): Promise<GeneratedOdooConfig> {
  const runtimeDir = runtimeDirOverride || resolve(
    process.env.XDG_DATA_HOME || resolve(process.env.HOME || "~", ".local", "share"),
    "odools-mcp",
    `runtime-${ENGINE_VERSION}`,
  );
  const runtime = await verifyRuntime(runtimeDir);
  const stdlibPath = resolve(runtimeDir, "typeshed", "stdlib");
  if (!(await stat(stdlibPath).catch(() => undefined))?.isDirectory()) {
    throw new Error(`OdooLS stdlib directory is missing: ${stdlibPath}`);
  }
  const runtimeBase = process.env.XDG_RUNTIME_DIR || tmpdir();
  await mkdir(runtimeBase, { recursive: true, mode: 0o700 });
  const tempDir = await mkdtemp(resolve(runtimeBase, "odools-config-"));
  try {
    if (((await stat(tempDir)).mode & 0o777) !== 0o700) {
      throw new Error(`Temp dir mode not 0700: ${tempDir}`);
    }
    const tomlPath = resolve(tempDir, "odools.toml");
    const shimPath = resolve(tempDir, "tsserver");
    await writeFile(
      shimPath,
      `#!/bin/sh\nexec ${safeShellArgument(runtime.tsserver)} "$@"\n`,
      { mode: 0o700 },
    );
    const shimInfo = await lstat(shimPath);
    await access(shimPath, constants.X_OK);
    if (!shimInfo.isFile() || shimInfo.isSymbolicLink()) {
      throw new Error(`Generated tsserver shim is not a regular executable: ${shimPath}`);
    }
    await writeFile(
      tomlPath,
      generateOdooToml(discovery, shimPath, stdlibPath),
      { mode: 0o600 },
    );
    const adapter = {
      workspace: discovery.workspace,
      runtimeDir,
      config: tomlPath,
      profile: "default",
      allowedRoots: discovery.addonRoots,
      tsserverVersion: "6.0.2" as const,
    };
    const cleanup = async (): Promise<void> => {
      try {
        await rm(tempDir, { recursive: true, force: true });
      } catch (error) {
        console.warn(`odools-mcp: temp config cleanup failed for ${tempDir}:`, error);
      }
    };
    return { adapter, tomlPath, cleanup };
  } catch (error) {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}
