import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { copyPreseed, createAssetStage, downloadAsset } from "../src/runtime/download.js";

const github = "https://github.com/odoo/odoo-ls/releases/download/1.5.2/typeshed.zip";
const cdn = "https://release-assets.githubusercontent.com/github-production-release-asset/605624319/929a388a-4a4e-4bb8-b73c-e1c0797512f1?sig=x";

describe("runtime downloader", () => {
  it("follows one allowlisted GitHub CDN redirect", async () => {
    const root = await mkdtemp(join(tmpdir(), "odools-download-")); const target = join(root, "asset");
    const fake = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: cdn } })).mockResolvedValueOnce(new Response("abc", { status: 200, headers: { "content-length": "3" } }));
    try { await expect(downloadAsset(await createAssetStage(root), "asset", github, 3, fake)).resolves.toHaveLength(64); expect(await readFile(target, "utf8")).toBe("abc"); expect(fake).toHaveBeenCalledTimes(2); }
    finally { await rm(root, { recursive: true, force: true }); }
  });

  it("rejects unapproved redirects and truncation", async () => {
    const root = await mkdtemp(join(tmpdir(), "odools-download-"));
    try {
      const evilTarget = join(root, "evil");
      const evil = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 302, headers: { location: "https://example.com/asset" } }));
      await expect(downloadAsset(await createAssetStage(root), "evil", github, 3, evil)).rejects.toThrow(/redirect is not approved/);
      await expect(access(evilTarget)).rejects.toMatchObject({ code: "ENOENT" });
      const shortTarget = join(root, "short");
      const short = vi.fn<typeof fetch>().mockResolvedValue(new Response("ab", { status: 200 }));
      await expect(downloadAsset(await createAssetStage(root), "short", github, 3, short)).rejects.toThrow(/size mismatch/);
      await expect(access(shortTarget)).rejects.toMatchObject({ code: "ENOENT" });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("removes partial preseed destinations while preserving the original error", async () => {
    const root = await mkdtemp(join(tmpdir(), "odools-preseed-"));
    try {
      const source = join(root, "source");
      const target = join(root, "target");
      await writeFile(source, "ab");
      await expect(copyPreseed(await createAssetStage(root), "target", source, 3)).rejects.toThrow("Preseed asset size mismatch");
      await expect(access(target)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("removes a failed online download while preserving the original error", async () => {
    const root = await mkdtemp(join(tmpdir(), "odools-download-fail-"));
    const target = join(root, "asset");
    const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(Buffer.from("ab")); controller.error(new Error("stream failed")); } });
    const fake = vi.fn<typeof fetch>().mockResolvedValue(new Response(body, { status: 200 }));
    try {
      await expect(downloadAsset(await createAssetStage(root), "asset", github, 3, fake)).rejects.toThrow(/stream failed/);
      await expect(access(target)).rejects.toMatchObject({ code: "ENOENT" });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

});
