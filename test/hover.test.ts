import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { HoverProvider, MAX_HOVER_CHARACTERS } from "../src/hover.js";
import type { LspSession } from "../src/lsp/session.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function fixture(raw: unknown) {
  const root = await mkdtemp(resolve(tmpdir(), "odools-hover-")); roots.push(root);
  for (const extension of ["py", "xml", "csv", "js"]) await writeFile(resolve(root, `test.${extension}`), "😀value\n");
  const configPath = resolve(root, "odools.toml");
  await writeFile(configPath, "[[config]]\nname='default'\ndisable_javascript=true\n");
  const config = await loadConfig({ workspace: root, binary: resolve("test/fixtures/fake-lsp.mjs"), config: configPath, watcher: false });
  const session = { ensureStarted: vi.fn(async () => ({ coldStart: true, startupDurationMs: 1 })), open: vi.fn(async () => {}), request: vi.fn(async () => raw) };
  return { hover: new HoverProvider(config, session as unknown as LspSession), session };
}

it.each(["py", "xml"])("normalizes %s hover and Unicode coordinates", async (extension) => {
  const { hover, session } = await fixture({ contents: { kind: "markdown", value: "**value**" }, range: { start: { line: 0, character: 2 }, end: { line: 0, character: 7 } } });
  expect(session.ensureStarted).not.toHaveBeenCalled();
  const signal = new AbortController().signal;
  expect(await hover.call(`test.${extension}`, 1, 2, signal)).toMatchObject({ content: { kind: "markdown", value: "**value**" }, range: { start: { line: 1, column: 2 }, end: { line: 1, column: 7 } }, coldStart: true, noResult: false });
  expect(session.request).toHaveBeenCalledWith("textDocument/hover", expect.objectContaining({ position: { line: 0, character: 2 } }), undefined, signal);
});
it.each(["csv", "js"])("explicitly rejects %s without activation", async (extension) => {
  const { hover, session } = await fixture(null);
  expect(await hover.call(`test.${extension}`, 1, 1)).toMatchObject({ supported: false, noResult: true });
  expect(session.ensureStarted).not.toHaveBeenCalled();
});
it("bounds content without splitting astral characters", async () => {
  const { hover } = await fixture({ contents: { kind: "plaintext", value: "x".repeat(MAX_HOVER_CHARACTERS - 1) + "😀end" } });
  const result = await hover.call("test.py", 1, 1);
  expect(result.truncated).toBe(true);
  expect(result.content?.value).toBe("x".repeat(MAX_HOVER_CHARACTERS - 1));
});
it("distinguishes empty results and rejects malformed ranges/responses", async () => {
  const { hover, session } = await fixture(null);
  expect(await hover.call("test.py", 1, 1)).toMatchObject({ supported: true, noResult: true, content: null });
  for (const raw of [{ contents: 42 }, { contents: "ok", range: { start: { line: 0, character: 1 }, end: { line: 0, character: 2 } } }]) {
    session.request.mockResolvedValueOnce(raw);
    await expect(hover.call("test.py", 1, 1)).rejects.toThrow();
  }
});
it("guards paths/positions and cancellation before activation", async () => {
  const { hover, session } = await fixture(null);
  for (const path of ["../escape.py", "/tmp/escape.py"]) await expect(hover.call(path, 1, 1)).rejects.toThrow();
  await expect(hover.call("test.py", 0, 1)).rejects.toThrow();
  await expect(hover.call("test.py", 1, 99)).rejects.toThrow();
  const controller = new AbortController(); controller.abort();
  await expect(hover.call("test.py", 1, 1, controller.signal)).rejects.toThrow();
  expect(session.ensureStarted).not.toHaveBeenCalled();
});
