import { createHash } from "node:crypto";
import type { JavascriptState, ReadinessSnapshot } from "../types.js";

const CORE_DIAGNOSTIC = /odoo path|addons path|python path|stdlib|typeshed|selected config|unable to load configuration|configuration error|does not exist|doesn't exist|not found|could not be resolved|no such file|fatal/i;
export interface ConfigurationDiagnostic { level: number | null; message: string }

export class ReadinessTracker {
  private configurationSeen = false;
  private configurationFingerprint?: string;
  private diagnostics: string[] = [];
  private javascriptDiagnostics: string[] = [];
  private fatal = false;
  private loading = false;
  private progress = new Set<string>();
  private alive = true;
  private lifecycleState: "dormant" | "activating" | "stopping" | "stopped" = "dormant";
  private lastActivityAt = Date.now();
  /** Last moment activation or explicit indexing evidence required another quiet period. */
  private lastReadinessSignalAt = Date.now();
  private javascriptState: JavascriptState;
  private recoveryState?: "restarting" | "failed";
  private recovery = {
    automaticRestart: false,
    restartCount: 0,
    lastCrash: null as string | null,
    lastError: null as string | null,
    watcherEnabled: false,
    watcherState: "disabled" as ReadinessSnapshot["watcherState"],
    watcherError: null as string | null,
    watcherDocumentCount: 0,
    maxWatcherDocuments: 0,
  };

  constructor(private readonly quietMs: number, private readonly javascriptConfigured: boolean) {
    this.javascriptState = javascriptConfigured ? "pending" : "disabled";
  }
  /** Ordinary traffic (any inbound message). Records activity only; never re-opens the readiness quiet window. */
  touch(): void { this.lastActivityAt = Date.now(); }
  /** Activation or explicit indexing evidence that requires another quiet period. */
  private signalReadiness(): void { this.lastReadinessSignalAt = Date.now(); this.touch(); }
  setAlive(value: boolean): void { this.alive = value; this.signalReadiness(); }
  setLifecycleState(value: "dormant" | "activating" | "stopping" | "stopped"): void {
    this.lifecycleState = value; this.signalReadiness();
  }
  setLoading(value: boolean): void {
    if (this.loading === value) { this.touch(); return; }
    this.loading = value; this.signalReadiness();
  }
  setRecovery(values: Partial<typeof this.recovery>, state?: "restarting" | "failed"): void {
    Object.assign(this.recovery, values); this.recoveryState = state;
    if (state === "failed") this.alive = false;
    this.touch();
  }
  resetForRestart(): void {
    this.configurationSeen = false; this.configurationFingerprint = undefined; this.diagnostics = []; this.javascriptDiagnostics = []; this.fatal = false;
    this.loading = true; this.progress.clear(); this.alive = true; this.javascriptState = this.javascriptConfigured ? "pending" : "disabled";
    this.recoveryState = "restarting"; this.signalReadiness();
  }
  clearRecoveryState(): void { this.recoveryState = undefined; this.touch(); }
  setConfiguration(diagnostics: ConfigurationDiagnostic[]): void {
    const fingerprint = createHash("sha256").update(JSON.stringify(diagnostics.map(({ level, message }) => ({ level, message })))).digest("hex");
    if (this.configurationSeen && this.configurationFingerprint === fingerprint) { this.touch(); return; }
    this.configurationSeen = true; this.configurationFingerprint = fingerprint;
    this.addConfigurationDiagnostics(diagnostics); this.signalReadiness();
  }
  addConfigurationDiagnostics(diagnostics: ConfigurationDiagnostic[]): void {
    for (const item of diagnostics) {
      const isJavascript = /javascript|tsserver/i.test(item.message);
      if (isJavascript) {
        this.javascriptDiagnostics.push(item.message);
        if ((item.level ?? 0) >= 2) this.javascriptState = "unavailable";
      } else this.diagnostics.push(item.message);
      if ((item.level ?? 0) >= 2 && CORE_DIAGNOSTIC.test(item.message.replace(/tsserver|javascript/gi, ""))) this.fatal = true;
    }
    this.diagnostics = this.diagnostics.slice(-20); this.javascriptDiagnostics = this.javascriptDiagnostics.slice(-20); this.touch();
  }
  setJavascriptState(state: JavascriptState, diagnostics: string[] = []): void { this.javascriptState = state; this.javascriptDiagnostics = diagnostics.slice(0, 20); this.touch(); }
  setJavascriptStatus(ready: boolean): void { this.setJavascriptState(ready ? "ready" : "unavailable"); }
  progressBegin(token: string): void {
    if (this.progress.has(token)) { this.touch(); return; }
    this.progress.add(token); this.signalReadiness();
  }
  progressEnd(token: string): void {
    if (!this.progress.delete(token)) { this.touch(); return; }
    this.signalReadiness();
  }
  isReady(now = Date.now()): boolean {
    return this.alive && this.configurationSeen && !this.fatal && !this.loading && this.progress.size === 0 && now - this.lastReadinessSignalAt >= this.quietMs;
  }
  snapshot(now = Date.now()): ReadinessSnapshot {
    let state: ReadinessSnapshot["state"];
    if (this.recoveryState) state = this.recoveryState;
    else if (!this.alive) state = this.fatal ? "failed" : this.lifecycleState;
    else if (this.fatal) state = "failed";
    else if (this.javascriptState === "unavailable" || this.recovery.watcherState === "failed" || this.recovery.watcherError) state = "degraded";
    else if (this.isReady(now)) state = "ready";
    else if (this.loading || this.progress.size > 0) state = "indexing";
    else if (this.configurationSeen) state = "indexing";
    else state = "activating";
    return {
      state, coreReady: this.isReady(now), javascriptReady: this.javascriptState === "ready", javascriptState: this.javascriptState,
      loading: this.loading, progressActive: this.progress.size, configurationSeen: this.configurationSeen,
      configurationDiagnostics: [...this.diagnostics], javascriptDiagnostics: [...this.javascriptDiagnostics], fatalConfiguration: this.fatal,
      processAlive: this.alive, lastActivityAt: this.lastActivityAt, ...this.recovery,
    };
  }
}
