import { createReadStream } from "node:fs";
import { createGunzip } from "node:zlib";
import { lstat, mkdir, open } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import tarStream from "tar-stream";
import yauzl from "yauzl";

export interface ArchiveLimits { maxFiles: number; maxFileBytes: number; maxTotalBytes: number; maxInputBytes: number }
export const RUNTIME_ARCHIVE_LIMITS: ArchiveLimits = { maxFiles: 20_000, maxFileBytes: 32 * 1024 * 1024, maxTotalBytes: 256 * 1024 * 1024, maxInputBytes: 16 * 1024 * 1024 };

class ArchiveGuard {
  private readonly paths = new Map<string, "file" | "directory">();
  private readonly folded = new Map<string, string>();
  private files = 0;
  private total = 0;
  constructor(private readonly limits: ArchiveLimits) {}
  path(input: string, type: "file" | "directory", size: number): string {
    if (!input || input.includes("\0") || input.includes("\\") || input.startsWith("/") || /^[A-Za-z]:/.test(input)) throw new Error(`Unsafe archive path: ${input}`);
    const rawParts = input.split("/");
    if (rawParts.some((part) => part === "..")) throw new Error(`Unsafe archive path: ${input}`);
    const parts = rawParts.filter((part) => part !== "" && part !== ".");
    if (!parts.length) throw new Error(`Unsafe archive path: ${input}`);
    const canonical = parts.join("/"); const folded = canonical.toLocaleLowerCase("en-US");
    if (this.paths.has(canonical)) throw new Error(`Duplicate archive path: ${input}`);
    if (this.folded.has(folded)) throw new Error(`Case-fold archive collision: ${input}`);
    for (let index = 1; index < parts.length; index++) if (this.paths.get(parts.slice(0, index).join("/")) === "file") throw new Error(`Archive file/directory conflict: ${input}`);
    if (type === "file") {
      for (const [known, knownType] of this.paths) if (knownType === "file" && known.startsWith(`${canonical}/`)) throw new Error(`Archive file/directory conflict: ${input}`);
      this.files++; this.total += size;
      if (this.files > this.limits.maxFiles || size > this.limits.maxFileBytes || this.total > this.limits.maxTotalBytes) throw new Error("Archive extraction limits exceeded");
    }
    this.paths.set(canonical, type); this.folded.set(folded, canonical); return canonical;
  }
}

async function writeEntry(stream: NodeJS.ReadableStream, target: string, expected: number): Promise<void> {
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  const parent = await lstat(dirname(target)); if (!parent.isDirectory() || parent.isSymbolicLink()) throw new Error("Unsafe archive parent");
  const handle = await open(target, "wx", 0o600); let written = 0;
  try {
    await new Promise<void>((done, reject) => {
      const output = handle.createWriteStream();
      stream.on("data", (chunk: string | Buffer) => { written += Buffer.byteLength(chunk); if (written > expected) (stream as NodeJS.ReadableStream & { destroy(error: Error): void }).destroy(new Error("Archive entry exceeded declared size")); });
      stream.on("error", reject); output.on("error", reject); output.on("finish", done); stream.pipe(output);
    });
    if (written !== expected) throw new Error("Archive entry size mismatch");
  } finally { await handle.close(); }
}

export async function extractTarGz(archive: string, destination: string, stripFirst = false, limits = RUNTIME_ARCHIVE_LIMITS): Promise<void> {
  await mkdir(destination, { recursive: true, mode: 0o700 }); const root = resolve(destination) + sep; const guard = new ArchiveGuard(limits);
  await new Promise<void>((resolvePromise, reject) => {
    const extract = tarStream.extract(); let settled = false; let inputBytes = 0; let topLevel: string | undefined;
    const originalGuard = new ArchiveGuard(limits);
    const fail = (error: unknown): void => { if (!settled) { settled = true; extract.destroy(); reject(error); } };
    extract.on("entry", (header, stream, next) => { void (async () => {
      if (header.type !== "file" && header.type !== "directory") throw new Error(`Unsafe archive entry type: ${header.type}`);
      let name = header.name;
      if (!stripFirst && (name === "./" || name === ".")) { stream.resume(); stream.once("end", next); return; }
      if (stripFirst) {
        const original = originalGuard.path(name, header.type, header.size ?? 0);
        const components = original.split("/");
        const first = components[0];
        if (!first || components.length < 2) throw new Error(`Unsafe archive path: ${name}`);
        if (topLevel !== undefined && topLevel !== first) throw new Error(`Unsafe archive path: ${name}`);
        topLevel = first;
        name = components.slice(1).join("/");
        if (!name) throw new Error(`Unsafe archive path: ${header.name}`);
      }
      const relative = guard.path(name, header.type, header.size ?? 0); const target = resolve(destination, relative);
      if (!target.startsWith(root)) throw new Error(`Unsafe archive path: ${header.name}`);
      if (header.type === "directory") { await mkdir(target, { recursive: true, mode: 0o700 }); stream.resume(); stream.once("end", next); return; }
      await writeEntry(stream, target, header.size ?? 0); next();
    })().catch(fail); });
    extract.on("finish", () => { if (!settled) { settled = true; resolvePromise(); } }); extract.on("error", fail);
    const input = createReadStream(archive); input.on("data", (chunk: string | Buffer) => { inputBytes += Buffer.byteLength(chunk); if (inputBytes > limits.maxInputBytes) input.destroy(new Error("Archive input limit exceeded")); }); input.on("error", fail);
    const gunzip = createGunzip(); gunzip.on("error", fail); input.pipe(gunzip).pipe(extract);
  });
}

export async function extractOdooTar(archive: string, destination: string): Promise<void> { await extractTarGz(archive, destination); }

export async function extractZip(archive: string, destination: string, limits = RUNTIME_ARCHIVE_LIMITS): Promise<void> {
  await mkdir(destination, { recursive: true, mode: 0o700 }); const root = resolve(destination) + sep; const guard = new ArchiveGuard(limits);
  await new Promise<void>((resolvePromise, reject) => {
    yauzl.open(archive, { lazyEntries: true, decodeStrings: true, validateEntrySizes: true }, (openError, zip) => {
      if (openError || !zip) return reject(openError ?? new Error("Cannot open zip")); if (zip.fileSize > limits.maxInputBytes) { zip.close(); return reject(new Error("Archive input limit exceeded")); }
      let settled = false; const fail = (error: unknown): void => { if (!settled) { settled = true; zip.close(); reject(error); } };
      zip.on("error", fail); zip.on("end", () => { if (!settled) { settled = true; resolvePromise(); } });
      zip.on("entry", (entry) => { void (async () => {
        const mode = (entry.externalFileAttributes >>> 16) & 0xffff; const unixType = mode & 0o170000; const directory = entry.fileName.endsWith("/");
        if (unixType !== 0 && unixType !== 0o100000 && unixType !== 0o040000) throw new Error(`Unsafe archive entry type: ${entry.fileName}`);
        const relative = guard.path(entry.fileName, directory ? "directory" : "file", entry.uncompressedSize); const target = resolve(destination, relative);
        if (!target.startsWith(root)) throw new Error(`Unsafe archive path: ${entry.fileName}`);
        if (directory) { await mkdir(target, { recursive: true, mode: 0o700 }); zip.readEntry(); return; }
        zip.openReadStream(entry, (streamError, stream) => { if (streamError || !stream) return fail(streamError ?? new Error("Cannot read zip entry")); void writeEntry(stream, target, entry.uncompressedSize).then(() => zip.readEntry(), fail); });
      })().catch(fail); }); zip.readEntry();
    });
  });
}
