import { resolve, dirname, relative, basename, isAbsolute, delimiter } from "node:path";
import { access, constants, readdir, stat, realpath, open } from "node:fs/promises";
import type { DiscoveredOdooWorkspace } from "./types.js";
import { commandOutput } from "./config.js";

const BOUNDED_READ_BYTES = 4096;
const MAX_UPWARD_DEPTH = 12;

async function isFile(p: string): Promise<boolean> {
  try {
    const s = await stat(p);
    return s.isFile();
  } catch {
    return false;
  }
}

async function isDirectory(p: string): Promise<boolean> {
  try {
    const s = await stat(p);
    return s.isDirectory();
  } catch {
    return false;
  }
}

async function isExecutable(p: string): Promise<boolean> {
  try {
    await access(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function safeReadBounded(p: string, maxBytes = BOUNDED_READ_BYTES): Promise<string> {
  let fd;
  try {
    fd = await open(p, "r");
    const buffer = Buffer.alloc(maxBytes);
    const { bytesRead } = await fd.read(buffer, 0, maxBytes, 0);
    return buffer.toString("utf8", 0, bytesRead);
  } catch {
    return "";
  } finally {
    if (fd) await fd.close().catch(() => {});
  }
}

async function hasCoreMarkers(odooRoot: string): Promise<boolean> {
  const bin = resolve(odooRoot, "odoo-bin");
  const manifest = resolve(odooRoot, "odoo", "addons", "base", "__manifest__.py");
  return (await isFile(bin)) && (await isFile(manifest));
}

function meaningfulYamlLines(content: string): string[] {
  return content.split(/\r?\n/).map((line) => line.replace(/\s+#.*$/, "").trim()).filter(Boolean);
}

function hasCopierTemplate(content: string): boolean {
  for (const line of meaningfulYamlLines(content)) {
    const match = line.match(/^_template\s*:\s*["']?([^"']+?)["']?\s*$/);
    if (!match) continue;
    const value = match[1]!.replace(/\/$/, "");
    if (/^(?:https:\/\/github\.com\/)?Tecnativa\/doodba-copier-template(?:\.git)?$/i.test(value)) return true;
  }
  return false;
}

function hasRepositoryEntries(content: string): boolean {
  return meaningfulYamlLines(content).some((line) => /^(?:[A-Za-z0-9_.-]+\s*:|[-]\s+(?:https?:\/\/|git@))/i.test(line));
}

function hasAddonEntries(content: string): boolean {
  return meaningfulYamlLines(content).some((line) => /^(?:[A-Za-z0-9_.-]+\s*:\s*(?:\[|true|false|[A-Za-z0-9_.-]+)|[-]\s+[A-Za-z0-9_.-]+)/i.test(line));
}

async function hasDoodbaEvidence(root: string): Promise<boolean> {
  if (hasCopierTemplate(await safeReadBounded(resolve(root, ".copier-answers.yml")))) return true;
  const src = resolve(root, "odoo", "custom", "src");
  const reposPath = await isFile(resolve(root, "repos.yaml")) ? resolve(root, "repos.yaml") : resolve(src, "repos.yaml");
  const addonsPath = await isFile(resolve(root, "addons.yaml")) ? resolve(root, "addons.yaml") : resolve(src, "addons.yaml");
  return hasRepositoryEntries(await safeReadBounded(reposPath)) && hasAddonEntries(await safeReadBounded(addonsPath));
}

async function hasImmediateAddonManifest(dir: string): Promise<boolean> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const manifest = resolve(dir, entry.name, "__manifest__.py");
        if (await isFile(manifest)) return true;
      } else if (entry.name === "__manifest__.py") {
        return true;
      }
    }
  } catch {
    // ignore permission or non-dir errors during structural validation
  }
  return false;
}

async function discoverAddonRoots(workspaceInput: string): Promise<string[]> {
  const workspace = await realpath(workspaceInput);
  const entries = await readdir(workspace, { withFileTypes: true });
  const potential: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const candidate = resolve(workspace, entry.name);
    let real: string;
    try {
      real = await realpath(candidate);
    } catch {
      continue;
    }
    // Repair 9: containment with relative component semantics on canonical paths. Internal symlink addon roots use canonical target consistently; external reject.
    const rel = relative(workspace, real);
    if (rel.startsWith("..") || rel.includes("/../") || rel === "..") {
      continue; // external reject
    }
    if (await hasImmediateAddonManifest(real)) {
      potential.push(real);
    }
  }
  const uniqueSorted = [...new Set(potential)].sort();
  return uniqueSorted;
}

async function resolvePython(doodbaRoot: string | null, cliPython?: string): Promise<string> {
  if (cliPython) {
    let resolved = cliPython;
    if (!isAbsolute(cliPython)) {
      resolved = resolve(process.cwd(), cliPython); // explicit relative resolved intentionally per repair
    }
    if (!(await isExecutable(resolved))) {
      throw new Error(`Provided --python is not executable: ${cliPython}`);
    }
    const canonical = await realpath(resolved);
    await probePython(canonical);
    return canonical;
  }
  if (doodbaRoot) {
    const venv = resolve(doodbaRoot, ".venv", "bin", "python");
    if (await isExecutable(venv)) {
      const canonical = await realpath(venv);
      await probePython(canonical);
      return canonical;
    }
  }
  // Resolve PATH ourselves: "command" is a shell builtin and cannot be spawned portably.
  for (const entry of (process.env.PATH || "").split(delimiter)) {
    if (!entry) continue;
    const candidate = resolve(entry, "python3");
    if (await isExecutable(candidate)) {
      const canonical = await realpath(candidate);
      await probePython(canonical);
      return canonical;
    }
  }
  throw new Error("Python 3 executable not found on PATH");
}

async function probePython(python: string): Promise<void> {
  // Bounded probe, no project modules; uses shared commandOutput (5s timeout)
  try {
    const output = await commandOutput(python, ["--version"]);
    if (!output.toLowerCase().includes("python 3")) {
      throw new Error(`Python version probe failed: ${output}`);
    }
  } catch (error) {
    throw new Error(`Python probe failed for ${python}: ${String(error)}`);
  }
}

async function findAuthoritativeWorkspace(startPath: string): Promise<{workspace: string; isDoodba: boolean; doodbaRoot: string | null}> {
  let current = resolve(startPath);
  const home = process.env.HOME || "/";
  const visited = new Set<string>();

  // AC-DISC-01: discovers active Doodba worktree from nested locations; selects exactly <root>/odoo/custom/src
  // never nearest nested Git or canonical/main checkout. Walks up bounded by HOME.
  let depth = 0;
  while (!visited.has(current) && depth++ < MAX_UPWARD_DEPTH) {
    visited.add(current);
    // Check for Doodba root containing odoo/custom/src with markers
    const srcCandidate = resolve(current, "odoo", "custom", "src");
    if (await isDirectory(srcCandidate)) {
      const corePath = resolve(srcCandidate, "odoo");
      if (await hasCoreMarkers(corePath) && await hasDoodbaEvidence(current)) {
        return { workspace: srcCandidate, isDoodba: true, doodbaRoot: current };
      }
    }
    // If invocation is already under odoo/custom/src ancestor with core markers
    const srcAncestor = findSrcAncestor(current);
    if (srcAncestor && await hasCoreMarkers(resolve(srcAncestor, "odoo")) && await hasDoodbaEvidence(findDoodbaRootFromSrc(srcAncestor))) {
      return { workspace: srcAncestor, isDoodba: true, doodbaRoot: findDoodbaRootFromSrc(srcAncestor) };
    }
    const parent = dirname(current);
    if (parent === current || relative(home, current).startsWith("..")) {
      break;
    }
    current = parent;
  }

  // AC-DISC-02: absent Doodba evidence, custom/src-shaped trees may still be conservative
  // conventional multi-repository workspaces when exactly one immediate child is core and
  // at least one other immediate child is a structurally valid addon repository.
  const exactSrc = findSrcAncestor(resolve(startPath)) === resolve(startPath);
  // AC-DISC-02: conservative conventional Odoo support - direct core or enclosing immediate-child tree only with exactly one valid core
  if (await hasCoreMarkers(startPath)) {
    return { workspace: resolve(startPath), isDoodba: false, doodbaRoot: null };
  }
  const children = await readdir(startPath, { withFileTypes: true }).catch(() => []);
  const cores: string[] = [];
  for (const child of children) {
    if (child.isDirectory()) {
      const cp = resolve(startPath, child.name);
      if (await hasCoreMarkers(cp)) cores.push(cp);
    }
  }
  if (cores.length === 1) {
    if (exactSrc) {
      let addonRepositoryCount = 0;
      for (const child of children) {
        const childPath = resolve(startPath, child.name);
        if (child.isDirectory() && childPath !== cores[0] && await hasImmediateAddonManifest(childPath)) addonRepositoryCount++;
      }
      if (addonRepositoryCount === 0) throw new Error("AC-DISC-04: custom/src conventional workspace requires at least one immediate addon repository");
      return { workspace: resolve(startPath), isDoodba: false, doodbaRoot: null };
    }
    return { workspace: cores[0]!, isDoodba: false, doodbaRoot: null };
  }
  if (cores.length > 1) {
    throw new Error("AC-DISC-02: ambiguous multiple valid Odoo cores");
  }

  if (await isFile(resolve(startPath, "odoo-bin")) || await isFile(resolve(startPath, "odoo", "addons", "base", "__manifest__.py"))) {
    throw new Error("AC-DISC-04: incomplete core markers");
  }
  throw new Error("AC-DISC-04: no valid Odoo or Doodba workspace discovered (non-Odoo, incomplete, or no coherent evidence)");
}

function findSrcAncestor(path: string): string | null {
  let curr = resolve(path);
  for (let i = 0; i < 10; i++) { // bound depth to prevent infinite
    if (
      basename(curr) === "src" &&
      basename(dirname(curr)) === "custom" &&
      basename(dirname(dirname(curr))) === "odoo"
    ) return curr;
    const parent = dirname(curr);
    if (parent === curr) return null;
    curr = parent;
  }
  return null;
}

function findDoodbaRootFromSrc(srcPath: string): string {
  // from odoo/custom/src -> go up 3 levels to doodba root
  return resolve(srcPath, "..", "..", "..");
}


export async function discoverWorkspace(
  workspaceDir = process.cwd(),
  pythonOverride?: string,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _runtimeDirOverride?: string
): Promise<DiscoveredOdooWorkspace> {
  const found = await findAuthoritativeWorkspace(workspaceDir);
  const workspace = await realpath(found.workspace);
  const { isDoodba, doodbaRoot } = found;

  const conventionalChildCore = !isDoodba && !await hasCoreMarkers(workspace) ? resolve(workspace, "odoo") : workspace;
  const odooPath = await realpath(isDoodba ? resolve(workspace, "odoo") : conventionalChildCore);
  if (!await hasCoreMarkers(odooPath)) {
    throw new Error("AC-DISC-04: incomplete core markers");
  }

  let addonRoots = await discoverAddonRoots(workspace);
  if (addonRoots.length === 0 && !isDoodba) {
    // Repair 4: conventional core uses canonical <odooPath>/odoo/addons ; realistic fixture no fake <core>/addons (AC-DISC-02, inspected odoo-ls tag for core structure)
    const addonsPath = resolve(odooPath, "odoo", "addons");
    if (await isDirectory(addonsPath)) {
      const realAddons = await realpath(addonsPath);
      addonRoots = [realAddons];
    }
  }
  if (addonRoots.length === 0) {
    throw new Error("AC-DISC-04: standalone-addon-only not supported");
  }

  const python = await resolvePython(doodbaRoot, pythonOverride);

  // AC-DISC-03 validated by construction (immediate, canonical via realpath, sorted, inside, no escapes)

  return {
    workspace,
    odooPath,
    addonRoots,
    isDoodba,
    python,
  };
}
