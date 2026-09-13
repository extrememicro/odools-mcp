import { EventEmitter } from "node:events";

const HEADER_LIMIT = 8 * 1024;
export const DEFAULT_MAX_FRAME_BYTES = 4 * 1024 * 1024;

export class LspFrameParser extends EventEmitter {
  private buffer = Buffer.alloc(0);
  private expected: number | null = null;

  constructor(private readonly maxFrameBytes = DEFAULT_MAX_FRAME_BYTES) { super(); }

  push(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      if (this.expected === null) {
        const end = this.buffer.indexOf("\r\n\r\n");
        if (end < 0) {
          if (this.buffer.length > HEADER_LIMIT) this.fail(new Error("LSP header exceeds limit"));
          return;
        }
        const header = this.buffer.subarray(0, end).toString("ascii");
        this.buffer = this.buffer.subarray(end + 4);
        const lengths = header.split("\r\n").filter((line) => /^content-length:/i.test(line));
        if (lengths.length !== 1) return this.fail(new Error("Exactly one Content-Length header is required"));
        const match = /^content-length:\s*(\d+)\s*$/i.exec(lengths[0]!);
        if (!match) return this.fail(new Error("Malformed Content-Length header"));
        this.expected = Number(match[1]);
        if (!Number.isSafeInteger(this.expected) || this.expected < 0 || this.expected > this.maxFrameBytes) {
          return this.fail(new Error("LSP frame exceeds limit"));
        }
      }
      if (this.buffer.length < this.expected) return;
      const body = this.buffer.subarray(0, this.expected);
      this.buffer = this.buffer.subarray(this.expected);
      this.expected = null;
      try {
        this.emit("message", JSON.parse(body.toString("utf8")) as unknown);
      } catch {
        return this.fail(new Error("Malformed LSP JSON payload"));
      }
    }
  }

  private fail(error: Error): void {
    this.buffer = Buffer.alloc(0);
    this.expected = null;
    this.emit("error", error);
  }
}

export function encodeFrame(message: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "ascii"), body]);
}
