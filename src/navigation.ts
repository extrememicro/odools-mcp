import type { AdapterConfig } from "./config.js";
import type { LspSession } from "./lsp/session.js";
import { codePointColumnToUtf16, utf16ColumnToCodePoint } from "./lsp/positions.js";
import type { Location, LocationLink, NavigationResult, Range } from "./types.js";

export interface NormalizedLocation { root: string; rootPath: string; range: { start: { line: number; column: number }; end: { line: number; column: number } } }

export class Navigator {
  constructor(private readonly config: AdapterConfig, private readonly session: LspSession) {}

  async call(method: "textDocument/definition" | "textDocument/declaration" | "textDocument/references", path: string, line: number, column: number, signal?: AbortSignal): Promise<{ returned: number; truncated: boolean; locations: NormalizedLocation[]; coldStart?: boolean; startupDurationMs?: number }> {
    const activation = await this.session.ensureStarted(signal);
    const input = await this.config.guard.input(path);
    const lines = input.text.split(/\r?\n/);
    if (!Number.isInteger(line) || line < 1 || line > lines.length) throw new Error("line is outside the document");
    const character = codePointColumnToUtf16(lines[line - 1]!, column);
    await this.session.open(input.uri, input.absolutePath, input.text);
    const params: any = { textDocument: { uri: input.uri }, position: { line: line - 1, character } };
    if (method === "textDocument/references") params.context = { includeDeclaration: true };
    const raw = await this.session.request(method, params, undefined, signal) as NavigationResult;
    const values = raw === null ? [] : Array.isArray(raw) ? raw : [raw];
    const limited = values.slice(0, this.config.maxLocations);
    const locations = await Promise.all(limited.map((value) => this.normalize(value)));
    return { returned: locations.length, truncated: values.length > limited.length, locations, coldStart: activation.coldStart, ...(activation.startupDurationMs === undefined ? {} : { startupDurationMs: activation.startupDurationMs }) };
  }

  private async normalize(value: Location | LocationLink): Promise<NormalizedLocation> {
    const linked = "targetUri" in value;
    const uri = linked ? value.targetUri : value.uri;
    const range = linked ? value.targetSelectionRange ?? value.targetRange : value.range;
    const target = await this.config.guard.returned(uri);
    return { root: target.root, rootPath: target.rootPath, range: await normalizeRange(range, target.text) };
  }
}

async function normalizeRange(range: Range, text: string): Promise<NormalizedLocation["range"]> {
  const lines = text.split(/\r?\n/);
  const convert = (position: { line: number; character: number }) => {
    const content = lines[position.line];
    if (content === undefined) throw new Error("OdooLS returned an invalid line");
    return { line: position.line + 1, column: utf16ColumnToCodePoint(content, position.character) };
  };
  return { start: convert(range.start), end: convert(range.end) };
}
