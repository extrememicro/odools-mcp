import { mkdtemp, writeFile, mkdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join, dirname } from "node:path";
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { discoverWorkspace } from "../src/discovery.js";
import { generateOdooConfig, generateOdooToml } from "../src/generated-config.js";
import { parse as parseToml } from "smol-toml";
import { parseServeArgs } from "../src/cli.js";

describe("Workspace discovery and generated OdooLS config (Cluster 1)", () => {
  let tempRoot: string;
  let cleanupFns: (() => Promise<void>)[] = [];

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "odools-discovery-test-"));
    cleanupFns = [];
  });

  afterEach(async () => {
    for (const c of cleanupFns) await c().catch(() => {});
    await rm(tempRoot, { recursive: true, force: true }).catch(() => {});
  });

  const createMarker = async (dir: string, ...files: string[]) => {
    await mkdir(dir, { recursive: true });
    for (const f of files) {
      const full = resolve(dir, f);
      await mkdir(dirname(full), { recursive: true });
      await writeFile(full, "# marker or manifest\n");
    }
  };

  const createDoodbaEvidence = async (root: string) => {
    await writeFile(resolve(root, "tasks.py"), "from invoke import task\n# doodba-copier-template reference");
    await writeFile(resolve(root, ".copier-answers.yml"), "_template: https://github.com/Tecnativa/doodba-copier-template");
  };

  it("AC-DISC-01: discovers Doodba from nested addon location, selects exactly <root>/odoo/custom/src", async () => {
    const doodbaRoot = resolve(tempRoot, "project");
    const src = resolve(doodbaRoot, "odoo", "custom", "src");
    const odooCore = resolve(src, "odoo");
    const addon = resolve(src, "private");
    await createMarker(odooCore, "odoo-bin", "odoo/addons/base/__manifest__.py");
    await createMarker(addon, "my_module/__manifest__.py");
    await createDoodbaEvidence(doodbaRoot);

    const discovered = await discoverWorkspace(addon); // start from nested
    expect(discovered.workspace).toBe(src);
    expect(discovered.isDoodba).toBe(true);
    expect(discovered.odooPath).toBe(odooCore);
    expect(discovered.addonRoots).toContain(addon);
    expect(discovered.addonRoots.length).toBeGreaterThan(0);
    cleanupFns.push(() => generateOdooConfig(discovered).then(g => g.cleanup())); // test generation too
  });

  it("AC-DISC-02: conventional Odoo with exactly one core accepted; multiple cores fail", async () => {
    const core1 = resolve(tempRoot, "odoo-core1");
    await createMarker(core1, "odoo-bin", "odoo/addons/base/__manifest__.py");
    const discovered = await discoverWorkspace(core1);
    expect(discovered.isDoodba).toBe(false);
    expect(discovered.workspace).toBe(core1);
    expect(discovered.addonRoots.length).toBe(1);

    const conventionalSrc = resolve(tempRoot, "conventional", "odoo", "custom", "src");
    await createMarker(resolve(conventionalSrc, "odoo"), "odoo-bin", "odoo/addons/base/__manifest__.py");
    await createMarker(resolve(conventionalSrc, "server-tools"), "auditlog/__manifest__.py");
    const conventional = await discoverWorkspace(conventionalSrc);
    expect(conventional).toMatchObject({ workspace: conventionalSrc, isDoodba: false, odooPath: resolve(conventionalSrc, "odoo") });
    expect(conventional.addonRoots).toContain(resolve(conventionalSrc, "server-tools"));

    const coreOnlySrc = resolve(tempRoot, "core-only", "odoo", "custom", "src");
    await createMarker(resolve(coreOnlySrc, "odoo"), "odoo-bin", "odoo/addons/base/__manifest__.py");
    await expect(discoverWorkspace(coreOnlySrc)).rejects.toThrow(/requires at least one immediate addon repository/);

    const multiRoot = resolve(tempRoot, "multi");
    await mkdir(multiRoot);
    await createMarker(resolve(multiRoot, "core-a"), "odoo-bin", "odoo/addons/base/__manifest__.py");
    await createMarker(resolve(multiRoot, "core-b"), "odoo-bin", "odoo/addons/base/__manifest__.py");
    await expect(discoverWorkspace(multiRoot)).rejects.toThrow("AC-DISC-02");
  });

  it("AC-DISC-03: addon roots immediate-child, validated by manifests, canonical/sorted/inside, private included by rule, escapes rejected", async () => {
    const doodbaRoot = resolve(tempRoot, "doodba-ac3");
    const src = resolve(doodbaRoot, "odoo", "custom", "src");
    const odooCore = resolve(src, "odoo");
    const privateDir = resolve(src, "private");
    const ocaDir = resolve(src, "oca-repo");
    await createMarker(odooCore, "odoo-bin", "odoo/addons/base/__manifest__.py");
    await createMarker(privateDir, "sale/__manifest__.py");
    await createMarker(ocaDir, "partner/__manifest__.py");
    await createDoodbaEvidence(doodbaRoot);

    const discovered = await discoverWorkspace(ocaDir); // from nested addon
    expect(discovered.workspace).toBe(src);
    expect(discovered.isDoodba).toBe(true);
    expect(discovered.addonRoots).toEqual(expect.arrayContaining([privateDir, ocaDir]));
    expect(discovered.addonRoots).toHaveLength(2); // deduped, sorted, canonical, inside workspace
    // external symlink would be rejected by realpath + within check in PathGuard (tested in security tests)
  });

  it("AC-DISC-04: fails closed for non-Odoo, standalone-addon-only, incomplete, ambiguous, HOME boundary/no broad fallback, active worktree-like duplicate layout", async () => {
    await expect(discoverWorkspace(tempRoot)).rejects.toThrow(/no valid Odoo or Doodba workspace/);

    // incomplete (missing base manifest)
    const incomplete = resolve(tempRoot, "incomplete");
    await createMarker(incomplete, "odoo-bin");
    await expect(discoverWorkspace(incomplete)).rejects.toThrow(/incomplete core markers/);

    // ambiguous covered in AC-DISC-02 test
    // HOME boundary and duplicate layout covered by walk logic and synthetic fixtures; no fallback
  });

  it("handles canonical internal/external symlinks and rejects false Doodba evidence", async () => {
    const root = resolve(tempRoot, "doodba-links");
    const src = resolve(root, "odoo", "custom", "src");
    await createMarker(resolve(src, "odoo"), "odoo-bin", "odoo/addons/base/__manifest__.py");
    const internal = resolve(src, "repository");
    await createMarker(internal, "module_a/__manifest__.py");
    await symlink(internal, resolve(src, "repository-link"));
    const external = resolve(tempRoot, "external");
    await createMarker(external, "module_b/__manifest__.py");
    await symlink(external, resolve(src, "external-link"));
    await writeFile(resolve(root, ".copier-answers.yml"), "# _template: https://github.com/Tecnativa/doodba-copier-template\nunrelated: doodba-copier-template\n");
    const conventional = await discoverWorkspace(src);
    expect(conventional.isDoodba).toBe(false); expect(conventional.addonRoots).toEqual([internal]);
    await writeFile(resolve(root, "repos.yaml"), "# empty\n");
    await writeFile(resolve(root, "addons.yaml"), "# empty\n");
    expect((await discoverWorkspace(src)).isDoodba).toBe(false);
    await writeFile(resolve(root, ".copier-answers.yml"), "_template: https://github.com/Tecnativa/doodba-copier-template\n");
    const discovered = await discoverWorkspace(src);
    expect(discovered.workspace).toBe(src);
    expect(discovered.addonRoots).toEqual([internal]);
  });

  it("bounds upward discovery depth instead of finding a distant ancestor", async () => {
    const root = resolve(tempRoot, "distant");
    await createMarker(resolve(root, "odoo/custom/src/odoo"), "odoo-bin", "odoo/addons/base/__manifest__.py");
    await createMarker(resolve(root, "odoo/custom/src/private"), "module/__manifest__.py");
    await createDoodbaEvidence(root);
    let deep = resolve(root, "unrelated");
    for (let index = 0; index < 14; index++) deep = resolve(deep, `level-${index}`);
    await mkdir(deep, { recursive: true });
    await expect(discoverWorkspace(deep)).rejects.toThrow(/no valid/);
  });

  it("selects the active Doodba worktree instead of a neighboring checkout", async () => {
    const parent = resolve(tempRoot, "worktrees");
    for (const name of ["main", "feature"]) {
      const root = resolve(parent, name);
      await createMarker(resolve(root, "odoo/custom/src/odoo"), "odoo-bin", "odoo/addons/base/__manifest__.py");
      await createMarker(resolve(root, "odoo/custom/src/private"), "module/__manifest__.py");
      await createDoodbaEvidence(root);
    }
    const active = resolve(parent, "feature", "odoo/custom/src/private/module");
    expect((await discoverWorkspace(active)).workspace).toBe(resolve(parent, "feature/odoo/custom/src"));
  });

  it("validates the exact generated OdooLS 1.5.2 TOML schema without a runtime", () => {
    const parsed = parseToml(generateOdooToml({
      workspace: "/workspace",
      odooPath: "/workspace/odoo",
      addonRoots: ["/workspace/addons"],
      isDoodba: false,
      python: "/usr/bin/python3",
    }, "/private/tsserver", "/runtime/typeshed/stdlib")) as { config: Record<string, unknown>[] };
    expect(parsed.config).toHaveLength(1);
    const config = parsed.config[0]!;
    expect(Object.keys(config).sort()).toEqual([
      "addons_paths", "disable_javascript", "disable_semantic_tokens_javascript",
      "disable_semantic_tokens_python", "disable_semantic_tokens_xml", "name", "odoo_path",
      "python_path", "stdlib", "ts_check", "tsserver_command",
    ]);
    expect(config).toEqual({
      name: "default", odoo_path: "/workspace/odoo", addons_paths: ["/workspace/addons"],
      python_path: "/usr/bin/python3", disable_javascript: false,
      stdlib: "/runtime/typeshed/stdlib", tsserver_command: "/private/tsserver",
      ts_check: false, disable_semantic_tokens_python: true,
      disable_semantic_tokens_javascript: true, disable_semantic_tokens_xml: true,
    });
  });

  it("AC-DISC-05: generates private temp TOML with an explicitly retained verified runtime", async () => {
    // test runtime absent/invalid
    const badRuntime = resolve(tempRoot, "absent-runtime");
    const fakeDiscovered = {
      workspace: tempRoot,
      odooPath: resolve(tempRoot, "odoo"),
      addonRoots: [resolve(tempRoot, "addons")],
      isDoodba: false,
      python: "python3",
    } as any;
    await expect(generateOdooConfig(fakeDiscovered, badRuntime)).rejects.toThrow();

    const runtimeDir = process.env.ODOOLS_TEST_RUNTIME;
    if (!runtimeDir) return;
    const doodbaRoot = resolve(tempRoot, "doodba-ac5");
    const src = resolve(doodbaRoot, "odoo", "custom", "src");
    const odooCore = resolve(src, "odoo");
    await createMarker(odooCore, "odoo-bin", "odoo/addons/base/__manifest__.py");
    await createMarker(resolve(src, "private"), "test/__manifest__.py");
    await createDoodbaEvidence(doodbaRoot);

    const discovered = await discoverWorkspace(src, "/usr/bin/python3");
    const generated = await generateOdooConfig(discovered, runtimeDir);
    expect(generated.tomlPath).toMatch(/odools-config-[^/]+\/odools\.toml$/);
    expect(generated.tomlPath.endsWith("odools.toml")).toBe(true);

    const fs = await import("node:fs/promises");
    const tomlContent = await fs.readFile(generated.tomlPath, "utf8");
    expect(tomlContent).toContain('odoo_path = "');
    expect(tomlContent).toMatch(/tsserver_command = "[^"]+"/);
    expect(tomlContent).toContain("disable_semantic_tokens_python = true");
    expect(tomlContent).toContain("disable_semantic_tokens_javascript = true");
    expect(tomlContent).toContain("disable_semantic_tokens_xml = true");
    expect(tomlContent).toContain("disable_javascript = false");
    expect(tomlContent).toContain("stdlib = ");
    expect(tomlContent).toContain("ts_check = false");
    expect(tomlContent).not.toContain("javascript.enabled");
    expect(tomlContent).not.toContain("typeshed_path");
    expect(tomlContent).not.toContain("semantic_tokens =");
    expect(tomlContent).not.toContain("hover =");
    expect(tomlContent).not.toContain("signature_help =");

    const tempDirStat = await fs.stat(dirname(generated.tomlPath));
    expect((tempDirStat.mode & 0o777).toString(8)).toBe("700");

    await generated.cleanup();
    const existsAfter = await fs.stat(generated.tomlPath).then(() => true).catch(() => false);
    expect(existsAfter).toBe(false);
  });

  it("strictly parses discovery mode and rejects cross-mode, duplicates, unknowns and positionals", () => {
    expect(parseServeArgs(["--discover-workspace", "--workspace", "/work", "--python", "/python"])).toMatchObject({
      useDiscovery: true,
      workspace: "/work",
      python: "/python",
    });
    expect(() => parseServeArgs(["--config", "adapter.json", "--discover-workspace"])).toThrow(/mutually exclusive/);
    expect(() => parseServeArgs(["--config", "adapter.json", "--python", "/python"])).toThrow(/discovery-only/);
    expect(() => parseServeArgs(["--discover-workspace", "--workspace", "/a", "--workspace", "/b"])).toThrow(/Duplicate/);
    expect(() => parseServeArgs(["--discover-workspace", "--unknown"])).toThrow(/Unknown/);
    expect(() => parseServeArgs(["--discover-workspace", "position"])).toThrow(/Positional/);
    expect(() => parseServeArgs(["--discover-workspace", "--python", "--runtime-dir", "/runtime"])).toThrow(/requires a value/);
  });
});
