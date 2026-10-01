import chokidar, { type FSWatcher } from "chokidar";
import { pathToFileURL } from "node:url";
import { lstat } from "node:fs/promises";
import { basename, extname, relative, sep } from "node:path";
import type { PathGuard, SafeFile } from "../security/path-guard.js";

export type WatchedFileChange =
  | { kind: "content"; file: SafeFile }
  | { kind: "delete"; uri: string };

const EXTENSIONS = new Set([".py", ".pyi", ".xml", ".csv", ".js", ".ts"]);
const IGNORED_PARTS = new Set([".git", "node_modules", ".cache", "__pycache__", ".mypy_cache", ".pytest_cache", ".ruff_cache", "dist", "build", ".venv", "venv", "runtime"]);

function within(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`));
}

function relevant(path: string): boolean {
  const name = basename(path);
  return EXTENSIONS.has(extname(path).toLowerCase()) || name === "__manifest__.py" || name === "__openerp__.py";
}

export class SourceWatcher {
  private watcher?: FSWatcher;
  private timer?: NodeJS.Timeout;
  private pending = new Map<string, "content" | "delete">();
  private knownFiles = new Map<string, string>();
  private ready = false;
  private cancelStart?: () => void;
  private flushChain = Promise.resolve();
  private generation = 0;
  private delivery = new AbortController();

  constructor(
    private readonly roots: string[],
    private readonly guard: PathGuard,
    private readonly debounceMs: number,
    private readonly onChanges: (changes: WatchedFileChange[], signal: AbortSignal) => void | Promise<void>,
    private readonly onError: (error: Error) => void,
  ) {}

  async start(): Promise<void> {
    if (this.watcher) return;
    const generation = ++this.generation;
    this.delivery = new AbortController();
    this.watcher = chokidar.watch(this.roots, {
      persistent: true,
      ignoreInitial: false,
      followSymlinks: false,
      usePolling: false,
      awaitWriteFinish: { stabilityThreshold: this.debounceMs, pollInterval: Math.min(50, this.debounceMs) },
      ignored: (path, stats) => {
        if (stats?.isSymbolicLink()) return true;
        if (!this.roots.some((root) => within(root, path))) return true;
        const parts = path.split(sep); if (parts.some((part) => IGNORED_PARTS.has(part))) return true;
        return stats?.isFile() === true && !relevant(path);
      },
    });
    // Initial discovery records names only. Content is confined and read only on changes.
    this.watcher.on("add", (path) => {
      if (this.ready) void this.accept(path, "content");
      else if (this.roots.some((root) => within(root, path)) && relevant(path)) this.knownFiles.set(path, pathToFileURL(path).href);
    });
    this.watcher.on("change", (path) => void this.accept(path, "content"));
    this.watcher.on("unlink", (path) => { if (this.knownFiles.has(path)) void this.accept(path, "delete"); });
    await new Promise<void>((resolve, reject) => {
      this.cancelStart = () => reject(new Error("watcher startup cancelled"));
      this.watcher!.once("ready", () => {
        if (generation !== this.generation) return;
        this.ready = true;
        this.cancelStart = undefined;
        resolve();
      });
      this.watcher!.on("error", (error) => { reject(error); if (generation === this.generation) this.report(error); });
    });
  }

  async close(): Promise<void> {
    ++this.generation;
    this.delivery.abort();
    this.cancelStart?.(); this.cancelStart = undefined;
    this.ready = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.pending.clear();
    const watcher = this.watcher;
    this.watcher = undefined;
    this.knownFiles.clear();
    if (watcher) await watcher.close();
    // In-flight secure reads cannot be cancelled; generation checks discard their results.
  }

  private async validate(path: string): Promise<SafeFile | undefined> {
    const generation = this.generation;
    try {
      if ((await lstat(path)).isSymbolicLink()) throw new Error("symbolic links are not watchable");
      const file = await this.guard.watched(path);
      if (generation !== this.generation) return undefined;
      this.knownFiles.set(path, file.uri);
      return file;
    } catch { if (generation === this.generation) this.knownFiles.delete(path); return undefined; }
  }

  private async accept(path: string, kind: "content" | "delete"): Promise<void> {
    const generation = this.generation;
    if (!this.watcher || !this.roots.some((root) => within(root, path)) || !relevant(path)) return;
    if (kind === "delete" && !this.knownFiles.has(path)) return;
    if (kind === "content" && !await this.validate(path)) return;
    if (generation !== this.generation) return;
    this.pending.set(path, kind);
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.enqueueFlush(generation), this.debounceMs);
  }

  private enqueueFlush(generation: number): void {
    this.timer = undefined;
    const batch = this.pending;
    this.pending = new Map();
    this.flushChain = this.flushChain.then(async () => {
      if (generation !== this.generation) return;
      const changes: WatchedFileChange[] = [];
      for (const [path, kind] of batch) {
        if (generation !== this.generation) return;
        if (kind === "delete") {
          const uri = this.knownFiles.get(path);
          this.knownFiles.delete(path);
          if (uri) changes.push({ kind, uri });
        } else {
          const file = await this.validate(path);
          if (file) changes.push({ kind, file });
        }
      }
      if (changes.length && generation === this.generation) await this.onChanges(changes, this.delivery.signal);
    }).catch((error) => { if (generation === this.generation) this.report(error); });
  }

  private report(error: unknown): void {
    this.onError(new Error(`watcher error: ${String(error).slice(0, 160)}`));
  }
}
