import { EventEmitter } from "node:events";
import { realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { z } from "zod";

const point = z.object({ line: z.number().int().nonnegative(), character: z.number().int().nonnegative() });
const finding = z.object({ range: z.object({ start: point, end: point }), message: z.string().transform((v) => v.slice(0, 4096)), severity: z.number().int().min(1).max(4).optional() });
interface Entry { version: number; received: boolean; stale: boolean; uncertain?: boolean; publishedVersion?: number; diagnostics: z.infer<typeof finding>[]; truncated: boolean }

export class DiagnosticsStore extends EventEmitter {
  private entries = new Map<string, Entry>();
  private early = new Map<string, Entry>();
  private closed = new Set<string>();
  private earlyDisabled = false;
  constructor(private readonly workspace?: string) { super(); }
  open(uri: string, version: number): void {
    const old = this.entries.get(uri);
    const early = this.early.get(uri);
    this.early.delete(uri);
    if (!old && this.entries.size >= 256) this.remove(this.entries.keys().next().value!);
    this.entries.set(uri, old ? { ...old, version, stale: old.received } : early ? { ...early, version, uncertain: true } : { version, received: false, stale: false, diagnostics: [], truncated: false });
  }
  remove(uri: string): void {
    this.entries.delete(uri); this.early.delete(uri);
    // Never evict a tombstone and thereby re-admit a delayed publication.
    // Saturation disables speculative adoption until the engine generation ends.
    if (this.closed.size < 256) this.closed.add(uri);
    else if (!this.closed.has(uri)) { this.earlyDisabled = true; this.early.clear(); }
  }
  clear(): void { this.entries.clear(); this.early.clear(); this.closed.clear(); this.earlyDisabled = false; }
  private workspaceUri(uri: string): string | undefined {
    if (!this.workspace || uri.length > 8192) return;
    try {
      const url = new URL(uri);
      if (url.protocol !== "file:" || url.host || url.search || url.hash) return;
      const path = fileURLToPath(url);
      const contained = (candidate: string) => { const rel = relative(this.workspace!, candidate); return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel); };
      if (!contained(path)) return;
      // No source reads or directory walks during indexing; reject symlink escapes.
      const canonical = realpathSync(path);
      if (!contained(canonical) || !statSync(canonical).isFile()) return;
      return pathToFileURL(canonical).href;
    } catch { return; }
  }
  publish(raw: unknown): void {
    const parsed = z.object({ uri: z.string().max(8192), version: z.number().int().optional(), diagnostics: z.custom<unknown[]>(Array.isArray) }).safeParse(raw);
    if (!parsed.success) return;
    let { uri } = parsed.data;
    const { version, diagnostics } = parsed.data;
    if (this.workspace && !this.entries.has(uri)) { const canonical = this.workspaceUri(uri); if (!canonical) return; uri = canonical; }
    const entry = this.entries.get(uri);
    if (!entry && (this.earlyDisabled || this.closed.has(uri))) return;
    const uncertain = version === undefined || version < 0;
    if (entry && !uncertain && version !== entry.version) return;
    // A disk observation cannot supersede a version-matched document publication.
    if (entry?.received && !entry.uncertain && uncertain && (!entry.stale || version !== undefined)) return;
    if (!entry && !this.workspace) return;
    const bounded = z.array(finding).safeParse(diagnostics.slice(0, 100));
    if (!bounded.success) return;
    const observation = { received: true, stale: Boolean(entry?.stale && version !== undefined && version < 0), uncertain, publishedVersion: version, diagnostics: bounded.data, truncated: diagnostics.length > 100 || diagnostics.slice(0, 100).some((item: any) => typeof item?.message === "string" && item.message.length > 4096) };
    if (entry) Object.assign(entry, observation);
    else {
      if (!this.early.has(uri) && this.early.size >= 256) this.early.delete(this.early.keys().next().value!);
      this.early.set(uri, { ...observation, version: 0, uncertain: true });
    }
    this.emit("publication", uri);
  }
  snapshot(uri: string) {
    const entry = this.entries.get(uri);
    return { status: entry?.stale ? "stale" : entry?.received ? "received" : "not_received", received: entry?.received ?? false,
      documentVersion: entry?.version ?? null, publishedVersion: entry?.publishedVersion ?? null,
      freshness: entry?.received && !entry.stale ? entry.uncertain ? "unversioned_uncertain" : "version_matched" : "unknown",
      diagnostics: entry?.diagnostics ?? [], truncated: entry?.truncated ?? false, positionEncoding: "utf-16", positionBase: 0 };
  }
  async wait(uri: string, ms: number, signal?: AbortSignal) {
    signal?.throwIfAborted();
    // A positive wait ends early only on a publication matching the open document version.
    // Inherited pre-open (unversioned) observations keep waiting and stay uncertain on timeout.
    const matched = () => this.snapshot(uri).freshness === "version_matched";
    if (!ms || matched()) return { ...this.snapshot(uri), timedOut: false };
    return new Promise<ReturnType<DiagnosticsStore["snapshot"]> & { timedOut: boolean }>((resolve, reject) => {
      const finish = (timedOut: boolean) => { cleanup(); const result = this.snapshot(uri); resolve({ ...result, status: timedOut && result.status === "not_received" ? "timed_out" : result.status, timedOut }); };
      const publication = (changed: string) => { if (changed === uri && matched()) finish(false); };
      const abort = () => { cleanup(); reject(new Error("cancelled")); };
      const timer = setTimeout(() => finish(true), ms);
      const cleanup = () => { clearTimeout(timer); this.off("publication", publication); signal?.removeEventListener("abort", abort); };
      this.on("publication", publication); signal?.addEventListener("abort", abort, { once: true });
    });
  }
}
