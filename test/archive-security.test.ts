import { createGzip } from "node:zlib";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import tarStream from "tar-stream";
import yazl from "yazl";
import { describe, expect, it } from "vitest";
import { extractTarGz, extractZip } from "../src/runtime/archive.js";

async function tarArchive(entries: Array<{ header: tarStream.Headers; body?: string }>): Promise<Buffer> {
  const pack = tarStream.pack(); const chunks: Buffer[] = []; const gzip = createGzip(); const finished = new Promise<Buffer>((done, reject) => { gzip.on("data", (chunk: Buffer) => chunks.push(chunk)); gzip.on("end", () => done(Buffer.concat(chunks))); gzip.on("error", reject); });
  pack.pipe(gzip); for (const entry of entries) pack.entry(entry.header, entry.header.type === "file" ? entry.body ?? "bad" : undefined); pack.finalize(); return finished;
}
async function zipArchive(entries: Array<{ name: string; body: string }>): Promise<Buffer> {
  const zip = new yazl.ZipFile(); const chunks: Buffer[] = []; const finished = new Promise<Buffer>((done, reject) => { zip.outputStream.on("data", (chunk: Buffer) => chunks.push(chunk)); zip.outputStream.on("end", () => done(Buffer.concat(chunks))); zip.outputStream.on("error", reject); });
  for (const entry of entries) zip.addBuffer(Buffer.from(entry.body), entry.name); zip.end(); return finished;
}

describe("runtime archive extraction", () => {
  it.each([
    ["traversal", [{ header: { name: "../escape", type: "file" } }], /Unsafe archive path/],
    ["symlink", [{ header: { name: "link", type: "symlink", linkname: "/etc/passwd" } }], /Unsafe archive entry type/],
    ["special", [{ header: { name: "fifo", type: "fifo" } }], /Unsafe archive entry type/],
    ["duplicate", [{ header: { name: "a", type: "file" } }, { header: { name: "a", type: "file" } }], /Duplicate/],
    ["case", [{ header: { name: "A", type: "file" } }, { header: { name: "a", type: "file" } }], /Case-fold/],
  ])("rejects TAR %s", async (_name, entries, pattern) => { const root = await mkdtemp(join(tmpdir(), "odools-tar-")); try { const archive = join(root, "bad.tgz"); await writeFile(archive, await tarArchive(entries as Array<{ header: tarStream.Headers }>)); await expect(extractTarGz(archive, join(root, "out"))).rejects.toThrow(pattern as RegExp); } finally { await rm(root, { recursive: true, force: true }); } });

  it("rejects TAR uncompressed bombs", async () => { const root = await mkdtemp(join(tmpdir(), "odools-tar-")); try { const archive = join(root, "bad.tgz"); await writeFile(archive, await tarArchive([{ header: { name: "large", type: "file" }, body: "12345" }])); await expect(extractTarGz(archive, join(root, "out"), false, { maxFiles: 2, maxFileBytes: 4, maxTotalBytes: 4, maxInputBytes: 1000 })).rejects.toThrow(/limits/); } finally { await rm(root, { recursive: true, force: true }); } });

  it.each([
    "../x",
    "/x",
    "C:/x",
    "package/../../x",
    "package\\x",
    "package\0/x",
    "package",
  ])("validates original TAR path before stripFirst: %s", async (name) => {
    const root = await mkdtemp(join(tmpdir(), "odools-tar-strip-"));
    try {
      const archive = join(root, "bad.tgz");
      await writeFile(archive, await tarArchive([{ header: { name, type: "file" } }]));
      await expect(extractTarGz(archive, join(root, "out"), true)).rejects.toThrow(/Unsafe archive path/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("requires one top-level TAR component while allowing inner dot components", async () => {
    const root = await mkdtemp(join(tmpdir(), "odools-tar-strip-"));
    try {
      const mixed = join(root, "mixed.tgz");
      await writeFile(mixed, await tarArchive([
        { header: { name: "package/./a", type: "file" }, body: "a" },
        { header: { name: "other/b", type: "file" }, body: "b" },
      ]));
      await expect(extractTarGz(mixed, join(root, "out"), true)).rejects.toThrow(/Unsafe archive path/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each([
    ["duplicate", [{ name: "a", body: "x" }, { name: "a", body: "x" }], /Duplicate/],
    ["case", [{ name: "A", body: "x" }, { name: "a", body: "x" }], /Case-fold/],
  ])("rejects ZIP %s", async (_name, entries, pattern) => { const root = await mkdtemp(join(tmpdir(), "odools-zip-")); try { const archive = join(root, "bad.zip"); await writeFile(archive, await zipArchive(entries)); await expect(extractZip(archive, join(root, "out"))).rejects.toThrow(pattern as RegExp); } finally { await rm(root, { recursive: true, force: true }); } });

  it("rejects ZIP uncompressed bombs", async () => { const root = await mkdtemp(join(tmpdir(), "odools-zip-")); try { const archive = join(root, "bad.zip"); await writeFile(archive, await zipArchive([{ name: "large", body: "12345" }])); await expect(extractZip(archive, join(root, "out"), { maxFiles: 2, maxFileBytes: 4, maxTotalBytes: 4, maxInputBytes: 1000 })).rejects.toThrow(/limits/); } finally { await rm(root, { recursive: true, force: true }); } });
});
