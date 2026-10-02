import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { afterAll, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { LspSession } from "../src/lsp/session.js";
import { FileDiagnosticsProvider } from "../src/file-diagnostics.js";
import { HoverProvider } from "../src/hover.js";

let root: string | undefined;
let session: LspSession | undefined;
afterAll(async () => { await session?.stop(); if (root) await rm(root, { recursive: true, force: true }); });
it.skipIf(!process.env.ODOOLS_DIAGNOSTICS_RUNTIME)("isolated pinned engine hover and issue/fix observations", async () => {
  const runtime = process.env.ODOOLS_DIAGNOSTICS_RUNTIME!;
  const core = process.env.ODOOLS_DIAGNOSTICS_CORE!;
  root = await mkdtemp(resolve("@tmp/real-diagnostics-"));
  const addon = resolve(root, "probe"); await mkdir(addon);
  await writeFile(resolve(addon, "__manifest__.py"), "{\"name\": \"Probe\", \"version\": \"18.0.1.0.0\", \"depends\": [\"base\"], \"data\": [\"view.xml\", \"ir.model.access.csv\"]}\n");
  await writeFile(resolve(addon, "__init__.py"), "from . import model\n");
  const goodPython = "from odoo import models, fields\n\nclass Probe(models.Model):\n    _name = \"diagnostics.probe\"\n    name = fields.Char()\n";
  const goodXml = "<odoo><record id=\"probe_form\" model=\"ir.ui.view\"><field name=\"name\">probe</field><field name=\"model\">diagnostics.probe</field><field name=\"arch\" type=\"xml\"><form><field name=\"name\"/></form></field></record></odoo>\n";
  const goodCsv = "id,name,model_id:id,group_id:id,perm_read,perm_write,perm_create,perm_unlink\naccess_probe,probe,model_diagnostics_probe,base.group_user,1,0,0,0\n";
  await writeFile(resolve(addon, "model.py"), goodPython);
  await writeFile(resolve(addon, "view.xml"), goodXml);
  await writeFile(resolve(addon, "ir.model.access.csv"), goodCsv);
  const configPath = resolve(root, "odools.toml");
  await writeFile(configPath, `[[config]]\nname = "default"\nodoo_path = ${JSON.stringify(core)}\naddons_paths = [${JSON.stringify(root)}]\npython_path = "/usr/bin/python3"\ndisable_javascript = true\nstdlib = ${JSON.stringify(resolve(runtime, "typeshed/stdlib"))}\n`);
  const config = await loadConfig({ workspace: root, binary: resolve(runtime, "odoo_ls_server"), config: configPath, watcher: false, startupTimeoutMs: 180000, requestTimeoutMs: 30000 });
  session = new LspSession(config);
  const diagnostics = new FileDiagnosticsProvider(config, session);
  const hover = new HoverProvider(config, session);
  // Raw engine payloads (codes are not part of the bounded adapter finding schema).
  const raw: { uri: string; version?: number; codes: string[] }[] = [];
  const store = session.diagnostics; const publish = store.publish.bind(store);
  vi.spyOn(store, "publish").mockImplementation((payload) => {
    const p = payload as { uri?: string; version?: number; diagnostics?: { code?: string | number }[] };
    if (typeof p?.uri === "string" && p.uri.includes("/probe/")) raw.push({ uri: p.uri, version: p.version, codes: (p.diagnostics ?? []).map((d) => String(d.code)) });
    publish(payload);
  });
  const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
  // An empty publication may precede findings for the same version: poll (bounded) instead of assuming finality.
  const pollCode = async (path: string, version: number, code: string, ms = 20000) => {
    const deadline = Date.now() + ms;
    for (;;) {
      if (raw.some((r) => r.uri.endsWith(`/probe/${path}`) && r.version === version && r.codes.includes(code))) return true;
      if (Date.now() >= deadline) return false;
      await pause(200);
    }
  };
  const pythonHover = await hover.call("probe/model.py", 5, 20);
  const xmlHover = await hover.call("probe/view.xml", 1, goodXml.indexOf("diagnostics.probe") + 2);
  console.log("REAL_HOVER", JSON.stringify({ python: pythonHover, xml: xmlHover }));
  expect(pythonHover.content).not.toBeNull();
  expect(xmlHover.content).not.toBeNull();
  const outcomes = [];
  for (const [path, bad, good] of [
    ["model.py", `${goodPython}\ndef broken(:\n`, goodPython],
    ["view.xml", "<odoo><record></odoo>", goodXml],
    ["ir.model.access.csv", goodCsv.replace("model_diagnostics_probe", "model_diagnostics_missing"), goodCsv],
  ]) {
    await writeFile(resolve(addon, path!), bad!);
    let issue = await diagnostics.call(`probe/${path}`, 10000);
    let issueCodeObserved: boolean | null = null;
    if (path === "ir.model.access.csv") {
      issueCodeObserved = await pollCode(path, issue.documentVersion!, "OLS05001");
      issue = await diagnostics.call(`probe/${path}`, 0);
    }
    await writeFile(resolve(addon, path!), good!);
    let fixed = await diagnostics.call(`probe/${path}`, 10000);
    let fixedCodeObserved: boolean | null = null;
    if (path === "ir.model.access.csv") {
      // Bounded settle window: a late finding for the restored version would be a regression.
      fixedCodeObserved = await pollCode(path, fixed.documentVersion!, "OLS05001", 3000);
      fixed = await diagnostics.call(`probe/${path}`, 0);
    }
    outcomes.push({ path, issue, fixed, issueCodeObserved, fixedCodeObserved });
  }
  console.log("REAL_DIAGNOSTICS", JSON.stringify(outcomes));
  for (const outcome of outcomes) {
    expect(outcome.issue.status, outcome.path).toBe("received");
    expect(outcome.fixed.status, outcome.path).toBe("received");
    for (const result of [outcome.issue, outcome.fixed]) {
      expect(result.freshness, outcome.path).toBe("version_matched");
      expect(result.publishedVersion, outcome.path).toBe(result.documentVersion);
      expect(result.timedOut, outcome.path).toBe(false);
      expect(result.clean, outcome.path).toBeNull();
    }
    expect(outcome.fixed.publishedVersion!, outcome.path).toBeGreaterThan(outcome.issue.publishedVersion!);
    if (outcome.path === "model.py") {
      expect(outcome.issue.diagnostics.length).toBeGreaterThan(0);
      expect(outcome.fixed.diagnostics).toEqual([]);
    } else if (outcome.path === "ir.model.access.csv") {
      // Pinned 1.5.2 reports the unknown model XML ID as OLS05001 for the saved CSV version.
      expect(outcome.issueCodeObserved, "CSV OLS05001 for issue version").toBe(true);
      expect(outcome.issue.diagnostics.length).toBeGreaterThan(0);
      expect(outcome.fixedCodeObserved, "no CSV OLS05001 for restored version").toBe(false);
      expect(outcome.fixed.diagnostics).toEqual([]);
    } else {
      // Pinned 1.5.2 publishes empty findings for this malformed XML fixture.
      // This records a limitation, NOT successful issue detection or AC-11 acceptance.
      expect(outcome.issue.diagnostics).toEqual([]);
      expect(outcome.fixed.diagnostics).toEqual([]);
    }
  }
}, 240000);
