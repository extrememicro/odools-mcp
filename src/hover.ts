import { extname } from "node:path";
import { z } from "zod";
import type { AdapterConfig } from "./config.js";
import type { LspSession } from "./lsp/session.js";
import { codePointColumnToUtf16, utf16ColumnToCodePoint } from "./lsp/positions.js";

export const MAX_HOVER_CHARACTERS = 16_384;
const point = z.object({ line: z.number().int().nonnegative(), character: z.number().int().nonnegative() });
const marked = z.union([z.string(), z.object({ language: z.string(), value: z.string() })]);
const hoverSchema = z.object({
  contents: z.union([z.object({ kind: z.enum(["markdown", "plaintext"]), value: z.string() }), marked, z.array(marked)]),
  range: z.object({ start: point, end: point }).optional(),
});

export class HoverProvider {
  constructor(private readonly config: AdapterConfig, private readonly session: LspSession) {}

  async call(path: string, line: number, column: number, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const input = await this.config.guard.input(path);
    const lines = input.text.split(/\r?\n/);
    if (!Number.isInteger(line) || line < 1 || line > lines.length) throw new Error("line is outside the document");
    const character = codePointColumnToUtf16(lines[line - 1]!, column);
    const extension = extname(input.absolutePath);
    if (extension !== ".py" && extension !== ".xml") {
      return { content: null, range: null, truncated: false, supported: false, noResult: true };
    }
    const activation = await this.session.ensureStarted(signal);
    signal?.throwIfAborted();
    await this.session.open(input.uri, input.absolutePath, input.text);
    const raw = await this.session.request("textDocument/hover", {
      textDocument: { uri: input.uri }, position: { line: line - 1, character },
    }, undefined, signal);
    if (raw === null) return { content: null, range: null, truncated: false, supported: true, noResult: true, ...activation };
    const parsed = hoverSchema.safeParse(raw);
    if (!parsed.success) throw new Error("Invalid hover response from OdooLS");
    const hover = parsed.data;
    const contents = hover.contents;
    let kind: "markdown" | "plaintext" = "markdown";
    let value: string;
    if (typeof contents === "object" && !Array.isArray(contents) && "kind" in contents) {
      kind = contents.kind;
      value = contents.value;
    } else {
      const values = Array.isArray(contents) ? contents : [contents];
      value = values.map((item) => typeof item === "string" ? item : item.value).join("\n\n");
    }
    const convert = (position: z.infer<typeof point>) => {
      const text = lines[position.line];
      if (text === undefined) throw new Error("Hover range is outside the document");
      return { line: position.line + 1, column: utf16ColumnToCodePoint(text, position.character) };
    };
    const range = hover.range ? { start: convert(hover.range.start), end: convert(hover.range.end) } : null;
    if (range && (range.start.line > range.end.line || (range.start.line === range.end.line && range.start.column > range.end.column))) throw new Error("Hover range is reversed");
    const truncated = value.length > MAX_HOVER_CHARACTERS;
    let bounded = value.slice(0, MAX_HOVER_CHARACTERS);
    if (truncated && /[\uD800-\uDBFF]$/.test(bounded)) bounded = bounded.slice(0, -1);
    return { content: bounded ? { kind, value: bounded } : null, range, truncated, supported: true, noResult: !bounded, ...activation };
  }
}
