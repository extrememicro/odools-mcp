import { mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { probeRuntime, probeRuntimeHandle } from "../src/runtime/process.js";

const fixture = join(import.meta.dirname, "fixtures/probe.mjs");

describe("bounded runtime probing", () => {
  it("bounds output and reports nonzero exits", async () => {
    await expect(probeRuntime(process.execPath, [fixture, "flood"], { maxOutputBytes: 1000 })).rejects.toThrow(/output limit/);
    await expect(probeRuntime(process.execPath, [fixture, "nonzero"])).rejects.toThrow(/failed \(7\)/);
  });
  it("kills timeout and inherited-pipe process trees", async () => {
    await expect(probeRuntime(process.execPath, [fixture, "hang"], { timeoutMs: 50, termGraceMs: 50 })).rejects.toThrow(/timed out/);
    await expect(probeRuntime(process.execPath, [fixture, "pipes"], { timeoutMs: 50, termGraceMs: 50 })).rejects.toThrow(/timed out/);
  });
  it("starts the TERM to KILL grace period when output overflows", async () => {
    const started = Date.now();
    await expect(probeRuntime(process.execPath, [fixture, "flood-hang"], { timeoutMs: 5000, maxOutputBytes: 1000, termGraceMs: 50 })).rejects.toThrow(/output limit/);
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

describe("descriptor runtime probing", () => {
  it("probes a retained Linux x64 ELF handle for rapid exit, mismatch, timeout, overflow, TERM, spawn failure, and lifecycle", async () => {
    if (process.platform !== "linux" || process.arch !== "x64") return;
    const trueHandle = await open("/usr/bin/true", "r");
    try {
      await expect(probeRuntimeHandle(trueHandle, [])).resolves.toBe("");
      await expect(probeRuntimeHandle(trueHandle, [], { expectedSha256: "00".repeat(32) })).rejects.toThrow(/hash mismatch/);
      await expect(probeRuntimeHandle(trueHandle, [], {
        spawnImpl: (() => { throw new Error("spawn failed"); }) as typeof import("node:child_process").spawn,
      })).rejects.toThrow(/spawn failed/);
    } finally {
      await trueHandle.close();
    }
    await expect(probeRuntimeHandle(trueHandle, [])).rejects.toThrow();

    const sleepHandle = await open("/bin/sleep", "r");
    try {
      await expect(probeRuntimeHandle(sleepHandle, ["10"], { timeoutMs: 50, termGraceMs: 50 })).rejects.toThrow(/timed out/);
    } finally {
      await sleepHandle.close();
    }

    const yesHandle = await open("/usr/bin/yes", "r");
    try {
      const started = Date.now();
      await expect(probeRuntimeHandle(yesHandle, [], { timeoutMs: 5000, maxOutputBytes: 1000, termGraceMs: 50 })).rejects.toThrow(/output limit/);
      expect(Date.now() - started).toBeLessThan(1000);
    } finally {
      await yesHandle.close();
    }
  });

  it("rejects a malformed ELF handle", async () => {
    if (process.platform !== "linux" || process.arch !== "x64") return;
    const root = await mkdtemp(join(tmpdir(), "odools-elf-"));
    try {
      const malformed = join(root, "not-elf");
      await writeFile(malformed, "not an elf");
      const handle = await open(malformed, "r");
      try {
        await expect(probeRuntimeHandle(handle, [])).rejects.toThrow(/not an ELF binary/);
      } finally {
        await handle.close();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
