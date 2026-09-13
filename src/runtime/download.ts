import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { basename, join } from "node:path";
import { open, realpath, stat } from "node:fs/promises";

interface DestinationIdentity { dev: number; ino: number }
export interface AssetStage { readonly directory: string }
const stages = new WeakMap<AssetStage, DestinationIdentity>();

export async function createAssetStage(directory: string): Promise<AssetStage> {
  const canonical = await realpath(directory);
  const info = await stat(canonical);
  if (!info.isDirectory() || (info.mode & 0o777) !== 0o700) throw new Error("Asset stage is not a private directory");
  const capability = Object.freeze({ directory: canonical });
  stages.set(capability, { dev: info.dev, ino: info.ino });
  return capability;
}

async function destinationFor(stage: AssetStage, name: string): Promise<string> {
  const identity = stages.get(stage);
  if (!identity) throw new Error("Invalid asset staging capability");
  if (!name || basename(name) !== name || name === "." || name === ".." || name.includes("\0")) {
    throw new Error("Unsafe asset name");
  }
  const canonical = await realpath(stage.directory);
  const info = await stat(canonical);
  if (!info.isDirectory() || info.dev !== identity.dev || info.ino !== identity.ino || (info.mode & 0o777) !== 0o700) {
    throw new Error("Asset staging capability identity changed");
  }
  return join(canonical, name);
}

function approvedUrl(url: URL, initial: boolean): boolean {
  if (url.protocol !== "https:" || url.username || url.password) return false;
  if (initial && url.hostname === "github.com") return url.pathname.startsWith("/odoo/odoo-ls/releases/download/1.5.2/") && !url.search;
  if (initial && url.hostname === "registry.npmjs.org") return url.pathname === "/typescript/-/typescript-6.0.2.tgz" && !url.search;
  if (!initial && url.hostname === "release-assets.githubusercontent.com") return /^\/github-production-release-asset\/605624319\/[0-9a-f-]+$/.test(url.pathname);
  return false;
}
export function lockIdentity(): string { return `${process.pid}:${Date.now()}:${randomUUID()}`; }
function sameIdentity(actual: DestinationIdentity, expected: DestinationIdentity): boolean { return actual.dev === expected.dev && actual.ino === expected.ino; }

async function removeOwnedDestination(destination: string, identity: DestinationIdentity | undefined): Promise<void> {
  if (!identity) return;
  let current;
  try { current = await stat(destination, { bigint: false }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  if (!current.isFile() || !sameIdentity(current, identity)) return;
  const { unlink } = await import("node:fs/promises");
  await unlink(destination);
}

async function writeBody(response: Response, destination: string, expectedBytes: number): Promise<string> {
  if (!response.body) throw new Error("Runtime download response has no body");
  const declared = response.headers.get("content-length");
  if (declared !== null && Number(declared) !== expectedBytes) throw new Error("Runtime download content-length mismatch");
  const handle = await open(destination, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
  let identity: DestinationIdentity | undefined;
  try {
    const opened = await handle.stat(); identity = { dev: opened.dev, ino: opened.ino };
    const hash = createHash("sha256"); let bytes = 0;
    for await (const chunk of response.body) {
      const data = Buffer.from(chunk); bytes += data.length;
      if (bytes > expectedBytes) throw new Error("Runtime download exceeded expected size");
      await handle.write(data); hash.update(data);
    }
    if (bytes !== expectedBytes) throw new Error("Runtime download size mismatch");
    const after = await handle.stat();
    if (!sameIdentity(after, identity) || after.size !== bytes) throw new Error("Runtime download destination changed");
    return hash.digest("hex");
  } catch (error) {
    try { await removeOwnedDestination(destination, identity); }
    catch (cleanupError) { throw new AggregateError([error, cleanupError], "Runtime download and cleanup failed"); }
    throw error;
  } finally { await handle.close(); }
}

export async function downloadAsset(stage: AssetStage, name: string, url: string, expectedBytes: number, fetchImpl: typeof fetch = fetch): Promise<string> {
  const destination = await destinationFor(stage, name);
  let current = new URL(url);
  if (!approvedUrl(current, true)) throw new Error("Runtime download URL is not approved");
  for (let redirects = 0; redirects <= 1; redirects++) {
    const response = await fetchImpl(current, { redirect: "manual", headers: { "user-agent": "odools-mcp-runtime-installer/1" } });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location || redirects === 1) throw new Error("Runtime download redirect limit exceeded");
      const next = new URL(location, current);
      if (!approvedUrl(next, false)) throw new Error("Runtime download redirect is not approved");
      current = next; continue;
    }
    if (!response.ok) throw new Error(`Runtime download failed: HTTP ${response.status}`);
    return await writeBody(response, destination, expectedBytes);
  }
  throw new Error("Runtime download failed");
}

export async function copyPreseed(stage: AssetStage, name: string, source: string, expectedBytes: number): Promise<string> {
  const destination = await destinationFor(stage, name);
  const canonicalSource = await realpath(source);
  const sourceHandle = await open(canonicalSource, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  let destinationHandle;
  let identity: DestinationIdentity | undefined;
  try {
    const sourceBefore = await sourceHandle.stat();
    if (!sourceBefore.isFile() || sourceBefore.size !== expectedBytes) throw new Error("Preseed asset size mismatch");
    destinationHandle = await open(destination, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
    const opened = await destinationHandle.stat(); identity = { dev: opened.dev, ino: opened.ino };
    const hash = createHash("sha256"); let bytes = 0; const buffer = Buffer.alloc(64 * 1024);
    while (true) {
      const read = await sourceHandle.read(buffer, 0, buffer.length, bytes);
      if (!read.bytesRead) break;
      bytes += read.bytesRead; if (bytes > expectedBytes) throw new Error("Preseed asset exceeded expected size");
      const data = buffer.subarray(0, read.bytesRead); await destinationHandle.write(data); hash.update(data);
    }
    const sourceAfter = await sourceHandle.stat(); const destinationAfter = await destinationHandle.stat();
    if (bytes !== expectedBytes || !sameIdentity(sourceAfter, sourceBefore) || sourceAfter.size !== sourceBefore.size) throw new Error("Preseed asset changed while copying");
    if (!identity || !sameIdentity(destinationAfter, identity) || destinationAfter.size !== bytes) throw new Error("Preseed destination changed while copying");
    return hash.digest("hex");
  } catch (error) {
    try { await removeOwnedDestination(destination, identity); }
    catch (cleanupError) { throw new AggregateError([error, cleanupError], "Preseed copy and cleanup failed"); }
    throw error;
  } finally { await destinationHandle?.close(); await sourceHandle.close(); }
}
