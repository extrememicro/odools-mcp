import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { constants as fsConstants } from "node:fs";
import {
  access,
  chmod,
  copyFile,
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  realpath,
  rename,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import { z } from "zod";
import { extractOdooTar, extractTarGz, extractZip } from "./archive.js";
import { copyPreseed, createAssetStage, downloadAsset, lockIdentity, type AssetStage } from "./download.js";
import { probeRuntimeHandle } from "./process.js";
import {
  type AssetSpec,
  RUNTIME_CHANNEL,
  RUNTIME_COMMIT,
  RUNTIME_SCHEMA,
  RUNTIME_TAG,
  RUNTIME_VERSION,
  runtimeSpec,
  TYPESCRIPT_INTEGRITY,
  TYPESCRIPT_VERSION,
} from "./constants.js";

export interface PreseedAssets {
  odools: string;
  typeshed: string;
  typescript: string;
}

export interface InstallOptions {
  version: string;
  runtimeDir: string;
  preseed?: PreseedAssets;
  platform?: string;
  arch?: string;
  downloader?: (
    stage: AssetStage,
    name: string,
    url: string,
    expectedBytes: number,
  ) => Promise<string | void>;
  now?: () => Date;
}

export interface RuntimePaths {
  binary: string;
  tsserver: string;
  manifest: string;
  warnings?: string[];
}

interface PathIdentity {
  dev: number;
  ino: number;
}

interface FileInventoryEntry {
  path: string;
  type: "file";
  sha256: string;
  size: number;
  mode: number;
}

interface DirectoryInventoryEntry {
  path: string;
  type: "directory";
  mode: number;
}

type InventoryEntry = FileInventoryEntry | DirectoryInventoryEntry;

const MANIFEST = "runtime-manifest.json";
const ADAPTER_VERSION = "0.1.0";
const LOCK_STALE_MS = 3_600_000;
const BINARY_SHA256 =
  "4c5a50d781d890838429a3ba1ff36c0bc5746e4ea325598967f6328bf4a2abe5";
const TS_SERVER_PATH = "typescript/node_modules/typescript/bin/tsserver";
const TS_CRITICAL = {
  "typescript/node_modules/typescript/package.json":
    "bb6ee7e709ae60426e30b8d393df4d939ee61407794b4f053ce6338d6eaa8c63",
  "typescript/node_modules/typescript/bin/tsserver":
    "a088f0c3419bcb2f7b860ad42e4c9f25ead067eda70af6a10d0a7d453954aada",
  "typescript/node_modules/typescript/lib/tsserver.js":
    "e3ccfeec65ec5c470b8ffc5611878a31182650c7e8a062c38a719f83b523edcb",
  "typescript/node_modules/typescript/lib/_tsserver.js":
    "1992fc3518a4aa5443638a25794281995ec3ce84820692713296262997d5443b",
} as const;

const fileInventorySchema = z
  .object({
    path: z.string(),
    type: z.literal("file"),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    size: z.number().int().nonnegative(),
    mode: z.number().int(),
  })
  .strict();
const directoryInventorySchema = z
  .object({
    path: z.string(),
    type: z.literal("directory"),
    mode: z.number().int(),
  })
  .strict();
const inventorySchema = z.discriminatedUnion("type", [
  fileInventorySchema,
  directoryInventorySchema,
]);
const manifestSchema = z
  .object({
    schema: z.literal(RUNTIME_SCHEMA),
    adapterVersion: z.literal(ADAPTER_VERSION),
    installedAt: z.iso.datetime({ offset: false }),
    platform: z.literal("linux"),
    arch: z.literal("x64"),
    odools: z
      .object({
        channel: z.literal(RUNTIME_CHANNEL),
        version: z.literal(RUNTIME_VERSION),
        tag: z.literal(RUNTIME_TAG),
        commit: z.literal(RUNTIME_COMMIT),
        url: z.string(),
        archiveSha256: z.string(),
        actualArchiveSha256: z.string(),
        binarySha256: z.literal(BINARY_SHA256),
      })
      .strict(),
    typeshed: z
      .object({
        url: z.string(),
        archiveSha256: z.string(),
        actualArchiveSha256: z.string(),
      })
      .strict(),
    typescript: z
      .object({
        version: z.literal(TYPESCRIPT_VERSION),
        url: z.string(),
        integrity: z.literal(TYPESCRIPT_INTEGRITY),
        archiveSha256: z.string(),
        actualArchiveSha256: z.string(),
        tsserver: z.literal(TS_SERVER_PATH),
      })
      .strict(),
    inventory: z.array(inventorySchema),
  })
  .strict();
type RuntimeManifest = z.infer<typeof manifestSchema>;

const typescriptPackageSchema = z
  .object({
    name: z.literal("typescript"),
    version: z.literal(TYPESCRIPT_VERSION),
    bin: z
      .object({
        tsc: z.literal("./bin/tsc"),
        tsserver: z.literal("./bin/tsserver"),
      })
      .strict(),
  })
  .passthrough();

const typescriptLockSchema = z
  .object({
    name: z.literal("odools-mcp-runtime"),
    version: z.literal("1.0.0"),
    lockfileVersion: z.literal(3),
    requires: z.literal(true),
    packages: z
      .object({
        "": z
          .object({
            name: z.literal("odools-mcp-runtime"),
            version: z.literal("1.0.0"),
            dependencies: z
              .object({ typescript: z.literal(TYPESCRIPT_VERSION) })
              .strict(),
          })
          .strict(),
        "node_modules/typescript": z
          .object({
            version: z.literal(TYPESCRIPT_VERSION),
            resolved: z.string(),
            integrity: z.literal(TYPESCRIPT_INTEGRITY),
            bin: z
              .object({
                tsc: z.literal("bin/tsc"),
                tsserver: z.literal("bin/tsserver"),
              })
              .strict(),
          })
          .strict(),
      })
      .strict(),
  })
  .strict();

function sameIdentity(actual: PathIdentity, expected: PathIdentity): boolean {
  return actual.dev === expected.dev && actual.ino === expected.ino;
}

async function pathIdentity(path: string): Promise<PathIdentity> {
  const info = await lstat(path);
  return { dev: info.dev, ino: info.ino };
}

async function assertDirectoryIdentity(
  path: string,
  expected: PathIdentity,
  message: string,
): Promise<void> {
  const info = await lstat(path);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    !sameIdentity(info, expected)
  ) {
    throw new Error(message);
  }
}

async function assertRuntimeAncestors(
  root: string,
  relative: string,
): Promise<void> {
  const rootInfo = await lstat(root);
  if (
    !rootInfo.isDirectory() ||
    rootInfo.isSymbolicLink() ||
    (rootInfo.mode & 0o777) !== 0o700
  ) {
    throw new Error("Runtime root is unsafe");
  }
  const parts = relative.split("/");
  let current = root;
  for (const part of parts.slice(0, -1)) {
    current = join(current, part);
    const info = await lstat(current);
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      (info.mode & 0o777) !== 0o700
    ) {
      throw new Error(`Runtime directory is unsafe: ${relative}`);
    }
  }
}

async function readRuntimeFile(
  root: string,
  relative: string,
): Promise<{ data: Buffer; size: number; mode: number }> {
  await assertRuntimeAncestors(root, relative);
  const path = join(root, ...relative.split("/"));
  const handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error(`Runtime file type is unsafe: ${relative}`);
    const data = await handle.readFile();
    const after = await handle.stat();
    if (data.length !== info.size || !sameIdentity(after, info) || after.size !== info.size) {
      throw new Error(`Runtime file changed while reading: ${relative}`);
    }
    return { data, size: info.size, mode: info.mode & 0o777 };
  } finally {
    await handle.close();
  }
}

async function hashRuntimeFile(root: string, relative: string): Promise<string> {
  const { data } = await readRuntimeFile(root, relative);
  return createHash("sha256").update(data).digest("hex");
}

async function sha256(path: string): Promise<string> {
  const handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error("Runtime asset type is unsafe");
    const data = await handle.readFile();
    const after = await handle.stat();
    if (data.length !== info.size || !sameIdentity(after, info) || after.size !== info.size) {
      throw new Error("Runtime asset changed while hashing");
    }
    return createHash("sha256").update(data).digest("hex");
  } finally {
    await handle.close();
  }
}

async function openHashedExecutable(root: string, relative: string): Promise<{
  handle: Awaited<ReturnType<typeof open>>;
  hash: string;
}> {
  await assertRuntimeAncestors(root, relative);
  const path = join(root, ...relative.split("/"));
  const handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw new Error(`Runtime executable type is unsafe: ${relative}`);
    const hash = createHash("sha256");
    let size = 0;
    for await (const chunk of createReadStream("", { fd: handle.fd, autoClose: false })) {
      const data = Buffer.from(chunk);
      size += data.length;
      hash.update(data);
    }
    const after = await handle.stat();
    if (size !== before.size || !sameIdentity(after, before) || after.size !== before.size) {
      throw new Error(`Runtime executable changed while hashing: ${relative}`);
    }
    return { handle, hash: hash.digest("hex") };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function assertLinuxX64ElfExecutable(
  handle: Awaited<ReturnType<typeof open>>,
): Promise<void> {
  const header = Buffer.alloc(20);
  const { bytesRead } = await handle.read(header, 0, header.length, 0);
  if (bytesRead !== header.length || !header.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) {
    throw new Error("OdooLS executable is not an ELF file");
  }
  if (header[4] !== 2 || header[5] !== 1) {
    throw new Error("OdooLS executable is not a 64-bit little-endian ELF file");
  }
  const type = header.readUInt16LE(16);
  if ((type !== 2 && type !== 3) || header.readUInt16LE(18) !== 0x3e) {
    throw new Error("OdooLS executable is not a Linux x64 executable ELF");
  }
}

async function normalizePermissions(
  root: string,
  executables: Set<string>,
): Promise<void> {
  async function walk(path: string): Promise<void> {
    const info = await lstat(path);
    if (info.isSymbolicLink()) throw new Error("Runtime contains a symlink");
    if (info.isDirectory()) {
      await chmod(path, 0o700);
      for (const name of await readdir(path)) await walk(join(path, name));
      return;
    }
    if (!info.isFile()) throw new Error("Runtime contains a special file");
    await chmod(path, executables.has(path) ? 0o700 : 0o600);
  }
  await walk(root);
}

async function materializeClaimedTree(
  source: string,
  destination: string,
  rootIdentity: PathIdentity,
): Promise<void> {
  await assertDirectoryIdentity(destination, rootIdentity, "Claimed runtime root was replaced");
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (entry.name === "runtime-manifest.json") continue;
    const from = join(source, entry.name);
    const to = join(destination, entry.name);
    const info = await lstat(from);
    if (info.isDirectory() && !info.isSymbolicLink()) {
      await mkdir(to, { mode: info.mode & 0o777 });
      await materializeClaimedTree(from, to, await pathIdentity(to));
      await chmod(to, info.mode & 0o777);
    } else if (info.isFile() && !info.isSymbolicLink()) {
      try {
        await link(from, to);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
        await copyFile(from, to, fsConstants.COPYFILE_EXCL);
        await chmod(to, info.mode & 0o777);
      }
    } else {
      throw new Error("Staged runtime contains an unsupported special file");
    }
  }
}

async function inventory(root: string): Promise<InventoryEntry[]> {
  const result: InventoryEntry[] = [];
  async function walk(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const directoryEntry of entries.sort((left, right) => left.name.localeCompare(right.name, "en-US"))) {
      const name = directoryEntry.name;
      const path = join(directory, name);
      const relative = path.slice(root.length + 1).split(sep).join("/");
      const info = await lstat(path);
      if (info.isSymbolicLink()) throw new Error("Runtime contains symlink");
      if (info.isDirectory()) {
        result.push({
          path: relative,
          type: "directory",
          mode: info.mode & 0o777,
        });
        await walk(path);
        continue;
      }
      if (!info.isFile()) throw new Error("Runtime contains special file");
      if (relative === MANIFEST) continue;
      const file = await readRuntimeFile(root, relative);
      result.push({
        path: relative,
        type: "file",
        sha256: createHash("sha256").update(file.data).digest("hex"),
        size: file.size,
        mode: file.mode,
      });
    }
  }
  await walk(root);
  return result;
}

async function safeParent(runtimeDir: string): Promise<{
  path: string;
  dev: number;
  ino: number;
}> {
  const absolute = resolve(runtimeDir);
  await mkdir(dirname(absolute), { recursive: true, mode: 0o700 });
  const parentPath = await realpath(dirname(absolute));
  if (join(parentPath, basename(absolute)) !== absolute) {
    throw new Error("Runtime directory must not traverse symlinks");
  }
  const info = await lstat(parentPath);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error("Runtime parent is unsafe");
  }
  return { path: parentPath, dev: info.dev, ino: info.ino };
}

async function assertParent(parent: {
  path: string;
  dev: number;
  ino: number;
}): Promise<void> {
  await assertDirectoryIdentity(
    parent.path,
    parent,
    "Runtime parent changed during installation",
  );
}

interface InstallationLock extends PathIdentity {
  handle: Awaited<ReturnType<typeof open>>;
}

export async function inspectExistingLock(path: string): Promise<PathIdentity> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw error;
    throw new Error("Runtime installation lock is unsafe", { cause: error });
  }
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > 256) {
      throw new Error("Runtime installation lock is unsafe");
    }
    const text = (await handle.readFile()).toString("utf8");
    const match = /^(\d+):(\d+):[0-9a-f-]+\n$/.exec(text);
    if (!match) throw new Error("Runtime installation lock is malformed");
    const pid = Number(match[1]);
    const createdAt = Number(match[2]);
    if (!Number.isSafeInteger(pid) || pid <= 0 || !Number.isSafeInteger(createdAt)) {
      throw new Error("Runtime installation lock is malformed");
    }
    try {
      process.kill(pid, 0);
      throw new Error("Runtime installation is already in progress");
    } catch (probe) {
      if ((probe as NodeJS.ErrnoException).code !== "ESRCH") throw probe;
    }
    const age = Date.now() - createdAt;
    if (age < LOCK_STALE_MS) {
      throw new Error("Runtime installation lock owner cannot be confirmed");
    }
    return { dev: info.dev, ino: info.ino };
  } finally {
    await handle.close();
  }
}

export async function quarantineAndUnlink(
  path: string,
  expected: PathIdentity,
): Promise<void> {
  const current = await lstat(path);
  if (!current.isFile() || current.isSymbolicLink() || !sameIdentity(current, expected)) {
    throw new Error("Runtime installation lock was replaced");
  }
  const quarantine = `${path}.stale-${randomUUID()}`;
  try {
    await rename(path, quarantine);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error("Runtime installation lock was already reclaimed", { cause: error });
    }
    throw error;
  }
  const moved = await lstat(quarantine);
  if (!moved.isFile() || moved.isSymbolicLink() || !sameIdentity(moved, expected)) {
    throw new Error("Runtime installation lock was replaced during reclamation");
  }
  await unlink(quarantine);
}

async function acquireLock(path: string): Promise<InstallationLock> {
  for (;;) {
    try {
      const handle = await open(
        path,
        fsConstants.O_WRONLY |
          fsConstants.O_CREAT |
          fsConstants.O_EXCL |
          fsConstants.O_NOFOLLOW,
        0o600,
      );
      try {
        await handle.writeFile(`${lockIdentity()}\n`);
        const info = await handle.stat();
        return { handle, dev: info.dev, ino: info.ino };
      } catch (error) {
        await handle.close();
        await unlink(path).catch(() => undefined);
        throw error;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let expected: PathIdentity;
      try {
        expected = await inspectExistingLock(path);
      } catch (inspectionError) {
        if ((inspectionError as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw inspectionError;
      }
      await quarantineAndUnlink(path, expected);
    }
  }
}

async function releaseLock(path: string, lock: InstallationLock): Promise<void> {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || !sameIdentity(info, lock)) {
      throw new Error("Runtime installation lock was replaced");
    }
    await unlink(path);
  } finally {
    await lock.handle.close();
  }
}

async function acquire(
  asset: AssetSpec,
  stage: AssetStage,
  destination: string,
  preseed: string | undefined,
  downloader: NonNullable<InstallOptions["downloader"]>,
): Promise<string> {
  const actual = preseed
    ? await copyPreseed(stage, asset.name, preseed, asset.size)
    : ((await downloader(stage, asset.name, asset.url, asset.size)) ??
      (await sha256(destination)));
  if (actual !== asset.sha256) {
    throw new Error(`Runtime asset checksum mismatch: ${asset.name}`);
  }
  return actual;
}

function canonicalLock(resolved: string): z.input<typeof typescriptLockSchema> {
  return {
    name: "odools-mcp-runtime",
    version: "1.0.0",
    lockfileVersion: 3,
    requires: true,
    packages: {
      "": {
        name: "odools-mcp-runtime",
        version: "1.0.0",
        dependencies: { typescript: TYPESCRIPT_VERSION },
      },
      "node_modules/typescript": {
        version: TYPESCRIPT_VERSION,
        resolved,
        integrity: TYPESCRIPT_INTEGRITY,
        bin: { tsc: "bin/tsc", tsserver: "bin/tsserver" },
      },
    },
  };
}

async function assertPathMissing(path: string, message: string): Promise<void> {
  try {
    await lstat(path);
    throw new Error(message);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function removeCheckedDirectory(
  path: string,
  expected: PathIdentity,
): Promise<void> {
  await assertDirectoryIdentity(path, expected, "Runtime directory changed before removal");
  await rm(path, { recursive: true, force: true });
}

export async function installRuntime(
  options: InstallOptions,
): Promise<RuntimePaths> {
  if (options.version !== RUNTIME_VERSION) {
    throw new Error(`Unsupported OdooLS version: ${options.version}`);
  }
  const spec = runtimeSpec(options.platform, options.arch);
  const runtimeDir = resolve(options.runtimeDir);
  const parent = await safeParent(runtimeDir);
  try {
    const existing = await lstat(runtimeDir);
    if (existing.isSymbolicLink() || !existing.isDirectory()) {
      throw new Error("Existing runtime path is unsafe; choose a new directory or remove it manually");
    }
    try {
      return await verifyRuntime(runtimeDir, options.platform, options.arch);
    } catch (error) {
      throw new Error(
        "Existing runtime failed verification; choose a new directory or remove it manually",
        { cause: error },
      );
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const lockPath = `${runtimeDir}.install.lock`;
  const lock = await acquireLock(lockPath);
  try {
    await lstat(runtimeDir);
    try {
      const existing = await verifyRuntime(runtimeDir, options.platform, options.arch);
      await releaseLock(lockPath, lock);
      return existing;
    } catch (error) {
      throw new Error("Runtime appeared during installation but failed verification", { cause: error });
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      await releaseLock(lockPath, lock);
      throw error;
    }
  }
  let stage: string | undefined;
  let stageIdentity: PathIdentity | undefined;
  let downloadDir: string | undefined;
  let claimedIdentity: PathIdentity | undefined;
  let committed = false;
  const warnings: string[] = [];
  let primaryError: unknown;
  try {
    stage = await mkdtemp(join(parent.path, `.${basename(runtimeDir)}.stage-`));
    stageIdentity = await pathIdentity(stage);
    downloadDir = await mkdtemp(join(stage, ".assets-"));
    const assetStage = await createAssetStage(downloadDir);
    const downloader =
      options.downloader ??
      ((capability, name, url, bytes) => downloadAsset(capability, name, url, bytes));
    const odoolsArchive = join(downloadDir, spec.odools.name);
    const typeshedArchive = join(downloadDir, spec.typeshed.name);
    const tsArchive = join(downloadDir, spec.typescript.name);
    const [odoolsHash, typeshedHash, tsHash] = await Promise.all([
      acquire(spec.odools, assetStage, odoolsArchive, options.preseed?.odools, downloader),
      acquire(
        spec.typeshed,
        assetStage,
        typeshedArchive,
        options.preseed?.typeshed,
        downloader,
      ),
      acquire(
        spec.typescript,
        assetStage,
        tsArchive,
        options.preseed?.typescript,
        downloader,
      ),
    ]);

    await assertParent(parent);
    await assertDirectoryIdentity(stage, stageIdentity, "Runtime stage changed before extraction");
    await extractOdooTar(odoolsArchive, stage);
    await assertDirectoryIdentity(stage, stageIdentity, "Runtime stage changed during extraction");
    await extractZip(typeshedArchive, join(stage, "typeshed"));
    await assertDirectoryIdentity(stage, stageIdentity, "Runtime stage changed during extraction");
    const tsRoot = join(stage, "typescript/node_modules/typescript");
    await mkdir(tsRoot, { recursive: true, mode: 0o700 });
    await extractTarGz(tsArchive, tsRoot, true);
    await assertDirectoryIdentity(stage, stageIdentity, "Runtime stage changed during extraction");

    const binary = join(stage, "odoo_ls_server");
    const tsserver = join(stage, ...TS_SERVER_PATH.split("/"));
    await normalizePermissions(stage, new Set([binary, tsserver]));
    const executable = await openHashedExecutable(stage, "odoo_ls_server");
    if (executable.hash !== BINARY_SHA256) {
      await executable.handle.close();
      throw new Error("Installed OdooLS binary checksum mismatch");
    }
    await assertLinuxX64ElfExecutable(executable.handle);
    for (const [path, expected] of Object.entries(TS_CRITICAL)) {
      if ((await hashRuntimeFile(stage, path)) !== expected) {
        await executable.handle.close();
        throw new Error(`TypeScript critical file mismatch: ${path}`);
      }
    }
    let output: string;
    try {
      output = await probeRuntimeHandle(executable.handle, ["--version"], {
        expectedSha256: BINARY_SHA256,
      });
    } finally {
      await executable.handle.close();
    }
    if (
      !new RegExp(
        `(?:^|\\s)${RUNTIME_VERSION.replaceAll(".", "\\.")}(?:$|\\s)`,
      ).test(output)
    ) {
      throw new Error("Installed OdooLS reports the wrong version");
    }

    const lockDocument = canonicalLock(spec.typescript.url);
    await writeFile(
      join(stage, "typescript/package-lock.json"),
      `${JSON.stringify(lockDocument, null, 2)}\n`,
      { mode: 0o600, flag: "wx" },
    );
    const manifest: RuntimeManifest = {
      schema: RUNTIME_SCHEMA,
      adapterVersion: ADAPTER_VERSION,
      installedAt: (options.now ?? (() => new Date()))().toISOString(),
      platform: "linux",
      arch: "x64",
      odools: {
        channel: RUNTIME_CHANNEL,
        version: RUNTIME_VERSION,
        tag: RUNTIME_TAG,
        commit: RUNTIME_COMMIT,
        url: spec.odools.url,
        archiveSha256: spec.odools.sha256,
        actualArchiveSha256: odoolsHash,
        binarySha256: BINARY_SHA256,
      },
      typeshed: {
        url: spec.typeshed.url,
        archiveSha256: spec.typeshed.sha256,
        actualArchiveSha256: typeshedHash,
      },
      typescript: {
        version: TYPESCRIPT_VERSION,
        url: spec.typescript.url,
        integrity: TYPESCRIPT_INTEGRITY,
        archiveSha256: spec.typescript.sha256,
        actualArchiveSha256: tsHash,
        tsserver: TS_SERVER_PATH,
      },
      inventory: await inventory(stage),
    };
    await writeFile(
      join(stage, MANIFEST),
      `${JSON.stringify(manifest, null, 2)}\n`,
      { mode: 0o600, flag: "wx" },
    );
    await assertDirectoryIdentity(stage, stageIdentity, "Runtime stage changed before verification");
    await verifyRuntime(stage);
    await assertDirectoryIdentity(stage, stageIdentity, "Runtime stage changed during verification");
    await assertParent(parent);

    await assertPathMissing(runtimeDir, "Runtime appeared before installation");
    await assertParent(parent);
    await assertDirectoryIdentity(stage, stageIdentity, "Runtime stage changed before installation");
    await mkdir(runtimeDir, { mode: 0o700 });
    claimedIdentity = await pathIdentity(runtimeDir);
    await assertDirectoryIdentity(runtimeDir, claimedIdentity, "Runtime destination changed before installation");

    // Materialize without replacement into the exclusively claimed directory.
    // Removing the staged manifest ensures no observer can see a valid runtime
    // before all authenticated entries have been installed.
    await unlink(join(stage, MANIFEST));
    await materializeClaimedTree(stage, runtimeDir, claimedIdentity);
    const stagedManifest = join(stage, MANIFEST);
    await writeFile(stagedManifest, `${JSON.stringify(manifest, null, 2)}\n`, {
      mode: 0o600,
      flag: "wx",
    });
    await assertDirectoryIdentity(runtimeDir, claimedIdentity, "Runtime destination changed before commit");
    // Stage and claim are siblings on one authenticated filesystem. Linking is
    // the atomic, non-overwriting commit; an unexpected EXDEV must fail closed.
    await link(stagedManifest, join(runtimeDir, MANIFEST));
    committed = true;
    await assertParent(parent);
    await assertDirectoryIdentity(runtimeDir, claimedIdentity, "Committed runtime root was replaced");
    const result = await verifyRuntime(runtimeDir);
    return warnings.length ? { ...result, warnings } : result;
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    const cleanupErrors: unknown[] = [];
    if (!committed && claimedIdentity && stage) {
      try {
        await assertDirectoryIdentity(runtimeDir, claimedIdentity, "Claimed runtime root changed during cleanup");
        const destinationInventory = await inventory(runtimeDir);
        const stageInventory = await inventory(stage);
        const authenticated = new Map(stageInventory.map((entry) => [entry.path, entry]));
        if (!destinationInventory.every((entry) => JSON.stringify(entry) === JSON.stringify(authenticated.get(entry.path)))) {
          cleanupErrors.push(new Error("Claimed runtime contains unauthenticated entries; preserving it"));
        } else {
          await removeCheckedDirectory(runtimeDir, claimedIdentity);
        }
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (stage && stageIdentity) {
      await removeCheckedDirectory(stage, stageIdentity).catch((error: unknown) => cleanupErrors.push(error));
      try {
        const residue = await lstat(stage);
        if (!sameIdentity(residue, stageIdentity)) {
          const quarantine = `${stage}.untrusted-${randomUUID()}`;
          await rename(stage, quarantine);
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          /* Preserve uncertain residue without deleting it. */
        }
      }
    }
    await releaseLock(lockPath, lock).catch((error: unknown) => cleanupErrors.push(error));
    if (cleanupErrors.length) {
      // The cleanup failure must supersede a pending return while retaining any primary error.
      // eslint-disable-next-line no-unsafe-finally
      throw new AggregateError(
        primaryError === undefined ? cleanupErrors : [primaryError, ...cleanupErrors],
        primaryError === undefined
          ? "Runtime cleanup failed"
          : `${primaryError instanceof Error ? primaryError.message : "Runtime installation failed"}; cleanup failed`,
      );
    }
  }
}

export async function verifyRuntime(
  runtimeDirInput: string,
  platform: string = process.platform,
  arch: string = process.arch,
): Promise<RuntimePaths> {
  const spec = runtimeSpec(platform, arch);
  const runtimeDir = resolve(runtimeDirInput);
  await safeParent(runtimeDir);
  const root = await lstat(runtimeDir);
  if (
    !root.isDirectory() ||
    root.isSymbolicLink() ||
    (root.mode & 0o777) !== 0o700
  ) {
    throw new Error("Runtime root is unsafe");
  }

  const manifestFile = await readRuntimeFile(runtimeDir, MANIFEST);
  if (manifestFile.mode !== 0o600) {
    throw new Error("Runtime manifest permissions are unsafe");
  }
  const raw = manifestSchema.parse(JSON.parse(manifestFile.data.toString("utf8")));
  if (
    raw.odools.url !== spec.odools.url ||
    raw.odools.archiveSha256 !== spec.odools.sha256 ||
    raw.odools.actualArchiveSha256 !== spec.odools.sha256 ||
    raw.typeshed.url !== spec.typeshed.url ||
    raw.typeshed.archiveSha256 !== spec.typeshed.sha256 ||
    raw.typeshed.actualArchiveSha256 !== spec.typeshed.sha256 ||
    raw.typescript.url !== spec.typescript.url ||
    raw.typescript.archiveSha256 !== spec.typescript.sha256 ||
    raw.typescript.actualArchiveSha256 !== spec.typescript.sha256
  ) {
    throw new Error("Runtime manifest provenance mismatch");
  }

  const executable = await openHashedExecutable(runtimeDir, "odoo_ls_server");
  if (executable.hash !== BINARY_SHA256) {
    await executable.handle.close();
    throw new Error("OdooLS binary checksum mismatch");
  }
  try {
    await assertLinuxX64ElfExecutable(executable.handle);
    for (const [path, expected] of Object.entries(TS_CRITICAL)) {
      if ((await hashRuntimeFile(runtimeDir, path)) !== expected) {
        throw new Error(`TypeScript critical file mismatch: ${path}`);
      }
    }

  const actualInventory = await inventory(runtimeDir);
  if (JSON.stringify(actualInventory) !== JSON.stringify(raw.inventory)) {
    throw new Error("Runtime file inventory mismatch");
  }
  for (const entry of actualInventory) {
    const expectedMode =
      entry.type === "directory"
        ? 0o700
        : entry.path === "odoo_ls_server" || entry.path === raw.typescript.tsserver
          ? 0o700
          : 0o600;
    if (entry.mode !== expectedMode) {
      throw new Error("Runtime permissions are unsafe");
    }
  }

  const packageData = typescriptPackageSchema.parse(
    JSON.parse(
      (
        await readRuntimeFile(
          runtimeDir,
          "typescript/node_modules/typescript/package.json",
        )
      ).data.toString("utf8"),
    ),
  );
  if (packageData.version !== TYPESCRIPT_VERSION) {
    throw new Error("TypeScript runtime version mismatch");
  }
  const npmLock = typescriptLockSchema.parse(
    JSON.parse(
      (
        await readRuntimeFile(runtimeDir, "typescript/package-lock.json")
      ).data.toString("utf8"),
    ),
  );
  if (npmLock.packages["node_modules/typescript"].resolved !== spec.typescript.url) {
    throw new Error("TypeScript lock provenance mismatch");
  }

  const binary = join(runtimeDir, "odoo_ls_server");
  const tsserver = join(runtimeDir, ...raw.typescript.tsserver.split("/"));
  const binaryInfo = await lstat(binary);
  const tsInfo = await lstat(tsserver);
  if (
    !binaryInfo.isFile() ||
    !tsInfo.isFile() ||
    binaryInfo.isSymbolicLink() ||
    tsInfo.isSymbolicLink()
  ) {
    throw new Error("Runtime executable type is unsafe");
  }
  await access(tsserver, fsConstants.X_OK);
  const output = await probeRuntimeHandle(executable.handle, ["--version"], {
    expectedSha256: BINARY_SHA256,
  });
  if (
    !new RegExp(
      `(?:^|\\s)${RUNTIME_VERSION.replaceAll(".", "\\.")}(?:$|\\s)`,
    ).test(output)
  ) {
    throw new Error("OdooLS runtime version mismatch");
  }
  return { binary, tsserver, manifest: join(runtimeDir, MANIFEST) };
  } finally {
    await executable.handle.close();
  }
}
