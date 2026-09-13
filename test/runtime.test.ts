import { chmod, copyFile, lstat, mkdtemp, mkdir, open, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { inspectExistingLock, installRuntime, quarantineAndUnlink, verifyRuntime } from "../src/runtime/manager.js";
import { probeRuntimeHandle } from "../src/runtime/process.js";

const retained = resolve(process.env.ODOOLS_RUNTIME_ASSETS ?? "../@tmp/odools-1.5.2/downloads");
let root: string;
const manifestName = "runtime-manifest.json";
const preseed = {
  odools: join(retained, "odoo-linux-x86_64-1.5.2.tar.gz"),
  typeshed: join(retained, "typeshed.zip"),
  typescript: join(retained, "typescript-6.0.2.tgz"),
};

beforeAll(async () => { root = await mkdtemp(join(tmpdir(), "odools-runtime-test-")); });
afterAll(async () => { await rm(root, { recursive: true, force: true }); });

async function mutateWithInventory(runtimeDir: string, relative: string, mutate: () => Promise<void>): Promise<void> {
  const manifestPath = join(runtimeDir, manifestName);
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
    inventory: Array<{ path: string; type: "file" | "directory"; sha256?: string; size?: number; mode: number }>;
  };
  await mutate();
  const entry = manifest.inventory.find((candidate) => candidate.path === relative);
  if (!entry || entry.type !== "file") throw new Error(`Missing inventory entry: ${relative}`);
  const { createHash } = await import("node:crypto");
  const data = await readFile(join(runtimeDir, ...relative.split("/")));
  entry.sha256 = createHash("sha256").update(data).digest("hex");
  entry.size = data.length;
  await writeFile(manifestPath, JSON.stringify(manifest));
}

async function writeDeadLock(path: string, ageMs: number): Promise<void> {
  await writeFile(path, `2147483647:${Date.now() - ageMs}:00000000-0000-4000-8000-000000000000\n`, { mode: 0o600 });
}

describe("managed runtime", () => {
  it("installs retained official assets offline without invoking downloader", async () => {
    const runtimeDir = join(root, "valid"); const downloader = vi.fn(async () => { throw new Error("network called"); });
    const result = await installRuntime({ version: "1.5.2", runtimeDir, preseed, downloader, now: () => new Date("2026-09-10T00:00:00.000Z") });
    expect(downloader).not.toHaveBeenCalled(); expect(result.binary).toContain(runtimeDir);
    await expect(verifyRuntime(runtimeDir)).resolves.toEqual(result);
    const manifest = JSON.parse(await readFile(result.manifest, "utf8")) as { installedAt: string; odools: { commit: string } };
    expect(manifest).toMatchObject({ installedAt: "2026-09-10T00:00:00.000Z", odools: { commit: "ec189919c30ab0ece0d63410695e6a49d891a821" } });
  }, 60_000);

  it("returns idempotent success without any filesystem writes", async () => {
    const runtimeDir = join(root, "preserved");
    const first = await installRuntime({ version: "1.5.2", runtimeDir, preseed });
    const snapshot = async () => {
      const names = (await readdir(root)).filter((name) => name.startsWith("preserved")).sort();
      return await Promise.all(names.map(async (name) => {
        const path = join(root, name);
        const info = await lstat(path);
        return [name, info.dev, info.ino, info.mode, info.size, info.mtimeMs];
      }));
    };
    const before = await snapshot();
    const downloader = vi.fn(async () => { throw new Error("network called"); });
    await expect(installRuntime({ version: "1.5.2", runtimeDir, downloader })).resolves.toEqual(first);
    expect(downloader).not.toHaveBeenCalled();
    expect(await snapshot()).toEqual(before);
    expect((await readdir(root)).filter((name) => /preserved.*(?:lock|stage|asset|backup|pending|quarantine)/.test(name))).toEqual([]);
  }, 60_000);

  it("refuses an invalid existing runtime without replacing or touching it", async () => {
    const runtimeDir = join(root, "invalid-existing");
    await mkdir(runtimeDir, { mode: 0o700 });
    await writeFile(join(runtimeDir, "attacker"), "preserve", { mode: 0o600 });
    const rootBefore = await lstat(runtimeDir);
    const fileBefore = await lstat(join(runtimeDir, "attacker"));
    await expect(installRuntime({ version: "1.5.2", runtimeDir, preseed })).rejects.toThrow(/Existing runtime failed verification/);
    expect(await readFile(join(runtimeDir, "attacker"), "utf8")).toBe("preserve");
    const rootAfter = await lstat(runtimeDir);
    const fileAfter = await lstat(join(runtimeDir, "attacker"));
    expect([rootAfter.dev, rootAfter.ino, rootAfter.mtimeMs]).toEqual([rootBefore.dev, rootBefore.ino, rootBefore.mtimeMs]);
    expect([fileAfter.dev, fileAfter.ino, fileAfter.size, fileAfter.mtimeMs]).toEqual([fileBefore.dev, fileBefore.ino, fileBefore.size, fileBefore.mtimeMs]);
  });

  it("rejects TypeScript chain and lock tampering even with a matching mutable inventory", async () => {
    const runtimeDir = join(root, "typescript-authority");
    await installRuntime({ version: "1.5.2", runtimeDir, preseed });
    const tsserverLibrary = "typescript/node_modules/typescript/lib/tsserver.js";
    await mutateWithInventory(runtimeDir, tsserverLibrary, async () => {
      await writeFile(join(runtimeDir, ...tsserverLibrary.split("/")), "module.exports = require(\"./_tsserver.js\")\n");
    });
    await expect(verifyRuntime(runtimeDir)).rejects.toThrow(/TypeScript critical file mismatch/);

    await rm(runtimeDir, { recursive: true, force: true });
    await installRuntime({ version: "1.5.2", runtimeDir, preseed });
    const lockPath = "typescript/package-lock.json";
    await mutateWithInventory(runtimeDir, lockPath, async () => {
      const installedLock = join(runtimeDir, ...lockPath.split("/"));
      const lock = JSON.parse(await readFile(installedLock, "utf8")) as { packages: Record<string, { integrity?: string }> };
      lock.packages["node_modules/typescript"]!.integrity = "sha512-tampered";
      await writeFile(installedLock, JSON.stringify(lock));
    });
    await expect(verifyRuntime(runtimeDir)).rejects.toThrow();
  }, 60_000);

  it("rejects installed file and manifest tampering", async () => {
    const runtimeDir = join(root, "tamper"); const installed = await installRuntime({ version: "1.5.2", runtimeDir, preseed });
    await chmod(installed.tsserver, 0o702); await expect(verifyRuntime(runtimeDir)).rejects.toThrow(/inventory|permissions/);
    await chmod(installed.tsserver, 0o700); const manifest = JSON.parse(await readFile(installed.manifest, "utf8")) as { odools: { commit: string } };
    manifest.odools.commit = "editable"; await writeFile(installed.manifest, JSON.stringify(manifest));
    await expect(verifyRuntime(runtimeDir)).rejects.toThrow(/invalid_value|provenance/);
  }, 60_000);

  it("rejects unsafe, live, and non-expired installation locks", async () => {
    const base = join(root, "lock-validation");
    const live = `${base}-live`;
    await writeFile(live, `${process.pid}:${Date.now()}:00000000-0000-4000-8000-000000000000\n`, { mode: 0o600 });
    await expect(inspectExistingLock(live)).rejects.toThrow(/already in progress/);

    const recent = `${base}-recent`;
    await writeDeadLock(recent, 1000);
    await expect(inspectExistingLock(recent)).rejects.toThrow(/cannot be confirmed/);

    const malformed = `${base}-malformed`;
    await writeFile(malformed, "not-a-lock\n", { mode: 0o600 });
    await expect(inspectExistingLock(malformed)).rejects.toThrow(/malformed/);

    const symlinkPath = `${base}-symlink`;
    await symlink(malformed, symlinkPath);
    await expect(inspectExistingLock(symlinkPath)).rejects.toThrow(/unsafe/);
  });

  it("reclaims a stale lock and permits only one concurrent reclaimer", async () => {
    const exclusive = join(root, "exclusive-lock");
    await writeDeadLock(exclusive, 3_600_001);
    const identity = await lstat(exclusive);
    const outcomes = await Promise.allSettled([
      quarantineAndUnlink(exclusive, identity),
      quarantineAndUnlink(exclusive, identity),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled").length).toBeLessThanOrEqual(1);
    expect(outcomes.filter((outcome) => outcome.status === "rejected").length).toBeGreaterThanOrEqual(1);
  });

  it("rejects concurrent lock and unsupported platforms", async () => {
    const runtimeDir = join(root, "locked"); const lock = await open(`${runtimeDir}.install.lock`, "wx"); await lock.writeFile(`${process.pid}:${Date.now()}:00000000-0000-4000-8000-000000000000\n`);
    try { await expect(installRuntime({ version: "1.5.2", runtimeDir, preseed })).rejects.toThrow(/already in progress/); }
    finally { await lock.close(); await rm(`${runtimeDir}.install.lock`); }
    await expect(installRuntime({ version: "1.5.2", runtimeDir: join(root, "unsupported"), preseed, platform: "darwin", arch: "arm64" })).rejects.toThrow(/Unsupported runtime platform/);
  });

  it("uses the bounded downloader seam for online mode", async () => {
    const runtimeDir = join(root, "online");
    const downloader = vi.fn(async (stage: { directory: string }, name: string, url: string) => {
      const source = url.includes("odoo-linux") ? preseed.odools : url.includes("typeshed") ? preseed.typeshed : preseed.typescript;
      await copyFile(source, join(stage.directory, name));
    });
    await installRuntime({ version: "1.5.2", runtimeDir, downloader });
    expect(downloader).toHaveBeenCalledTimes(3); await expect(verifyRuntime(runtimeDir)).resolves.toBeDefined();
  }, 60_000);

  it("rejects unsafe runtime-dir symlink", async () => {
    const target = join(root, "target"); await mkdir(target); const link = join(root, "link");
    await symlink(target, link);
    await expect(installRuntime({ version: "1.5.2", runtimeDir: link, preseed })).rejects.toThrow(/unsafe|symlink/);
  });

  it("rejects unexpected directories, unsafe directory modes, and nested substitutions", async () => {
    const runtimeDir = join(root, "directory-inventory");
    await installRuntime({ version: "1.5.2", runtimeDir, preseed });
    await mkdir(join(runtimeDir, "unexpected"), { mode: 0o700 });
    await expect(verifyRuntime(runtimeDir)).rejects.toThrow(/inventory/);
    await rm(join(runtimeDir, "unexpected"), { recursive: true });

    const typescriptDirectory = join(runtimeDir, "typescript");
    await chmod(typescriptDirectory, 0o777);
    await expect(verifyRuntime(runtimeDir)).rejects.toThrow(/unsafe|inventory/);
    await chmod(typescriptDirectory, 0o700);

    const lib = join(runtimeDir, "typescript/node_modules/typescript/lib");
    const moved = `${lib}-real`;
    await rename(lib, moved);
    await symlink(moved, lib);
    await expect(verifyRuntime(runtimeDir)).rejects.toThrow(/unsafe|symlink|inventory/);
  }, 60_000);

  it("publishes the manifest last into an exclusively claimed directory", async () => {
    const runtimeDir = join(root, "manifest-last");
    await installRuntime({ version: "1.5.2", runtimeDir, preseed });
    const names = await readdir(runtimeDir);
    expect(names).toContain("runtime-manifest.json");
    expect(names).toContain("odoo_ls_server");
    await expect(verifyRuntime(runtimeDir)).resolves.toBeDefined();
  }, 60_000);

  it("recovers from interrupted pre-marker state and lets a later installer claim the directory", async () => {
    const runtimeDir = join(root, "pre-marker");
    await mkdir(runtimeDir, { mode: 0o700 });
    await writeFile(join(runtimeDir, "odoo_ls_server"), "incomplete", { mode: 0o700 });
    await expect(installRuntime({ version: "1.5.2", runtimeDir, preseed })).rejects.toThrow(/Existing runtime failed verification/);
    await rm(runtimeDir, { recursive: true, force: true });
    await expect(installRuntime({ version: "1.5.2", runtimeDir, preseed })).resolves.toBeDefined();
    await expect(verifyRuntime(runtimeDir)).resolves.toBeDefined();
  }, 60_000);

  it("lets only one concurrent installer publish a valid runtime", async () => {
    const runtimeDir = join(root, "concurrent-install");
    const outcomes = await Promise.allSettled([
      installRuntime({ version: "1.5.2", runtimeDir, preseed }),
      installRuntime({ version: "1.5.2", runtimeDir, preseed }),
    ]);
    const fulfilled = outcomes.filter((outcome) => outcome.status === "fulfilled");
    const rejected = outcomes.filter((outcome) => outcome.status === "rejected");
    expect(fulfilled.length).toBeGreaterThanOrEqual(1);
    expect(fulfilled.length + rejected.length).toBe(2);
    if (rejected.length) {
      expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
        message: expect.stringMatching(/already in progress|appeared during installation|failed verification/),
      });
    }
    await expect(verifyRuntime(runtimeDir)).resolves.toBeDefined();
  }, 60_000);

  it("directly probes a retained official ELF handle and enforces lifecycle", async () => {
    if (process.platform !== "linux" || process.arch !== "x64") return;
    const runtimeDir = join(root, "direct-handle");
    const installed = await installRuntime({ version: "1.5.2", runtimeDir, preseed });
    const handle = await open(installed.binary, "r");
    await expect(probeRuntimeHandle(handle, ["--version"])).resolves.toBe("odoo_ls_server 1.5.2");
    await expect(probeRuntimeHandle(handle, ["--version"], { expectedSha256: "00".repeat(32) })).rejects.toThrow(/hash mismatch/);
    await handle.close();
    await expect(probeRuntimeHandle(handle, ["--version"])).rejects.toThrow();
  }, 60_000);

});
