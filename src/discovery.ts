import { createHash } from "node:crypto";
import { resolve, dirname, relative, basename, isAbsolute, sep } from "node:path";
import { access, constants, lstat, open, readdir, readlink, realpath, stat } from "node:fs/promises";
import { loadAll } from "js-yaml";
import type { DiscoveryMetadata, DiscoveredOdooWorkspace } from "./types.js";
import { commandOutput } from "./config.js";

const MAX_UPWARD_DEPTH = 12;
const MAX_GENERATED_ENTRIES = 10_000;
const MAX_WARNINGS = 20;
const MAX_MARKER_BYTES = 64 * 1024;
const MAX_ADDONS_YAML_BYTES = 1024 * 1024;
const MAX_ODOO_CONFIG_BYTES = 256 * 1024;
const MODULE_NAME = /^[A-Za-z0-9_]+$/;
let generatedMutationTestHook: ((attempt: number) => Promise<void>) | undefined;

/** Test seam for deterministic generated-namespace mutation coverage. */
export function setGeneratedMutationTestHook(hook?: (attempt: number) => Promise<void>): void {
  generatedMutationTestHook = hook;
}

export class DiscoveryError extends Error {
  constructor(public readonly code: string, detail: string) {
    super(`${code}: ${detail.slice(0, 500)}`);
    this.name = "DiscoveryError";
  }
}

async function isFile(path: string): Promise<boolean> {
  try { return (await stat(path)).isFile(); } catch { return false; }
}

async function isDirectory(path: string): Promise<boolean> {
  try { return (await stat(path)).isDirectory(); } catch { return false; }
}

async function isExecutable(path: string): Promise<boolean> {
  try { await access(path, constants.X_OK); return true; } catch { return false; }
}

async function readBounded(path: string, maximum: number, oversizedCode: string): Promise<string> {
  const info = await stat(path).catch(() => null);
  if (!info?.isFile()) throw new DiscoveryError(oversizedCode, `${basename(path)} is missing or not a regular file`);
  if (info.size > maximum) throw new DiscoveryError(oversizedCode, `${basename(path)} exceeds ${maximum} bytes`);
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(info.size);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.toString("utf8", 0, bytesRead);
  } finally {
    await handle.close();
  }
}

async function hasCoreMarkers(odooRoot: string): Promise<boolean> {
  return await isFile(resolve(odooRoot, "odoo-bin"))
    && await isFile(resolve(odooRoot, "odoo", "addons", "base", "__manifest__.py"));
}

function meaningfulYamlLines(content: string): string[] {
  return content.split(/\r?\n/).map((line) => line.replace(/\s+#.*$/, "").trim()).filter(Boolean);
}

function hasCopierTemplate(content: string): boolean {
  return meaningfulYamlLines(content).some((line) => {
    const match = line.match(/^_(?:template|src_path)\s*:\s*["']?([^"']+?)["']?\s*$/);
    if (!match) return false;
    return /^(?:(?:https:\/\/github\.com\/)|(?:gh:))?Tecnativa\/doodba-copier-template(?:\.git)?$/i.test(match[1]!.replace(/\/$/, ""));
  });
}

async function resolveAddonsConfig(src: string): Promise<string | null> {
  const yaml = resolve(src, "addons.yaml");
  if (await isFile(yaml)) return yaml;
  const yml = resolve(src, "addons.yml");
  return await isFile(yml) ? yml : null;
}

async function validateDoodbaRoot(root: string): Promise<boolean> {
  const src = resolve(root, "odoo", "custom", "src");
  if (!await isDirectory(src) || !await hasCoreMarkers(resolve(src, "odoo"))) return false;
  const copierPath = resolve(root, ".copier-answers.yml");
  if (!await isFile(copierPath)) return false;
  const copier = await readBounded(copierPath, MAX_MARKER_BYTES, "ODOOLS_DISCOVERY_OVERSIZED_MARKER");
  if (!hasCopierTemplate(copier)) return false;
  return await resolveAddonsConfig(src) !== null;
}

function within(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function findDoodbaRootFromSrc(path: string): string | null {
  return basename(path) === "src" && basename(dirname(path)) === "custom" && basename(dirname(dirname(path))) === "odoo"
    ? dirname(dirname(dirname(path))) : null;
}

async function findAuthoritativeWorkspace(startPath: string): Promise<{workspace: string; isDoodba: boolean; doodbaRoot: string | null}> {
  let current = resolve(startPath);
  for (let depth = 0; depth <= MAX_UPWARD_DEPTH; depth += 1) {
    if (await validateDoodbaRoot(current)) {
      return { workspace: resolve(current, "odoo", "custom", "src"), isDoodba: true, doodbaRoot: current };
    }
    const srcRoot = findDoodbaRootFromSrc(current);
    if (srcRoot && await validateDoodbaRoot(srcRoot)) return { workspace: current, isDoodba: true, doodbaRoot: srcRoot };
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  if (await hasCoreMarkers(startPath)) return { workspace: resolve(startPath), isDoodba: false, doodbaRoot: null };
  if (await hasCoreMarkers(resolve(startPath, "odoo"))) return { workspace: resolve(startPath), isDoodba: false, doodbaRoot: null };
  if (await isFile(resolve(startPath, "odoo-bin")) || await isDirectory(resolve(startPath, "odoo", "addons", "base"))) throw new Error(`incomplete core markers at ${startPath}`);
  const children = await readdir(startPath, { withFileTypes: true }).catch(() => []);
  const cores: string[] = [];
  for (const child of children) {
    if (child.isDirectory() && await hasCoreMarkers(resolve(startPath, child.name))) cores.push(resolve(startPath, child.name));
  }
  if (cores.length !== 1) throw new Error(cores.length ? `AC-DISC-02: Ambiguous Odoo core: ${cores.join(", ")}` : `no valid Odoo or Doodba workspace found from ${startPath}`);
  return { workspace: cores[0]!, isDoodba: false, doodbaRoot: null };
}

async function hasImmediateAddonManifest(root: string): Promise<boolean> {
  for (const entry of await readdir(root, { withFileTypes: true }).catch(() => [])) {
    if (entry.name === "__manifest__.py" && entry.isFile()) return true;
    if ((entry.isDirectory() || entry.isSymbolicLink()) && await isFile(resolve(root, entry.name, "__manifest__.py"))) return true;
  }
  return false;
}

async function discoverConventionalAddonRoots(workspace: string): Promise<string[]> {
  const roots: string[] = await hasCoreMarkers(workspace) ? [workspace] : [];
  for (const entry of await readdir(workspace, { withFileTypes: true })) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const candidate = await realpath(resolve(workspace, entry.name)).catch(() => "");
    if (candidate && within(candidate, workspace) && await hasImmediateAddonManifest(candidate)) roots.push(candidate);
  }
  return [...new Set(roots)].sort();
}

interface AddonSelection { repository: string; patterns: string[]; condition: "active" | "unknown" }
type YamlMapping = Record<string, unknown>;

function stringList(value: unknown, context: string): string[] {
  const values = Array.isArray(value) ? value : [value];
  if (!values.length || values.some((item) => typeof item !== "string")) {
    throw new DiscoveryError("ODOOLS_DISCOVERY_UNSUPPORTED_ADDONS_CONFIG", `${context} must be a string or list of strings`);
  }
  return values as string[];
}

function parseAddonsYaml(content: string, environment: NodeJS.ProcessEnv): AddonSelection[] {
  let documents: unknown[];
  try {
    documents = [];
    loadAll(content, (document) => documents.push(document), { json: true });
  } catch {
    throw new DiscoveryError("ODOOLS_DISCOVERY_UNSUPPORTED_ADDONS_CONFIG", "addons.yaml is not valid safe YAML");
  }
  const flattened = new Map<string, { active: Set<string>; unknown: Set<string> }>();
  for (const raw of documents) {
    if (raw === null || raw === undefined) continue;
    if (typeof raw !== "object" || Array.isArray(raw)) throw new DiscoveryError("ODOOLS_DISCOVERY_UNSUPPORTED_ADDONS_CONFIG", "each YAML document must be a mapping");
    const document = raw as YamlMapping;
    const only = document.ONLY ?? {};
    if (typeof only !== "object" || only === null || Array.isArray(only)) throw new DiscoveryError("ODOOLS_DISCOVERY_UNEVALUABLE_ONLY", "ONLY must be a mapping");
    let condition: "active" | "inactive" | "unknown" = "active";
    for (const [name, values] of Object.entries(only as YamlMapping)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new DiscoveryError("ODOOLS_DISCOVERY_UNEVALUABLE_ONLY", "ONLY contains an invalid environment name");
      const allowed = stringList(values, `ONLY.${name}`);
      const actual = environment[name];
      if (actual !== undefined && !allowed.includes(actual)) condition = "inactive";
      else if (actual === undefined && condition === "active") condition = "unknown";
    }
    if (condition === "inactive") continue;
    for (const [repository, patterns] of Object.entries(document)) {
      if (repository === "ONLY" || repository === "ENV") continue;
      const ordinary = repository !== "odoo/addons" && repository !== "private";
      if (!repository || (ordinary && (repository.includes("/") || repository.includes("\\") || repository === "." || repository === ".."))) throw new DiscoveryError("ODOOLS_DISCOVERY_UNSUPPORTED_ADDONS_CONFIG", `unsafe repository key ${repository}`);
      const bucket = flattened.get(repository) ?? { active: new Set<string>(), unknown: new Set<string>() };
      for (const pattern of stringList(patterns, repository)) bucket[condition].add(pattern);
      flattened.set(repository, bucket);
    }
  }
  return [...flattened].flatMap(([repository, patterns]) => [
    ...(patterns.active.size ? [{ repository, patterns: [...patterns.active], condition: "active" as const }] : []),
    ...(patterns.unknown.size ? [{ repository, patterns: [...patterns.unknown], condition: "unknown" as const }] : []),
  ]);
}

function globMatches(pattern: string, name: string): boolean {
  let expression = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index]!;
    if (char === "*") expression += pattern[index + 1] === "*" ? (index += 1, ".*") : ".*";
    else if (char === "?") expression += ".";
    else expression += char.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
  }
  return new RegExp(`${expression}$`).test(name);
}

async function moduleNames(root: string): Promise<string[]> {
  const names: string[] = [];
  for (const child of await readdir(root, { withFileTypes: true }).catch(() => [])) {
    if (child.isDirectory() && MODULE_NAME.test(child.name) && await isFile(resolve(root, child.name, "__manifest__.py"))) names.push(child.name);
  }
  return names.sort();
}

interface EligibleRoot { path: string; kind: "ordinary" | "private" | "core"; modules: Set<string>; activeModules: Set<string>; unknownModules: Set<string>; physicalModules: Set<string> }
interface GeneratedModule { name: string; source: string; root: string; kind: EligibleRoot["kind"] }

async function generatedFingerprint(directory: string): Promise<string> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => { throw new DiscoveryError("ODOOLS_DISCOVERY_MISSING_GENERATED_STATE", "odoo/auto/addons is missing or unreadable"); });
  if (entries.length > MAX_GENERATED_ENTRIES) throw new DiscoveryError("ODOOLS_DISCOVERY_UNSUPPORTED_GENERATED_STATE", `generated namespace exceeds ${MAX_GENERATED_ENTRIES} entries`);
  const hash = createHash("sha256");
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const path = resolve(directory, entry.name);
    const info = await lstat(path).catch(() => null);
    hash.update(`${entry.name}\0${info?.mode ?? "missing"}\0${info?.size ?? 0}\0${info?.mtimeMs ?? 0}\0`);
    if (info?.isSymbolicLink()) hash.update(await readlink(path).catch(() => "<unreadable>"));
  }
  return hash.digest("hex");
}

async function readGenerated(doodbaRoot: string, workspace: string, roots: EligibleRoot[]): Promise<GeneratedModule[]> {
  const configPath = resolve(doodbaRoot, "odoo", "auto", "odoo.conf");
  const config = await readBounded(configPath, MAX_ODOO_CONFIG_BYTES, "ODOOLS_DISCOVERY_OVERSIZED_GENERATED_CONFIG").catch((error: unknown) => {
    if (error instanceof DiscoveryError && error.message.includes("exceeds")) throw error;
    throw new DiscoveryError("ODOOLS_DISCOVERY_MISSING_GENERATED_STATE", "odoo/auto/odoo.conf is missing or unreadable");
  });
  const addonSetting = config.match(/^addons_path\s*=\s*(.+)$/m)?.[1]?.trim();
  if (!addonSetting) throw new DiscoveryError("ODOOLS_DISCOVERY_UNSUPPORTED_GENERATED_STATE", "generated odoo.conf has no addons_path");
  const containerPath = "/opt/odoo/auto/addons";
  const configured = addonSetting.split(",").map((item) => item.trim()).filter(Boolean);
  if (configured.length !== 1 || configured[0] !== containerPath) throw new DiscoveryError("ODOOLS_DISCOVERY_UNSUPPORTED_GENERATED_STATE", `addons_path must be exactly ${containerPath}`);
  const directory = resolve(doodbaRoot, "odoo", "auto", "addons");
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => { throw new DiscoveryError("ODOOLS_DISCOVERY_MISSING_GENERATED_STATE", "odoo/auto/addons is missing or unreadable"); });
  if (entries.length > MAX_GENERATED_ENTRIES) throw new DiscoveryError("ODOOLS_DISCOVERY_UNSUPPORTED_GENERATED_STATE", `generated namespace exceeds ${MAX_GENERATED_ENTRIES} entries`);
  const result: GeneratedModule[] = [];
  const seen = new Set<string>();
  const seenSources = new Set<string>();
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!MODULE_NAME.test(entry.name) || seen.has(entry.name)) throw new DiscoveryError("ODOOLS_DISCOVERY_DUPLICATE_EFFECTIVE_NAME", `invalid or duplicate generated module name ${entry.name}`);
    seen.add(entry.name);
    const link = resolve(directory, entry.name);
    const info = await lstat(link).catch(() => null);
    if (!info?.isSymbolicLink()) throw new DiscoveryError("ODOOLS_DISCOVERY_MALFORMED_GENERATED_TARGET", `generated entry ${entry.name} is not a symbolic link`);
    const source = await realpath(link).catch((error: NodeJS.ErrnoException) => {
      const code = error.code === "ELOOP" ? "ODOOLS_DISCOVERY_GENERATED_SYMLINK_LOOP" : "ODOOLS_DISCOVERY_BROKEN_GENERATED_TARGET";
      throw new DiscoveryError(code, `generated entry ${entry.name} cannot be resolved`);
    });
    if (!within(source, workspace)) throw new DiscoveryError("ODOOLS_DISCOVERY_ESCAPING_GENERATED_TARGET", `generated entry ${entry.name} escapes the source workspace`);
    if (basename(source) !== entry.name) throw new DiscoveryError("ODOOLS_DISCOVERY_GENERATED_NAME_MISMATCH", `generated entry ${entry.name} targets a differently named directory`);
    if (seenSources.has(source)) throw new DiscoveryError("ODOOLS_DISCOVERY_DUPLICATE_EFFECTIVE_NAME", `generated entry ${entry.name} duplicates a canonical module target`);
    seenSources.add(source);
    const manifest = resolve(source, "__manifest__.py");
    const manifestInfo = await lstat(manifest).catch(() => null);
    if (!manifestInfo?.isFile() || manifestInfo.isSymbolicLink()) throw new DiscoveryError("ODOOLS_DISCOVERY_MALFORMED_GENERATED_TARGET", `generated entry ${entry.name} has no regular non-symlink manifest`);
    await access(manifest, constants.R_OK).catch(() => { throw new DiscoveryError("ODOOLS_DISCOVERY_MALFORMED_GENERATED_TARGET", `generated entry ${entry.name} manifest is unreadable`); });
    const candidates = roots.filter((root) => within(source, root.path) && dirname(source) === root.path && root.modules.has(entry.name));
    if (candidates.length !== 1) throw new DiscoveryError("ODOOLS_DISCOVERY_CONFIG_GENERATED_MISMATCH", `generated entry ${entry.name} is not selected by addons.yaml`);
    result.push({ name: entry.name, source, root: candidates[0]!.path, kind: candidates[0]!.kind });
  }
  return result;
}

function topologicalRoots(required: Set<string>, edges: Map<string, Set<string>>): string[] {
  const incoming = new Map([...required].map((root) => [root, 0]));
  for (const [from, targets] of edges) for (const target of targets) if (from !== target) incoming.set(target, (incoming.get(target) ?? 0) + 1);
  const ready = [...required].filter((root) => incoming.get(root) === 0).sort();
  const ordered: string[] = [];
  while (ready.length) {
    const root = ready.shift()!;
    ordered.push(root);
    for (const target of [...(edges.get(root) ?? [])].sort()) {
      const count = incoming.get(target)! - 1;
      incoming.set(target, count);
      if (count === 0) { ready.push(target); ready.sort(); }
    }
  }
  if (ordered.length !== required.size) throw new DiscoveryError("ODOOLS_DISCOVERY_PRECEDENCE_CYCLE", "generated winners impose a repository precedence cycle");
  return ordered;
}

async function discoverDoodba(workspace: string, doodbaRoot: string): Promise<{addonRoots: string[]; metadata: DiscoveryMetadata}> {
  const addonsPath = await resolveAddonsConfig(workspace);
  if (!addonsPath) throw new DiscoveryError("ODOOLS_DISCOVERY_MISSING_ADDONS_CONFIG", "addons.yaml or addons.yml is missing");
  const addonsContent = await readBounded(addonsPath, MAX_ADDONS_YAML_BYTES, "ODOOLS_DISCOVERY_OVERSIZED_ADDONS_CONFIG").catch((error: unknown) => {
    if (error instanceof DiscoveryError && error.message.includes("exceeds")) throw error;
    throw new DiscoveryError("ODOOLS_DISCOVERY_MISSING_ADDONS_CONFIG", "addons.yaml is missing or unreadable");
  });
  const selections = parseAddonsYaml(addonsContent, process.env);
  const roots: EligibleRoot[] = [];
  const specialSelections = new Map<string, { active: Set<string>; unknown: Set<string> }>();
  for (const selection of selections.filter((item) => item.repository === "private" || item.repository === "odoo/addons")) {
    const aggregate = specialSelections.get(selection.repository) ?? { active: new Set<string>(), unknown: new Set<string>() };
    for (const pattern of selection.patterns) aggregate[selection.condition].add(pattern);
    specialSelections.set(selection.repository, aggregate);
  }
  for (const selection of selections.filter((item) => item.repository !== "private" && item.repository !== "odoo/addons")) {
    if (selection.repository === "odoo" || selection.repository.includes("/") || selection.repository.includes("\\")) throw new DiscoveryError("ODOOLS_DISCOVERY_UNSUPPORTED_ADDONS_CONFIG", `reserved or unsafe repository key ${selection.repository}`);
    const path = resolve(workspace, selection.repository);
    if (!await isDirectory(path)) {
      if (selection.condition === "unknown") continue;
      throw new DiscoveryError("ODOOLS_DISCOVERY_CONFIG_GENERATED_MISMATCH", `selected repository ${selection.repository} is absent`);
    }
    const canonicalPath = await realpath(path);
    const physicalModules = new Set(await moduleNames(canonicalPath));
    const modules = new Set([...physicalModules].filter((name) => selection.patterns.some((pattern) => globMatches(pattern, name))));
    const existing = roots.find((root) => root.path === canonicalPath);
    if (existing) {
      for (const module of modules) {
        existing.modules.add(module);
        existing[selection.condition === "active" ? "activeModules" : "unknownModules"].add(module);
      }
    } else {
      roots.push({ path: canonicalPath, kind: "ordinary", modules, activeModules: selection.condition === "active" ? new Set(modules) : new Set(), unknownModules: selection.condition === "unknown" ? new Set(modules) : new Set(), physicalModules });
    }
  }
  const privatePath = resolve(workspace, "private");
  if (await isDirectory(privatePath)) {
    const physicalModules = new Set(await moduleNames(privatePath));
    const configured = specialSelections.get("private");
    const activePatterns = configured ? [...configured.active] : ["*"];
    const unknownPatterns = [...(configured?.unknown ?? [])];
    const activeModules = new Set([...physicalModules].filter((name) => activePatterns.some((pattern) => globMatches(pattern, name))));
    const unknownModules = new Set([...physicalModules].filter((name) => unknownPatterns.some((pattern) => globMatches(pattern, name))));
    const modules = new Set([...activeModules, ...unknownModules]);
    roots.push({ path: await realpath(privatePath), kind: "private", modules, activeModules, unknownModules, physicalModules });
  }
  for (const corePath of [resolve(workspace, "odoo", "addons"), resolve(workspace, "odoo", "odoo", "addons")]) {
    if (await isDirectory(corePath)) {
      const physicalModules = new Set(await moduleNames(corePath));
      const configured = specialSelections.get("odoo/addons");
      const activePatterns = configured ? [...configured.active] : ["*"];
      const unknownPatterns = [...(configured?.unknown ?? [])];
      const activeModules = new Set([...physicalModules].filter((name) => activePatterns.some((pattern) => globMatches(pattern, name))));
      const unknownModules = new Set([...physicalModules].filter((name) => unknownPatterns.some((pattern) => globMatches(pattern, name))));
      const modules = new Set([...activeModules, ...unknownModules]);
      roots.push({ path: await realpath(corePath), kind: "core", modules, activeModules, unknownModules, physicalModules });
    }
  }

  const generatedDirectory = resolve(doodbaRoot, "odoo", "auto", "addons");
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const before = await generatedFingerprint(generatedDirectory);
    const generated = await readGenerated(doodbaRoot, workspace, roots);
    const reconciledNames = new Set(generated.map((module) => module.name));
    for (const root of roots.filter((candidate) => candidate.kind === "ordinary")) for (const name of root.activeModules) {
      if (!reconciledNames.has(name)) throw new DiscoveryError("ODOOLS_DISCOVERY_CONFIG_GENERATED_MISMATCH", `active configured module ${name} is absent from generated state`);
    }
    await generatedMutationTestHook?.(attempt);
    const after = await generatedFingerprint(generatedDirectory);
    if (before !== after) {
      if (attempt === 0) continue;
      throw new DiscoveryError("ODOOLS_DISCOVERY_UNSTABLE_GENERATED_STATE", "generated addon namespace changed during both reconciliation attempts");
    }
    const winnerByName = new Map(generated.map((module) => [module.name, module]));
    const required = new Set(generated.filter((module) => module.kind !== "core").map((module) => module.root));
    const exposedRoots = roots.filter((root) => root.kind === "core" || required.has(root.path));
    const physicalByName = new Map<string, EligibleRoot[]>();
    for (const root of exposedRoots) for (const name of root.physicalModules) physicalByName.set(name, [...(physicalByName.get(name) ?? []), root]);
    const edges = new Map<string, Set<string>>();
    let shadowedDuplicateCount = 0;
    for (const [name, candidates] of physicalByName) {
      if (candidates.length < 2) continue;
      const winner = winnerByName.get(name);
      const ordinary = candidates.filter((candidate) => candidate.kind !== "core");
      if (!winner && ordinary.length > 1) throw new DiscoveryError("ODOOLS_DISCOVERY_AMBIGUOUS_ORDINARY_DUPLICATE", `duplicate module ${name} has no trustworthy generated winner`);
      if (!winner) continue;
      shadowedDuplicateCount += candidates.length - 1;
      if (winner.kind === "core") continue;
      for (const candidate of ordinary) {
        if (candidate.path === winner.root) continue;
        const targets = edges.get(winner.root) ?? new Set<string>();
        targets.add(candidate.path);
        edges.set(winner.root, targets);
      }
    }
    const addonRoots = topologicalRoots(required, edges);
    const simulated = new Map<string, string>();
    const inactiveExposed: string[] = [];
    const generatedNames = new Set(generated.map((module) => module.name));
    for (const root of addonRoots) for (const name of await moduleNames(root)) {
      if (!simulated.has(name)) simulated.set(name, root);
      if (!generatedNames.has(name)) inactiveExposed.push(name);
    }
    for (const module of generated) {
      const actual = simulated.get(module.name);
      if (module.kind === "core") {
        if (actual !== undefined) throw new DiscoveryError("ODOOLS_DISCOVERY_WINNER_MISMATCH", `OdooLS would shadow core winner ${module.name}`);
      } else if (actual !== module.root) {
        throw new DiscoveryError("ODOOLS_DISCOVERY_WINNER_MISMATCH", `OdooLS would select a different source for ${module.name}`);
      }
    }
    const unknownConditionResolvedCount = generated.filter((module) => roots.some((root) => root.path === module.root && root.unknownModules.has(module.name) && !root.activeModules.has(module.name))).length;
    const warnings = [
      ...(unknownConditionResolvedCount ? [`${unknownConditionResolvedCount} modules with unknown ONLY conditions were resolved from generated state`] : []),
      ...inactiveExposed.map((name) => `inactive module ${name} is unavoidably exposed by a required repository root`),
    ];
    return {
      addonRoots,
      metadata: {
        mode: "doodba-reconciled",
        source: "addons.yaml+odoo/auto/odoo.conf",
        status: "ready",
        effectiveModuleCount: generated.length,
        effectiveRootCount: addonRoots.length,
        shadowedDuplicateCount,
        inactiveExposedCount: inactiveExposed.length,
        unknownConditionResolvedCount,
        generatedFingerprint: after,
        warnings: warnings.slice(0, MAX_WARNINGS),
        warningsTruncated: warnings.length > MAX_WARNINGS,
      },
    };
  }
  throw new DiscoveryError("ODOOLS_DISCOVERY_UNSTABLE_GENERATED_STATE", "generated addon namespace did not stabilize");
}

async function resolvePython(workspace: string, explicit?: string): Promise<string> {
  if (explicit) {
    const candidate = isAbsolute(explicit) ? explicit : resolve(workspace, explicit);
    if (!await isExecutable(candidate)) throw new Error(`Python executable is not executable: ${candidate}`);
    return realpath(candidate);
  }
  const venv = resolve(workspace, ".venv", "bin", "python");
  if (await isExecutable(venv)) return realpath(venv);
  const found = await commandOutput("sh", ["-c", `command -v python3`]).catch(() => "");
  if (!found || !await isExecutable(found.trim())) throw new Error("Unable to resolve python3");
  return realpath(found.trim());
}

export async function discoverWorkspace(startPath: string, pythonOverride?: string, runtimeDir?: string): Promise<DiscoveredOdooWorkspace> {
  void runtimeDir;
  const found = await findAuthoritativeWorkspace(startPath);
  const workspace = await realpath(found.workspace);
  const conventionalCore = !found.isDoodba && !await hasCoreMarkers(workspace) ? resolve(workspace, "odoo") : workspace;
  const odooPath = await realpath(found.isDoodba ? resolve(workspace, "odoo") : conventionalCore);
  if (!await hasCoreMarkers(odooPath)) throw new Error(`Invalid Odoo core at ${odooPath}`);
  const doodba = found.isDoodba
    ? await discoverDoodba(workspace, found.doodbaRoot!)
    : { addonRoots: await discoverConventionalAddonRoots(workspace), metadata: { mode: "conventional", source: "filesystem", status: "ready" } as DiscoveryMetadata };
  if (!found.isDoodba && !doodba.addonRoots.length) throw new Error("Discovery requires at least one immediate addon repository");
  return { workspace, odooPath, addonRoots: doodba.addonRoots, isDoodba: found.isDoodba, python: await resolvePython(workspace, pythonOverride), discovery: doodba.metadata };
}
