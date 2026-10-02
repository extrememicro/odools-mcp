import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { FileDiagnosticsProvider } from "../src/file-diagnostics.js";
import { DiagnosticsStore } from "../src/lsp/diagnostics.js";
import { LspSession } from "../src/lsp/session.js";

it.skipIf(!process.env.ODOOLS_DIAGNOSTICS_RUNTIME)("records pre-indexed publication lifecycle without customer edits", async () => {
  const runtime = process.env.ODOOLS_DIAGNOSTICS_RUNTIME!;
  const core = process.env.ODOOLS_DIAGNOSTICS_CORE!;
  await readFile(resolve(core, "odoo/release.py"));
  const root = await mkdtemp("/tmp/opencode/publication-probe-");
  let session: LspSession | undefined;
  try {
    const workspace = resolve(root, "workspace");
    const dependency = resolve(root, "dependency");
    const good = "from odoo import models, fields\n\nclass Probe(models.Model):\n    _name = \"publication.probe\"\n    name = fields.Char()\n";
    for (const [base, name] of [[workspace, "workspace_probe"], [dependency, "dependency_probe"]]) {
      const addon = resolve(base!, name!);
      await mkdir(addon, { recursive: true });
      await writeFile(resolve(addon, "__manifest__.py"), `{"name":"Probe","version":"19.0.1.0.0","depends":["base"]}\n`);
      await writeFile(resolve(addon, "__init__.py"), "from . import model\n");
      await writeFile(resolve(addon, "model.py"), good.replace("publication.probe", name!));
    }
    const configPath = resolve(root, "odools.toml");
    await writeFile(configPath, `[[config]]\nname = "default"\nodoo_path = ${JSON.stringify(core)}\naddons_paths = [${JSON.stringify(workspace)}, ${JSON.stringify(dependency)}]\npython_path = "/usr/bin/python3"\ndisable_javascript = true\nstdlib = ${JSON.stringify(resolve(runtime, "typeshed/stdlib"))}\n`);
    const config = await loadConfig({ workspace, allowedRoots: [dependency], binary: resolve(runtime, "odoo_ls_server"), config: configPath, watcherEnabled: false, startupTimeoutMs: 180000, requestTimeoutMs: 30000 });
    session = new LspSession(config);
    const active = session;
    let phase = "index";
    const raw: { phase: string; payload: unknown; acceptedWithRegisteredVersion: boolean; before: ReturnType<DiagnosticsStore["snapshot"]>; after: ReturnType<DiagnosticsStore["snapshot"]> }[] = [];
    const publish = active.diagnostics.publish.bind(active.diagnostics);
    vi.spyOn(active.diagnostics, "publish").mockImplementation((payload) => {
      const probe = new DiagnosticsStore();
      const p = payload as { uri?: string; version?: number };
      if (typeof p?.uri === "string") probe.open(p.uri, p.version ?? 1);
      probe.publish(payload);
      const before = active.diagnostics.snapshot(p.uri ?? "");
      publish(payload);
      raw.push({ phase, payload, acceptedWithRegisteredVersion: typeof p?.uri === "string" && probe.snapshot(p.uri).received, before, after: active.diagnostics.snapshot(p.uri ?? "") });
    });
    console.log("PUBLICATION_START", JSON.stringify({ root }));
    await active.start();
    const deadline = Date.now() + 60000;
    while (!active.readiness.isReady() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200));
    console.log("PUBLICATION_READINESS", JSON.stringify(active.readiness.snapshot()));
    // Python indexing readiness is independent of optional JavaScript degradation.
    expect(active.readiness.isReady()).toBe(true);
    const provider = new FileDiagnosticsProvider(config, active);
    const outcomes = [];
    for (const [placement, path] of [["workspace", "workspace_probe/model.py"], ["dependency", "../dependency/dependency_probe/model.py"]]) {
      const absolute = resolve(workspace, path!);
      const uri = pathToFileURL(absolute).href;
      const text = await readFile(absolute, "utf8");
      const observe = async () => {
        if (placement === "workspace") return provider.call(path!, 10000);
        // MCP inputs intentionally cannot escape workspace; exercise dependency LSP placement directly.
        await active.open(uri, absolute, text);
        return active.diagnostics.wait(uri, 10000);
      };
      phase = `${placement}:open`;
      const initial = await observe();
      phase = `${placement}:repeat`;
      const repeat = await observe();
      phase = `${placement}:same-text`;
      active.diagnostics.open(uri, 2);
      active.notify("textDocument/didChange", { textDocument: { uri, version: 2 }, contentChanges: [{ text }] });
      const sameText = await active.diagnostics.wait(uri, 10000);
      phase = `${placement}:edit`;
      const changed = `${text}\ndef broken(:\n`;
      await writeFile(absolute, changed);
      active.diagnostics.open(uri, 3);
      active.notify("textDocument/didChange", { textDocument: { uri, version: 3 }, contentChanges: [{ text: changed }] });
      const edited = await active.diagnostics.wait(uri, 10000);
      outcomes.push({ placement, uri, initial, repeat, sameText, edited });
      console.log("PUBLICATION_PLACEMENT", JSON.stringify(outcomes.at(-1)));
    }
    console.log("PUBLICATION_PROBE", JSON.stringify({ outcomes, raw }));
    for (const outcome of outcomes) {
      const targetRaw = raw.filter((r) => (r.payload as { uri?: string }).uri === outcome.uri);
      if (outcome.placement === "workspace") {
        expect(targetRaw).toContainEqual(expect.objectContaining({
          phase: "index", payload: expect.objectContaining({ uri: outcome.uri, version: -100, diagnostics: [] }),
          acceptedWithRegisteredVersion: true,
          before: expect.objectContaining({ status: "not_received", documentVersion: null }),
          after: expect.objectContaining({ status: "not_received", received: false, documentVersion: null }),
        }));
        // The engine does not republish an unchanged pre-indexed file on open, so a positive wait
        // must not be satisfied by the inherited -100 observation: it times out, uncertainty preserved.
        for (const observation of [outcome.initial, outcome.repeat]) {
          expect(observation).toMatchObject({ status: "received", received: true, timedOut: true, documentVersion: 1, publishedVersion: -100, freshness: "unversioned_uncertain", clean: null });
        }
        expect(outcome.sameText).toMatchObject({ status: "stale", received: true, timedOut: true, documentVersion: 2, publishedVersion: -100, freshness: "unknown" });
        expect(targetRaw.filter((r) => ["workspace:open", "workspace:repeat", "workspace:same-text"].includes(r.phase))).toEqual([]);
      } else {
        for (const observation of [outcome.initial, outcome.repeat]) {
          expect(observation).toMatchObject({ status: "received", received: true, documentVersion: 1, publishedVersion: 1, freshness: "version_matched", diagnostics: [] });
        }
        expect(outcome.sameText).toMatchObject({ status: "stale", received: true, timedOut: true, documentVersion: 2, publishedVersion: 1, freshness: "unknown" });
        expect(targetRaw.filter((r) => r.phase === "dependency:same-text")).toEqual([]);
      }
      expect(outcome.edited).toMatchObject({ status: "received", received: true, documentVersion: 3, publishedVersion: 3, freshness: "version_matched" });
      expect(outcome.edited.diagnostics).toContainEqual(expect.objectContaining({ severity: 1, message: expect.stringMatching(/parameter|parsing/) }));
      expect(targetRaw).toContainEqual(expect.objectContaining({ phase: `${outcome.placement}:edit`, acceptedWithRegisteredVersion: true, payload: expect.objectContaining({ version: 3, diagnostics: expect.arrayContaining([expect.objectContaining({ code: "OLS01000" })]) }) }));
    }
  } finally {
    const pid = session?.lastChildPid;
    try { await session?.stop(); }
    finally { await rm(root, { recursive: true, force: true }); }
    const fixtureAbsent = await lstat(root).then(() => false, (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return true;
      throw error;
    });
    let childExited = pid === undefined;
    if (pid !== undefined) {
      childExited = (() => {
        try { process.kill(pid, 0); return false; } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ESRCH") return true;
          throw error;
        }
      })();
    }
    console.log("PUBLICATION_CLEANUP", JSON.stringify({ root, pid, fixtureAbsent, childExited }));
    expect(fixtureAbsent).toBe(true);
    expect(childExited).toBe(true);
  }
}, 300000);
