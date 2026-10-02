import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { LspSession } from "../src/lsp/session.js";
import { HoverProvider } from "../src/hover.js";

// Explicit opt-in: only disposable addons are edited; core and runtime remain read-only.
it.skipIf(!process.env.ODOOLS_XML_CSV_RUNTIME)("observes pinned XML/CSV issue and restoration publications", async () => {
  const runtime = process.env.ODOOLS_XML_CSV_RUNTIME!;
  const core = process.env.ODOOLS_DIAGNOSTICS_CORE!;
  expect(await readFile(resolve(core, "odoo/release.py"), "utf8")).toContain("version_info = (19,");
  const evidence = await mkdtemp("/tmp/opencode/xml-csv-evidence-");
  const root = await mkdtemp("/tmp/opencode/xml-csv-workspace-");
  const logs = resolve(evidence, "engine-logs");
  await mkdir(logs);
  let session: LspSession | undefined;
  let pid: number | undefined;
  let phase = "prestartup";
  const started = Date.now();
  const deadline = started + 150000;
  const raw: { phase: string; ms: number; payload: { uri?: string; version?: number; diagnostics?: { code?: string | number }[] } }[] = [];
  const observations: unknown[] = [];
  const stderr: string[] = [];
  const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const window = async (ms: number) => {
    const until = Math.min(Date.now() + ms, deadline);
    while (Date.now() < until) await pause(200);
    if (Date.now() >= deadline) throw new Error("Global investigation deadline reached");
  };
  console.log("XML_CSV_START", JSON.stringify({ evidence, root, runtime, core }));
  try {
    const addon = resolve(root, "diagnostics_probe");
    await mkdir(addon);
    const goodXml = "<odoo/>\n";
    const badXml = "<odoo><bogus/></odoo>\n";
    const goodCsv = "id,name,model_id:id,group_id:id,perm_read,perm_write,perm_create,perm_unlink\naccess_probe,probe,model_diagnostics_probe,base.group_user,1,0,0,0\n";
    await writeFile(resolve(addon, "__manifest__.py"), "{\"name\":\"Diagnostics Probe\",\"version\":\"19.0.1.0.0\",\"depends\":[\"base\"],\"data\":[\"view.xml\",\"ir.model.access.csv\"]}\n");
    await writeFile(resolve(addon, "__init__.py"), "from . import model\n");
    await writeFile(resolve(addon, "model.py"), "from odoo import models, fields\n\nclass Probe(models.Model):\n    _name = \"diagnostics.probe\"\n    name = fields.Char()\n");
    await writeFile(resolve(addon, "view.xml"), badXml);
    await writeFile(resolve(addon, "ir.model.access.csv"), goodCsv);
    const configPath = resolve(root, "odools.toml");
    await writeFile(configPath, `[[config]]\nname = "default"\nodoo_path = ${JSON.stringify(core)}\naddons_paths = [${JSON.stringify(root)}]\npython_path = "/usr/bin/python3"\ndisable_javascript = true\nstdlib = ${JSON.stringify(resolve(runtime, "typeshed/stdlib"))}\n`);
    const config = await loadConfig({ workspace: root, binary: resolve(runtime, "odoo_ls_server"), config: configPath, logsDirectory: logs, watcherEnabled: false, restartMaxAttempts: 0, startupTimeoutMs: 60000, requestTimeoutMs: 10000 });
    const active = session = new LspSession(config);
    active.on("stderr", (text: string) => stderr.push(text));
    const publish = active.diagnostics.publish.bind(active.diagnostics);
    vi.spyOn(active.diagnostics, "publish").mockImplementation((payload) => {
      raw.push({ phase, ms: Date.now() - started, payload: payload as typeof raw[number]["payload"] });
      publish(payload);
    });
    await active.start();
    pid = active.childPid;
    const readyDeadline = Math.min(Date.now() + 60000, deadline);
    while (!active.readiness.snapshot().coreReady && Date.now() < readyDeadline) await pause(200);
    observations.push({ phase, readiness: active.readiness.snapshot(), pid });
    expect(active.readiness.snapshot().coreReady).toBe(true);
    observations.push({ modelHover: await new HoverProvider(config, active).call("diagnostics_probe/model.py", 5, 20) });
    const observe = async (label: string, file: string, text?: string) => {
      phase = label;
      const path = resolve(addon, file);
      const uri = pathToFileURL(path).href;
      if (text !== undefined) await writeFile(path, text);
      await active.open(uri, path);
      if (text !== undefined) active.notify("textDocument/didSave", { textDocument: { uri }, text });
      // Always observe the whole window: the first empty publication is not completion.
      await window(10000);
      const result = { phase, snapshot: active.diagnostics.snapshot(uri), publications: raw.filter((r) => r.phase === phase && r.payload.uri === uri) };
      observations.push(result);
      console.log("XML_CSV_PHASE", JSON.stringify(result));
      return result;
    };
    await observe("xml:startup-open", "view.xml");
    await observe("csv:registered-baseline", "ir.model.access.csv");
    const xmlFixed = await observe("xml:fix-save", "view.xml", goodXml);
    const xmlIssue = await observe("xml:issue-save", "view.xml", badXml);
    const xmlRestored = await observe("xml:restore-save", "view.xml", goodXml);
    const csvIssue = await observe("csv:issue-save", "ir.model.access.csv", goodCsv.replace("model_diagnostics_probe", "model_diagnostics_missing"));
    const csvRestored = await observe("csv:restore-save", "ir.model.access.csv", goodCsv);
    const hasCode = (rows: typeof raw, code: string) => rows.some((r) => r.payload.diagnostics?.some((d) => String(d.code) === code));
    // Keep unsupported coverage a real failure, never weaken assertions to emptiness.
    expect.soft(hasCode(raw.filter((r) => r.phase === "prestartup" || r.phase === "xml:startup-open"), "OLS05005"), "prestartup XML issue").toBe(true);
    expect.soft(hasCode(xmlIssue.publications, "OLS05005"), "saved XML issue").toBe(true);
    expect.soft(hasCode(csvIssue.publications, "OLS05001"), "saved CSV missing model XML ID").toBe(true);
    for (const fixed of [xmlFixed, xmlRestored, csvRestored]) {
      expect.soft(fixed.publications.length, `${fixed.phase}: requires a new publication`).toBeGreaterThan(0);
      expect.soft(fixed.publications.at(-1)?.payload.diagnostics, fixed.phase).toEqual([]);
    }
  } finally {
    pid ??= session?.childPid;
    await session?.stop();
    await rm(root, { recursive: true, force: true });
    const rootAbsent = await lstat(root).then(() => false, (error: NodeJS.ErrnoException) => error.code === "ENOENT");
    let pidAbsent = pid === undefined;
    if (pid !== undefined) {
      try { process.kill(pid, 0); } catch (error) { pidAbsent = (error as NodeJS.ErrnoException).code === "ESRCH"; }
    }
    await writeFile(resolve(evidence, "timeline.json"), JSON.stringify({ root, pid, runtime, core, observations, raw, cleanup: { rootAbsent, pidAbsent } }, null, 2));
    await writeFile(resolve(evidence, "stderr.log"), stderr.join(""));
    console.log("XML_CSV_CLEANUP", JSON.stringify({ evidence, root, pid, rootAbsent, pidAbsent }));
    expect(rootAbsent).toBe(true);
    expect(pidAbsent).toBe(true);
  }
}, 180000);
