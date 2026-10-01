import { access, constants, lstat, readFile, realpath } from "node:fs/promises";
import { parse as parseToml } from "smol-toml";
import { delimiter, dirname, resolve } from "node:path";
import { spawn } from "node:child_process";
import { z } from "zod";
import { PathGuard } from "./security/path-guard.js";
import { verifyRuntime } from "./runtime/manager.js";

export const ENGINE_VERSION = "1.5.2";
export const ENGINE_CHANNEL = "beta";

const schema = z.object({
  workspace: z.string().min(1),
  runtimeDir: z.string().min(1).optional(),
  binary: z.string().min(1).optional(),
  config: z.string().min(1),
  logsDirectory: z.string().min(1).optional(),
  profile: z.string().min(1).default("default"),
  tsserver: z.string().min(1).optional(),
  tsserverVersion: z.literal("6.0.2").optional(),
  allowedRoots: z.array(z.string().min(1)).default([]),
  requestTimeoutMs: z.number().int().min(100).max(120_000).default(15_000),
  startupTimeoutMs: z.number().int().min(1_000).max(300_000).default(120_000),
  quietMs: z.number().int().min(100).max(10_000).default(1_500),
  maxLocations: z.number().int().nonnegative().max(1000).default(100),
  restartMaxAttempts: z.number().int().nonnegative().max(10).default(1),
  restartWindowMs: z.number().int().nonnegative().max(3_600_000).default(60_000),
  restartBackoffMs: z.number().int().nonnegative().max(30_000).default(250),
  watcherEnabled: z.boolean().default(true),
  watcherDebounceMs: z.number().int().nonnegative().max(10_000).default(100),
  maxWatcherDocuments: z.number().int().nonnegative().max(10_000).default(256),
});
export type AdapterConfig = Omit<z.infer<typeof schema>, "binary"> & { binary: string; guard: PathGuard; tsserverPath?: string };

export async function commandOutput(command: string, args: string[], signal?: AbortSignal): Promise<string> {
  return await new Promise((resolvePromise, reject) => {
    if (signal?.aborted) { reject(new Error("cancelled")); return; }
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let output = ""; let settled = false;
    const finish = (error?: Error) => {
      if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener("abort", abort);
      if (error) reject(error);
      else resolvePromise(output.trim());
    };
    const timer = setTimeout(() => { child.kill("SIGKILL"); finish(new Error(`${command} version check timed out`)); }, 5_000);
    const abort = () => { child.kill("SIGKILL"); finish(new Error("cancelled")); };
    signal?.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (chunk) => { if (output.length < 16_384) output += String(chunk).slice(0, 16_384 - output.length); });
    child.stderr.on("data", (chunk) => { if (output.length < 16_384) output += String(chunk).slice(0, 16_384 - output.length); });
    child.once("error", (error) => finish(error));
    child.once("close", (code) => code === 0 ? finish() : finish(new Error(`${command} version check failed (${code}): ${output.trim()}`)));
  });
}

export async function loadConfig(raw: unknown): Promise<AdapterConfig> {
  const parsed = schema.parse(raw);
  if (!parsed.runtimeDir && !parsed.binary) throw new Error("Config requires binary or runtimeDir");
  if (parsed.runtimeDir && (parsed.binary || parsed.tsserver)) throw new Error("Managed runtimeDir cannot be combined with binary or tsserver");
  const managed = parsed.runtimeDir ? await verifyRuntime(parsed.runtimeDir) : undefined;
  const binaryInput = managed?.binary ?? parsed.binary!;
  const tsserverInput = managed?.tsserver ?? parsed.tsserver;
  if (parsed.logsDirectory) {
    const rawLogsInfo = await lstat(parsed.logsDirectory);
    if (!rawLogsInfo.isDirectory() || rawLogsInfo.isSymbolicLink()) throw new Error("logsDirectory must be a non-symlink directory");
  }
  const [workspace, binary, configPath, logsDirectory, ...extraRoots] = await Promise.all([
    realpath(parsed.workspace), realpath(binaryInput), realpath(parsed.config), parsed.logsDirectory ? realpath(parsed.logsDirectory) : Promise.resolve(undefined), ...parsed.allowedRoots.map((root) => realpath(root)),
  ]);
  await Promise.all([access(binary, constants.X_OK), access(configPath, constants.R_OK)]);
  if (logsDirectory) {
    await access(logsDirectory, constants.R_OK | constants.W_OK | constants.X_OK);
    const inside = (root: string) => { const value = resolve(logsDirectory); const prefix = `${resolve(root)}${process.platform === "win32" ? "\\" : "/"}`; return value === resolve(root) || value.startsWith(prefix); };
    if (inside(workspace) || inside(dirname(binary)) || (parsed.runtimeDir && inside(await realpath(parsed.runtimeDir)))) throw new Error("logsDirectory must be outside workspace and managed runtime");
  }
  const profileDocument = parseToml(await readFile(configPath, "utf8")) as { config?: Array<Record<string, unknown>> };
  const profiles = profileDocument.config;
  if (!Array.isArray(profiles) || profiles.length === 0) throw new Error("OdooLS config must define at least one [[config]] profile");
  const selected = profiles.find((profile) => profile.name === parsed.profile);
  if (!selected) throw new Error(`OdooLS profile ${parsed.profile} does not exist`);
  for (const key of ["$version", "odoo_path", "python_path", "stdlib"] as const) {
    if (typeof selected[key] === "string" && selected[key]) await access(String(selected[key]));
  }
  if (selected.addons_paths !== undefined) {
    if (!Array.isArray(selected.addons_paths)) throw new Error("addons_paths must be an array");
    await Promise.all(selected.addons_paths.map((path) => access(String(path))));
  }
  if (tsserverInput && selected.disable_javascript === true) throw new Error("tsserver is configured but the selected OdooLS profile disables JavaScript");
  if (!tsserverInput && selected.disable_javascript !== true) throw new Error("JavaScript-enabled profile requires an explicitly pinned tsserver");
  const version = await commandOutput(binary, ["--version"]);
  if (!new RegExp(`\\b${ENGINE_VERSION.replaceAll(".", "\\.")}\\b`).test(version)) {
    throw new Error(`OdooLS runtime mismatch: expected ${ENGINE_VERSION}, got ${version}`);
  }
  let tsserverPath: string | undefined;
  if (tsserverInput) {
    tsserverPath = await realpath(tsserverInput);
    const packagePath = resolve(dirname(dirname(tsserverPath)), "package.json");
    const packageJson = JSON.parse(await readFile(packagePath, "utf8")) as { version?: string };
    if (packageJson.version !== "6.0.2" || (!managed && parsed.tsserverVersion !== "6.0.2")) throw new Error("tsserver must be pinned and verified as 6.0.2");
  }
  const roots = [workspace, ...extraRoots];
  return { ...parsed, workspace, binary, config: configPath, logsDirectory, allowedRoots: roots, guard: await PathGuard.create(workspace, roots), tsserverPath };
}

export function childEnvironment(config: AdapterConfig): NodeJS.ProcessEnv {
  if (!config.tsserverPath) return { ...process.env };
  const bin = dirname(config.tsserverPath);
  return { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH ?? ""}` };
}
