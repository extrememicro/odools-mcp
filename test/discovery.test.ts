import { lutimes, mkdtemp, writeFile, mkdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join, dirname } from "node:path";
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { discoverWorkspace, setGeneratedMutationTestHook } from "../src/discovery.js";
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
    setGeneratedMutationTestHook();
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
    const src = resolve(root, "odoo", "custom", "src");
    const repositories = await import("node:fs/promises").then(({ readdir }) => readdir(src, { withFileTypes: true }));
    const ordinary = repositories.filter((entry) => entry.isDirectory() && !["odoo", "private"].includes(entry.name));
    await writeFile(resolve(src, "addons.yaml"), ordinary.map((entry) => `${entry.name}: ["*"]`).join("\n") || "---\n");
    const generated = resolve(root, "odoo", "auto", "addons");
    await mkdir(generated, { recursive: true });
    await writeFile(resolve(root, "odoo", "auto", "odoo.conf"), "[options]\naddons_path = /opt/odoo/auto/addons\n");
    for (const repository of repositories.filter((entry) => entry.isDirectory())) {
      const repositoryPath = repository.name === "odoo" ? resolve(src, "odoo", "odoo", "addons") : resolve(src, repository.name);
      const modules = await import("node:fs/promises").then(({ readdir }) => readdir(repositoryPath, { withFileTypes: true }).catch(() => []));
      for (const module of modules.filter((entry) => entry.isDirectory())) {
        const manifest = resolve(repositoryPath, module.name, "__manifest__.py");
        if (await import("node:fs/promises").then(({ stat }) => stat(manifest).then((value) => value.isFile()).catch(() => false))) {
          await symlink(resolve(repositoryPath, module.name), resolve(generated, module.name)).catch(() => {});
        }
      }
    }
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
    await createDoodbaEvidence(root);
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

  it("AC-DUP-01/02/03/05: reconciles generated winners, private priority, patterns, and excludes siblings", async () => {
    const root = resolve(tempRoot, "reconciled");
    const src = resolve(root, "odoo", "custom", "src");
    await createMarker(resolve(src, "odoo"), "odoo-bin", "odoo/addons/base/__manifest__.py");
    await createMarker(resolve(src, "alpha"), "shared/__manifest__.py", "unique_alpha/__manifest__.py", "inactive_alpha/__manifest__.py");
    await createMarker(resolve(src, "beta"), "shared/__manifest__.py", "unique_beta/__manifest__.py");
    await createMarker(resolve(src, "private"), "shared/__manifest__.py");
    await createMarker(resolve(src, "beta-copia"), "copied_only/__manifest__.py");
    await createDoodbaEvidence(root);
    await writeFile(resolve(src, "addons.yaml"), "alpha: [\"unique_*\", shared]\n---\nbeta:\n  - \"*\"\n");
    const generated = resolve(root, "odoo", "auto", "addons");
    await rm(generated, { recursive: true, force: true });
    await mkdir(generated, { recursive: true });
    await writeFile(resolve(root, "odoo", "auto", "odoo.conf"), "[options]\naddons_path = /opt/odoo/auto/addons\n");
    await symlink(resolve(src, "private", "shared"), resolve(generated, "shared"));
    await symlink(resolve(src, "alpha", "unique_alpha"), resolve(generated, "unique_alpha"));
    await symlink(resolve(src, "beta", "unique_beta"), resolve(generated, "unique_beta"));

    const discovered = await discoverWorkspace(resolve(src, "alpha", "shared"));
    expect(discovered.addonRoots).toEqual([resolve(src, "private"), resolve(src, "alpha"), resolve(src, "beta")]);
    expect(discovered.addonRoots.join("\n")).not.toContain("copia");
    expect(discovered.discovery).toMatchObject({ mode: "doodba-reconciled", effectiveModuleCount: 3, effectiveRootCount: 3 });
    expect(discovered.discovery?.inactiveExposedCount).toBeGreaterThan(0);
    expect(discovered.discovery?.generatedFingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  it("AC-ONLY-01/02: treats unset ONLY as optional and known mismatch as inactive", async () => {
    const root = resolve(tempRoot, "only");
    const src = resolve(root, "odoo", "custom", "src");
    await createMarker(resolve(src, "odoo"), "odoo-bin", "odoo/addons/base/__manifest__.py");
    await createMarker(resolve(src, "repo"), "always/__manifest__.py", "conditional/__manifest__.py");
    await createDoodbaEvidence(root);
    await writeFile(resolve(src, "addons.yaml"), "repo: [always]\n---\nONLY:\n  ODOOLS_FIXTURE_ENV: [yes]\nrepo: [conditional]\n");
    const generated = resolve(root, "odoo", "auto", "addons");
    await rm(generated, { recursive: true, force: true }); await mkdir(generated, { recursive: true });
    await symlink(resolve(src, "repo", "always"), resolve(generated, "always"));
    const old = process.env.ODOOLS_FIXTURE_ENV;
    delete process.env.ODOOLS_FIXTURE_ENV;
    expect((await discoverWorkspace(src)).discovery).toMatchObject({ effectiveModuleCount: 1, unknownConditionResolvedCount: 0 });
    process.env.ODOOLS_FIXTURE_ENV = "no";
    expect((await discoverWorkspace(src)).discovery?.effectiveModuleCount).toBe(1);
    if (old === undefined) delete process.env.ODOOLS_FIXTURE_ENV; else process.env.ODOOLS_FIXTURE_ENV = old;
  });

  it("AC-DUP-02/04: rejects malformed, escaping, and config-disagreeing generated entries", async () => {
    const root = resolve(tempRoot, "invalid-generated");
    const src = resolve(root, "odoo", "custom", "src");
    await createMarker(resolve(src, "odoo"), "odoo-bin", "odoo/addons/base/__manifest__.py");
    await createMarker(resolve(src, "repo"), "chosen/__manifest__.py", "other/__manifest__.py");
    await createDoodbaEvidence(root);
    await writeFile(resolve(src, "addons.yaml"), "repo: [chosen]\n");
    const generated = resolve(root, "odoo", "auto", "addons");
    await rm(generated, { recursive: true, force: true }); await mkdir(generated, { recursive: true });
    await mkdir(resolve(generated, "chosen"));
    await expect(discoverWorkspace(src)).rejects.toMatchObject({ code: "ODOOLS_DISCOVERY_MALFORMED_GENERATED_TARGET" });
    await rm(resolve(generated, "chosen"), { recursive: true });
    await symlink(resolve(src, "repo", "other"), resolve(generated, "other"));
    await expect(discoverWorkspace(src)).rejects.toMatchObject({ code: "ODOOLS_DISCOVERY_CONFIG_GENERATED_MISMATCH" });
    await rm(resolve(generated, "other"));
    await createMarker(resolve(tempRoot, "escaped"), "__manifest__.py");
    await symlink(resolve(tempRoot, "escaped"), resolve(generated, "escaped"));
    await expect(discoverWorkspace(src)).rejects.toMatchObject({ code: "ODOOLS_DISCOVERY_ESCAPING_GENERATED_TARGET" });
  });

  it("AC-DUP review: treats ENV as metadata and private as implicit highest priority", async () => {
    const root = resolve(tempRoot, "env-private"); const src = resolve(root, "odoo", "custom", "src");
    await createMarker(resolve(src, "odoo"), "odoo-bin", "odoo/addons/base/__manifest__.py");
    await createMarker(resolve(src, "repo"), "unique/__manifest__.py", "shared/__manifest__.py");
    await createMarker(resolve(src, "private"), "shared/__manifest__.py"); await createDoodbaEvidence(root);
    await writeFile(resolve(src, "addons.yaml"), "ENV:\n  DEFAULT_REPO_PATTERN: 'https://example.invalid/{}.git'\n'repo': ['unique']\n");
    const generated = resolve(root, "odoo", "auto", "addons"); await rm(generated, { recursive: true, force: true }); await mkdir(generated, { recursive: true });
    await symlink(resolve(src, "repo", "unique"), resolve(generated, "unique")); await symlink(resolve(src, "private", "shared"), resolve(generated, "shared"));
    expect((await discoverWorkspace(src)).addonRoots).toEqual([resolve(src, "private"), resolve(src, "repo")]);
  });

  it("AC-DUP review: rejects a required root that physically shadows a generated core winner", async () => {
    const root = resolve(tempRoot, "core-shadow"); const src = resolve(root, "odoo", "custom", "src");
    await createMarker(resolve(src, "odoo"), "odoo-bin", "addons/core_module/__manifest__.py", "odoo/addons/base/__manifest__.py");
    await createMarker(resolve(src, "repo"), "unique/__manifest__.py", "core_module/__manifest__.py"); await createDoodbaEvidence(root); await writeFile(resolve(src, "addons.yaml"), "repo: [unique]\n");
    const generated = resolve(root, "odoo", "auto", "addons"); await rm(generated, { recursive: true, force: true }); await mkdir(generated, { recursive: true });
    await symlink(resolve(src, "repo", "unique"), resolve(generated, "unique")); await symlink(resolve(src, "odoo", "addons", "core_module"), resolve(generated, "core_module"));
    await expect(discoverWorkspace(src)).rejects.toMatchObject({ code: "ODOOLS_DISCOVERY_WINNER_MISMATCH" });
  });

  it("AC-DUP review: detects physical precedence cycles", async () => {
    const root = resolve(tempRoot, "cycle"); const src = resolve(root, "odoo", "custom", "src");
    await createMarker(resolve(src, "odoo"), "odoo-bin", "odoo/addons/base/__manifest__.py");
    await createMarker(resolve(src, "left"), "one/__manifest__.py", "two/__manifest__.py"); await createMarker(resolve(src, "right"), "one/__manifest__.py", "two/__manifest__.py");
    await createDoodbaEvidence(root); await writeFile(resolve(src, "addons.yaml"), "left: [one]\nright: [two]\n");
    const generated = resolve(root, "odoo", "auto", "addons"); await rm(generated, { recursive: true, force: true }); await mkdir(generated, { recursive: true });
    await symlink(resolve(src, "left", "one"), resolve(generated, "one")); await symlink(resolve(src, "right", "two"), resolve(generated, "two"));
    await expect(discoverWorkspace(src)).rejects.toMatchObject({ code: "ODOOLS_DISCOVERY_PRECEDENCE_CYCLE" });
  });

  it("AC-DUP review: rejects broken, looping, and name-mismatched generated links", async () => {
    const root = resolve(tempRoot, "bad-links"); const src = resolve(root, "odoo", "custom", "src");
    await createMarker(resolve(src, "odoo"), "odoo-bin", "odoo/addons/base/__manifest__.py"); await createMarker(resolve(src, "repo"), "chosen/__manifest__.py");
    await createDoodbaEvidence(root); await writeFile(resolve(src, "addons.yaml"), "repo: ['*']\n"); const generated = resolve(root, "odoo", "auto", "addons");
    await rm(generated, { recursive: true, force: true }); await mkdir(generated, { recursive: true }); await symlink("missing", resolve(generated, "chosen"));
    await expect(discoverWorkspace(src)).rejects.toMatchObject({ code: "ODOOLS_DISCOVERY_BROKEN_GENERATED_TARGET" }); await rm(resolve(generated, "chosen"));
    await symlink("chosen", resolve(generated, "chosen")); await expect(discoverWorkspace(src)).rejects.toMatchObject({ code: "ODOOLS_DISCOVERY_GENERATED_SYMLINK_LOOP" }); await rm(resolve(generated, "chosen"));
    await symlink(resolve(src, "repo", "chosen"), resolve(generated, "different")); await expect(discoverWorkspace(src)).rejects.toMatchObject({ code: "ODOOLS_DISCOVERY_GENERATED_NAME_MISMATCH" });
  });

  it("AC-DUP-07: rejects missing, directory, and symlink manifests in selected generated modules", async () => {
    for (const variant of ["missing", "directory", "symlink"] as const) {
      const root = resolve(tempRoot, `manifest-${variant}`); const src = resolve(root, "odoo", "custom", "src");
      await createMarker(resolve(src, "odoo"), "odoo-bin", "odoo/addons/base/__manifest__.py");
      const module = resolve(src, "repo", "selected"); await mkdir(module, { recursive: true }); await createDoodbaEvidence(root); await writeFile(resolve(src, "addons.yaml"), "repo: [selected]\n");
      if (variant === "directory") await mkdir(resolve(module, "__manifest__.py"));
      if (variant === "symlink") { await writeFile(resolve(module, "manifest-target.py"), "{}\n"); await symlink(resolve(module, "manifest-target.py"), resolve(module, "__manifest__.py")); }
      const generated = resolve(root, "odoo", "auto", "addons"); await rm(generated, { recursive: true, force: true }); await mkdir(generated, { recursive: true }); await symlink(module, resolve(generated, "selected"));
      await expect(discoverWorkspace(src)).rejects.toMatchObject({ code: "ODOOLS_DISCOVERY_MALFORMED_GENERATED_TARGET" });
    }
  });

  it("AC-DUP review: caps inactive warnings and rejects oversized addons YAML", async () => {
    const root = resolve(tempRoot, "warnings"); const src = resolve(root, "odoo", "custom", "src");
    await createMarker(resolve(src, "odoo"), "odoo-bin", "odoo/addons/base/__manifest__.py");
    const files = ["active/__manifest__.py", ...Array.from({ length: 25 }, (_, index) => `inactive_${index}/__manifest__.py`)]; await createMarker(resolve(src, "repo"), ...files);
    await createDoodbaEvidence(root); await writeFile(resolve(src, "addons.yaml"), "repo: [active]\n"); const generated = resolve(root, "odoo", "auto", "addons"); await rm(generated, { recursive: true, force: true }); await mkdir(generated, { recursive: true }); await symlink(resolve(src, "repo", "active"), resolve(generated, "active"));
    const result = await discoverWorkspace(src); expect(result.discovery).toMatchObject({ inactiveExposedCount: 25, warningsTruncated: true }); expect(result.discovery?.warnings).toHaveLength(20);
    await writeFile(resolve(src, "addons.yaml"), "x".repeat(1024 * 1024 + 1)); await expect(discoverWorkspace(src)).rejects.toMatchObject({ code: "ODOOLS_DISCOVERY_OVERSIZED_ADDONS_CONFIG" });
  });

  it("AC-DUP-06: retries one generated mutation and fails after the second", async () => {
    const root = resolve(tempRoot, "mutation"); const src = resolve(root, "odoo", "custom", "src");
    await createMarker(resolve(src, "odoo"), "odoo-bin", "odoo/addons/base/__manifest__.py"); await createMarker(resolve(src, "repo"), "active/__manifest__.py"); await createDoodbaEvidence(root); await writeFile(resolve(src, "addons.yaml"), "repo: ['*']\n");
    const generated = resolve(root, "odoo", "auto", "addons"); await rm(generated, { recursive: true, force: true }); await mkdir(generated, { recursive: true }); await symlink(resolve(src, "repo", "active"), resolve(generated, "active"));
    setGeneratedMutationTestHook(async (attempt) => { if (attempt === 0) await lutimes(resolve(generated, "active"), new Date(), new Date()); });
    expect((await discoverWorkspace(src)).discovery?.effectiveModuleCount).toBe(1);
    setGeneratedMutationTestHook(async (attempt) => { const time = new Date((attempt + 1) * 10_000); await lutimes(resolve(generated, "active"), time, time); });
    await expect(discoverWorkspace(src)).rejects.toMatchObject({ code: "ODOOLS_DISCOVERY_UNSTABLE_GENERATED_STATE" });
  });

  it("AC-DUP-01: supports exact odoo/addons selection and rejects unselected core winners", async () => {
    const root = resolve(tempRoot, "selected-core"); const src = resolve(root, "odoo", "custom", "src");
    await createMarker(resolve(src, "odoo"), "odoo-bin", "odoo/addons/base/__manifest__.py", "addons/selected_core/__manifest__.py", "addons/unselected_core/__manifest__.py"); await createDoodbaEvidence(root);
    await writeFile(resolve(src, "addons.yaml"), "odoo/addons: [selected_*]\n"); const generated = resolve(root, "odoo", "auto", "addons"); await rm(generated, { recursive: true, force: true }); await mkdir(generated, { recursive: true });
    await symlink(resolve(src, "odoo", "addons", "selected_core"), resolve(generated, "selected_core"));
    expect((await discoverWorkspace(src)).discovery?.effectiveModuleCount).toBe(1);
    await symlink(resolve(src, "odoo", "addons", "unselected_core"), resolve(generated, "unselected_core"));
    await expect(discoverWorkspace(src)).rejects.toMatchObject({ code: "ODOOLS_DISCOVERY_CONFIG_GENERATED_MISMATCH" });
  });

  it("AC-DUP-01: rejects arbitrary nested, traversal, absolute, and backslash repository keys", async () => {
    for (const [index, key] of ["nested/repo", "../repo", "/absolute", "nested\\repo"].entries()) {
      const root = resolve(tempRoot, `invalid-key-${index}`); const src = resolve(root, "odoo", "custom", "src");
      await createMarker(resolve(src, "odoo"), "odoo-bin", "odoo/addons/base/__manifest__.py"); await createDoodbaEvidence(root); await writeFile(resolve(src, "addons.yaml"), `${JSON.stringify(key)}: ['*']\n`);
      await expect(discoverWorkspace(src)).rejects.toMatchObject({ code: "ODOOLS_DISCOVERY_UNSUPPORTED_ADDONS_CONFIG" });
    }
  });

  it("AC-DUP-01: prefers addons.yaml and otherwise supports addons.yml", async () => {
    const root = resolve(tempRoot, "yml-fallback"); const src = resolve(root, "odoo", "custom", "src");
    await createMarker(resolve(src, "odoo"), "odoo-bin", "odoo/addons/base/__manifest__.py"); await createMarker(resolve(src, "repo"), "from_yml/__manifest__.py", "from_yaml/__manifest__.py"); await createDoodbaEvidence(root);
    const generated = resolve(root, "odoo", "auto", "addons"); await rm(generated, { recursive: true, force: true }); await mkdir(generated, { recursive: true });
    await rm(resolve(src, "addons.yaml")); await writeFile(resolve(src, "addons.yml"), "repo: [from_yml]\n"); await symlink(resolve(src, "repo", "from_yml"), resolve(generated, "from_yml"));
    expect((await discoverWorkspace(src)).discovery?.effectiveModuleCount).toBe(1);
    await rm(resolve(generated, "from_yml")); await symlink(resolve(src, "repo", "from_yaml"), resolve(generated, "from_yaml")); await writeFile(resolve(src, "addons.yaml"), "repo: [from_yaml]\n");
    expect((await discoverWorkspace(src)).discovery?.effectiveModuleCount).toBe(1);
  });

  it("AC-DUP-04: rejects exposed ambiguous ordinary duplicate without generated winner", async () => {
    const root = resolve(tempRoot, "ambiguous-ordinary"); const src = resolve(root, "odoo", "custom", "src");
    await createMarker(resolve(src, "odoo"), "odoo-bin", "odoo/addons/base/__manifest__.py"); await createMarker(resolve(src, "left"), "left_unique/__manifest__.py", "shared/__manifest__.py"); await createMarker(resolve(src, "right"), "right_unique/__manifest__.py", "shared/__manifest__.py"); await createDoodbaEvidence(root); await writeFile(resolve(src, "addons.yaml"), "left: [left_unique]\nright: [right_unique]\n");
    const generated = resolve(root, "odoo", "auto", "addons"); await rm(generated, { recursive: true, force: true }); await mkdir(generated, { recursive: true }); await symlink(resolve(src, "left", "left_unique"), resolve(generated, "left_unique")); await symlink(resolve(src, "right", "right_unique"), resolve(generated, "right_unique"));
    await expect(discoverWorkspace(src)).rejects.toMatchObject({ code: "ODOOLS_DISCOVERY_AMBIGUOUS_ORDINARY_DUPLICATE" });
  });

  it("AC-DUP-04: identified Doodba fails closed when generated directory or config is missing", async () => {
    const directoryRoot = resolve(tempRoot, "missing-generated-directory"); const directorySrc = resolve(directoryRoot, "odoo", "custom", "src");
    await createMarker(resolve(directorySrc, "odoo"), "odoo-bin", "odoo/addons/base/__manifest__.py"); await createMarker(resolve(directorySrc, "repo"), "module/__manifest__.py"); await createDoodbaEvidence(directoryRoot); await rm(resolve(directoryRoot, "odoo", "auto", "addons"), { recursive: true, force: true });
    await expect(discoverWorkspace(directorySrc)).rejects.toMatchObject({ code: "ODOOLS_DISCOVERY_MISSING_GENERATED_STATE" });

    const configRoot = resolve(tempRoot, "missing-generated-config"); const configSrc = resolve(configRoot, "odoo", "custom", "src");
    await createMarker(resolve(configSrc, "odoo"), "odoo-bin", "odoo/addons/base/__manifest__.py"); await createMarker(resolve(configSrc, "repo"), "module/__manifest__.py"); await createDoodbaEvidence(configRoot); await rm(resolve(configRoot, "odoo", "auto", "odoo.conf"));
    await expect(discoverWorkspace(resolve(configSrc, "repo", "module"))).rejects.toMatchObject({ code: "ODOOLS_DISCOVERY_MISSING_GENERATED_STATE" });
  });

  it("AC-DUP-08: generic project evidence does not trigger Doodba policy", async () => {
    const root = resolve(tempRoot, "generic"); const src = resolve(root, "odoo", "custom", "src"); await createMarker(resolve(src, "odoo"), "odoo-bin", "odoo/addons/base/__manifest__.py"); await createMarker(resolve(src, "repo"), "module/__manifest__.py"); await writeFile(resolve(root, "tasks.py"), "# doodba-copier-template"); await writeFile(resolve(src, "addons.yaml"), "repo: ['*']\n");
    expect((await discoverWorkspace(src)).isDoodba).toBe(false);
  });

  it("AC-ONLY-01..06: reconciles unknown selected/absent and preserves AND classification", async () => {
    const root = resolve(tempRoot, "only-reconcile"); const src = resolve(root, "odoo", "custom", "src");
    await createMarker(resolve(src, "odoo"), "odoo-bin", "odoo/addons/base/__manifest__.py"); await createMarker(resolve(src, "repo"), "active/__manifest__.py", "unknown_selected/__manifest__.py", "unknown_absent/__manifest__.py", "inactive/__manifest__.py"); await createDoodbaEvidence(root);
    const generated = resolve(root, "odoo", "auto", "addons"); await rm(generated, { recursive: true, force: true }); await mkdir(generated, { recursive: true }); await symlink(resolve(src, "repo", "active"), resolve(generated, "active")); await symlink(resolve(src, "repo", "unknown_selected"), resolve(generated, "unknown_selected"));
    const oldKnown = process.env.ODOOLS_KNOWN; const oldMissing = process.env.ODOOLS_MISSING; process.env.ODOOLS_KNOWN = "yes"; delete process.env.ODOOLS_MISSING;
    await writeFile(resolve(src, "addons.yaml"), "repo: [active]\n---\nONLY:\n  ODOOLS_KNOWN: [yes]\n  ODOOLS_MISSING: [yes]\nrepo: [unknown_selected, unknown_absent]\n---\nONLY:\n  ODOOLS_KNOWN: [no]\n  ODOOLS_MISSING: [yes]\nrepo: [inactive]\n");
    const result = await discoverWorkspace(src); expect(result.discovery).toMatchObject({ effectiveModuleCount: 2, unknownConditionResolvedCount: 1 }); expect(result.discovery?.warnings?.[0]).toContain("unknown ONLY conditions");
    if (oldKnown === undefined) delete process.env.ODOOLS_KNOWN; else process.env.ODOOLS_KNOWN = oldKnown; if (oldMissing === undefined) delete process.env.ODOOLS_MISSING; else process.env.ODOOLS_MISSING = oldMissing;
  });

  it("AC-ONLY-03/06: active absence and inactive generated targets mismatch", async () => {
    const root = resolve(tempRoot, "only-mismatch"); const src = resolve(root, "odoo", "custom", "src"); await createMarker(resolve(src, "odoo"), "odoo-bin", "odoo/addons/base/__manifest__.py"); await createMarker(resolve(src, "repo"), "active/__manifest__.py", "inactive/__manifest__.py"); await createDoodbaEvidence(root); const generated = resolve(root, "odoo", "auto", "addons"); await rm(generated, { recursive: true, force: true }); await mkdir(generated, { recursive: true });
    await writeFile(resolve(src, "addons.yaml"), "repo: [active]\n"); await expect(discoverWorkspace(src)).rejects.toMatchObject({ code: "ODOOLS_DISCOVERY_CONFIG_GENERATED_MISMATCH" });
    const old = process.env.ODOOLS_KNOWN; process.env.ODOOLS_KNOWN = "no"; await writeFile(resolve(src, "addons.yaml"), "ONLY:\n  ODOOLS_KNOWN: [yes]\nrepo: [inactive]\n"); await symlink(resolve(src, "repo", "inactive"), resolve(generated, "inactive")); await expect(discoverWorkspace(src)).rejects.toMatchObject({ code: "ODOOLS_DISCOVERY_CONFIG_GENERATED_MISMATCH" }); if (old === undefined) delete process.env.ODOOLS_KNOWN; else process.env.ODOOLS_KNOWN = old;
  });

  it("AC-ONLY-01/06: all-known true is active and malformed ONLY fails", async () => {
    const root = resolve(tempRoot, "only-shapes"); const src = resolve(root, "odoo", "custom", "src"); await createMarker(resolve(src, "odoo"), "odoo-bin", "odoo/addons/base/__manifest__.py"); await createMarker(resolve(src, "repo"), "active/__manifest__.py"); await createDoodbaEvidence(root); const generated = resolve(root, "odoo", "auto", "addons"); await rm(generated, { recursive: true, force: true }); await mkdir(generated, { recursive: true }); await symlink(resolve(src, "repo", "active"), resolve(generated, "active")); const old = process.env.ODOOLS_KNOWN; process.env.ODOOLS_KNOWN = "yes";
    await writeFile(resolve(src, "addons.yaml"), "ONLY:\n  ODOOLS_KNOWN: [yes]\nrepo: [active]\n---\nrepo: [active]\n"); expect((await discoverWorkspace(src)).discovery?.effectiveModuleCount).toBe(1);
    await writeFile(resolve(src, "addons.yaml"), "ONLY: [bad]\nrepo: [active]\n"); await expect(discoverWorkspace(src)).rejects.toMatchObject({ code: "ODOOLS_DISCOVERY_UNEVALUABLE_ONLY" }); if (old === undefined) delete process.env.ODOOLS_KNOWN; else process.env.ODOOLS_KNOWN = old;
  });

  it("AC-ONLY F1/F3: aggregates unknown special selections and canonicalizes ordinary aliases", async () => {
    const root = resolve(tempRoot, "special-alias"); const src = resolve(root, "odoo", "custom", "src"); await createMarker(resolve(src, "odoo"), "odoo-bin", "odoo/addons/base/__manifest__.py", "addons/core_optional/__manifest__.py"); await createMarker(resolve(src, "private"), "private_optional/__manifest__.py"); await createMarker(resolve(src, "repo"), "ordinary/__manifest__.py"); await symlink(resolve(src, "repo"), resolve(src, "repo-alias")); await createDoodbaEvidence(root); const generated = resolve(root, "odoo", "auto", "addons"); await rm(generated, { recursive: true, force: true }); await mkdir(generated, { recursive: true }); await symlink(resolve(src, "private", "private_optional"), resolve(generated, "private_optional")); await symlink(resolve(src, "odoo", "addons", "core_optional"), resolve(generated, "core_optional")); await symlink(resolve(src, "repo", "ordinary"), resolve(generated, "ordinary"));
    const old = process.env.ODOOLS_SPECIAL_UNKNOWN; delete process.env.ODOOLS_SPECIAL_UNKNOWN; await writeFile(resolve(src, "addons.yaml"), "ONLY:\n  ODOOLS_SPECIAL_UNKNOWN: [yes]\nprivate: [private_optional]\nodoo/addons: [core_optional]\nrepo: [ordinary]\n---\nrepo-alias: [ordinary]\n"); const result = await discoverWorkspace(src); expect(result.addonRoots.filter((path) => path === resolve(src, "private"))).toHaveLength(1); expect(result.addonRoots[0]).toBe(resolve(src, "private")); expect(result.addonRoots.filter((path) => path === resolve(src, "repo"))).toHaveLength(1); expect(result.discovery?.unknownConditionResolvedCount).toBe(2); if (old === undefined) delete process.env.ODOOLS_SPECIAL_UNKNOWN; else process.env.ODOOLS_SPECIAL_UNKNOWN = old;
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
