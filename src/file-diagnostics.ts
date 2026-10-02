import type { AdapterConfig } from "./config.js";
import type { LspSession } from "./lsp/session.js";

export class FileDiagnosticsProvider {
  constructor(private readonly config: AdapterConfig, private readonly session: LspSession) {}
  async call(path: string, waitMs = 0, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const input = await this.config.guard.input(path);
    const activation = await this.session.ensureStarted(signal);
    signal?.throwIfAborted();
    await this.session.open(input.uri, input.absolutePath, input.text);
    return { ...await this.session.diagnostics.wait(input.uri, Math.min(30_000, Math.max(0, waitMs)), signal), ...activation,
      transport: "publishDiagnostics", clean: null,
      limitation: "Push observations only; unversioned freshness is uncertain. Empty findings do not prove runtime correctness." };
  }
}
