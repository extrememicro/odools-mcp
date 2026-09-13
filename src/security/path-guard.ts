import { constants, lstat, open, realpath, type FileHandle } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

function within(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

export type SafeReadOperation = "input" | "watched" | "returned location";

export interface SafeReadHooks {
  afterOpen?: (requestedPath: string, descriptorPath: string, operation: SafeReadOperation) => void | Promise<void>;
}

export interface SafeFile {
  absolutePath: string;
  uri: string;
  text: string;
}

export interface RootedSafeFile extends SafeFile {
  root: string;
  rootPath: string;
}

export class PathGuard {
  private constructor(readonly workspaceRoot: string, readonly allowedRoots: string[], private readonly hooks: SafeReadHooks = {}) {}

  static async create(workspaceRoot: string, roots: string[], hooks: SafeReadHooks = {}): Promise<PathGuard> {
    const canonicalWorkspace = await realpath(workspaceRoot);
    const canonicalRoots = await Promise.all(roots.map((root) => realpath(root)));
    if (!canonicalRoots.some((root) => root === canonicalWorkspace)) canonicalRoots.unshift(canonicalWorkspace);
    return new PathGuard(canonicalWorkspace, [...new Set(canonicalRoots)], hooks);
  }

  async input(relativePath: string): Promise<SafeFile> {
    if (!relativePath || isAbsolute(relativePath) || relativePath.includes("\0")) throw new Error("path must be workspace-relative");
    const lexical = resolve(this.workspaceRoot, relativePath);
    if (!within(this.workspaceRoot, lexical)) throw new Error("path escapes workspace");
    return await this.safeRead(lexical, [this.workspaceRoot], "input");
  }

  async watched(absolutePath: string): Promise<SafeFile> {
    if (!isAbsolute(absolutePath) || absolutePath.includes("\0")) throw new Error("watched path must be absolute");
    return await this.safeRead(resolve(absolutePath), this.allowedRoots, "watched");
  }

  async returned(uri: string): Promise<RootedSafeFile> {
    let path: string;
    try {
      const parsed = new URL(uri);
      if (parsed.protocol !== "file:" || parsed.hostname) throw new Error("only local file URIs are accepted");
      path = fileURLToPath(parsed);
    } catch (error) {
      throw new Error(`invalid returned URI: ${String(error)}`);
    }
    const file = await this.safeRead(resolve(path), this.allowedRoots, "returned location");
    const rootIndex = this.allowedRoots.findIndex((root) => within(root, file.absolutePath));
    if (rootIndex < 0) throw new Error("returned location escapes configured roots");
    const rootPath = relative(this.allowedRoots[rootIndex]!, file.absolutePath).split(sep).join("/");
    return { ...file, root: rootIndex === 0 ? "workspace" : `addon-${rootIndex}`, rootPath: rootPath || "." };
  }

  private async safeRead(requestedPath: string, roots: string[], label: SafeReadOperation): Promise<SafeFile> {
    // Linux provides O_NOFOLLOW plus /proc/self/fd, allowing validation of the opened object rather than a pre-open pathname.
    // Other Node platforms without O_NOFOLLOW or /proc must fail closed; confinement is never silently weakened.
    const noFollow = constants.O_NOFOLLOW;
    if (process.platform !== "linux" || noFollow === undefined) throw new Error("safe confined reads require Linux O_NOFOLLOW and /proc/self/fd");
    let handle: FileHandle | undefined;
    try {
      handle = await open(requestedPath, constants.O_RDONLY | noFollow);
      const opened = await handle.stat();
      if (!opened.isFile()) throw new Error(`${label} is not a regular file`);
      const descriptorPath = await realpath(`/proc/self/fd/${handle.fd}`);
      if (!roots.some((root) => within(root, descriptorPath))) throw new Error(`${label} escapes configured roots`);
      await this.hooks.afterOpen?.(requestedPath, descriptorPath, label);
      const text = await handle.readFile("utf8");
      const current = await lstat(requestedPath).catch(() => null);
      if (!current || current.isSymbolicLink() || current.dev !== opened.dev || current.ino !== opened.ino) {
        throw new Error(`${label} changed during secure read`);
      }
      return { absolutePath: descriptorPath, uri: pathToFileURL(descriptorPath).href, text };
    } finally {
      await handle?.close();
    }
  }
}
