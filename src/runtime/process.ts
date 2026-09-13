import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import type { FileHandle } from "node:fs/promises";

export interface ProbeOptions {
  timeoutMs?: number;
  maxOutputBytes?: number;
  termGraceMs?: number;
  spawnImpl?: typeof spawn;
  expectedSha256?: string;
}

async function assertExecutableHandle(
  handle: FileHandle,
  expectedSha256?: string,
): Promise<void> {
  if (process.platform !== "linux" || process.arch !== "x64") {
    throw new Error("Verified-descriptor runtime execution requires Linux x64");
  }
  const info = await handle.stat();
  if (!info.isFile()) throw new Error("Runtime executable handle is not a regular file");
  if (info.size > 64 * 1024 * 1024) throw new Error("Runtime executable exceeds validation size limit");
  const data = Buffer.alloc(info.size);
  let offset = 0;
  while (offset < data.length) {
    const { bytesRead } = await handle.read(data, offset, data.length - offset, offset);
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  const after = await handle.stat();
  if (offset !== info.size || after.size !== info.size) {
    throw new Error("Runtime executable changed while validating retained handle");
  }
  if (expectedSha256 && createHash("sha256").update(data).digest("hex") !== expectedSha256) {
    throw new Error("Runtime executable retained-handle hash mismatch");
  }
  const header = data.subarray(0, 64);
  if (header.length < 64 || !header.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) {
    throw new Error("Runtime executable is not an ELF binary");
  }
  if (header[4] !== 2) throw new Error("Runtime executable must be 64-bit ELF");
  if (header[5] !== 1) throw new Error("Runtime executable must be little-endian ELF");
  if (header[6] !== 1) throw new Error("Runtime executable has an unsupported ELF version");
  if (header[7] !== 0 && header[7] !== 3) throw new Error("Runtime executable has an unsupported ELF ABI");
  if (header[8] !== 0) throw new Error("Runtime executable has an unsupported ELF ABI version");
  const type = header.readUInt16LE(16);
  if (type !== 2 && type !== 3) throw new Error("Runtime executable must be ET_EXEC or ET_DYN");
  if (header.readUInt16LE(18) !== 62) throw new Error("Runtime executable must target x86_64");
}

export async function probeRuntime(command: string, args: string[], options: ProbeOptions = {}): Promise<string> {
  return await runProbe(command, args, ["ignore", "pipe", "pipe"], options);
}

export async function probeRuntimeHandle(handle: FileHandle, args: string[], options: ProbeOptions = {}): Promise<string> {
  await assertExecutableHandle(handle, options.expectedSha256);
  return await runProbe(`/proc/${process.pid}/fd/${handle.fd}`, args, ["ignore", "pipe", "pipe"], options);
}

async function runProbe(
  command: string,
  args: string[],
  stdio: ["ignore", "pipe", "pipe"],
  options: ProbeOptions,
): Promise<string> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const max = options.maxOutputBytes ?? 16_384;
  const grace = options.termGraceMs ?? 250;
  return await new Promise((resolvePromise, reject) => {
    let child;
    try {
      child = (options.spawnImpl ?? spawn)(command, args, {
        stdio,
        detached: process.platform !== "win32",
      });
    } catch (error) {
      reject(error);
      return;
    }
    let output = Buffer.alloc(0);
    let settled = false;
    let reason: Error | undefined;
    let graceTimer: NodeJS.Timeout | undefined;
    const killTree = (signal: NodeJS.Signals): void => {
      try { process.kill(process.platform === "win32" ? child.pid! : -child.pid!, signal); }
      catch { try { child.kill(signal); } catch { /* already gone */ } }
    };
    const stop = (error: Error): void => {
      if (reason) return;
      reason = error;
      killTree("SIGTERM");
      graceTimer = setTimeout(() => killTree("SIGKILL"), grace);
      graceTimer.unref();
    };
    const timer = setTimeout(() => stop(new Error(`Runtime probe timed out after ${timeoutMs}ms`)), timeoutMs);
    timer.unref();
    const consume = (chunk: Buffer): void => {
      if (reason) return;
      if (output.length + chunk.length > max) {
        stop(new Error(`Runtime probe output limit exceeded (${max} bytes)`));
        return;
      }
      output = Buffer.concat([output, chunk]);
    };
    child.stdout.on("data", consume);
    child.stderr.on("data", consume);
    child.once("error", (error) => stop(error));
    child.once("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (graceTimer) clearTimeout(graceTimer);
      if (reason) reject(reason);
      else if (code !== 0) reject(new Error(`Runtime probe failed (${String(code)})${signal ? ` (${signal})` : ""}: ${output.toString("utf8").trim()}`));
      else resolvePromise(output.toString("utf8").trim());
    });
  });
}
