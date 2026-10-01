import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { access, constants, lstat, mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { EventEmitter } from "node:events";
import { parse as parseToml } from "smol-toml";
import { pathToFileURL } from "node:url";
import type { AdapterConfig } from "../config.js";
import type { JsonRpcId } from "../types.js";
import { childEnvironment, commandOutput, ENGINE_VERSION } from "../config.js";
import { encodeFrame, LspFrameParser } from "./framing.js";
import { ReadinessTracker } from "./readiness.js";
import { SourceWatcher, type WatchedFileChange } from "./watcher.js";

// Startup failure settlement allows at most 500ms for cleanup; disposal continues in the background.
const CLEANUP_GRACE_MS = 500;

interface Pending { resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout; abortCleanup?: () => void }
interface RpcMessage { jsonrpc?: string; id?: JsonRpcId; method?: string; params?: any; result?: unknown; error?: { code?: number; message?: string } }
interface Document { path: string; version: number; text: string; languageId: string }

export class LspSession extends EventEmitter {
  private child?: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private pending = new Map<JsonRpcId, Pending>();
  private parser = new LspFrameParser();
  private documents = new Map<string, Document>();
  private watcherDocuments = new Map<string, true>();
  readonly readiness: ReadinessTracker;
  private stderrBytes = 0;
  private observedCancelIds: JsonRpcId[] = [];
  private lastPid?: number;
  private stopping = false;
  private initialized = false;
  private restartLoop?: Promise<void>;
  private restartTimes: number[] = [];
  private restartCount = 0;
  private restartAbortController?: AbortController;
  private watcher?: SourceWatcher;
  private activationPromise?: Promise<void>;
  private activationAbortController?: AbortController;
  private permanentlyStopped = false;
  private cleanupTasks = new Set<Promise<void>>();
  private cleanupDelayed = false;
  private abortWaiters = new WeakMap<AbortSignal, { callbacks: Set<() => void>; listener: () => void }>();
  private logsDirectory?: string;
  private ownedOperationalDirectory?: string;
  get childPid(): number | undefined { return this.child?.pid; }
  get lastChildPid(): number | undefined { return this.lastPid; }
  get pendingCount(): number { return this.pending.size; }
  get documentCount(): number { return this.documents.size; }
  get cancellationIds(): readonly JsonRpcId[] { return this.observedCancelIds; }

  constructor(readonly config: AdapterConfig) {
    super();
    this.readiness = new ReadinessTracker(config.quietMs, Boolean(config.tsserverPath));
    this.readiness.setAlive(false);
    this.readiness.setRecovery({
      automaticRestart: config.restartMaxAttempts > 0,
      watcherEnabled: config.watcherEnabled,
      watcherState: config.watcherEnabled ? "stopped" : "disabled",
      watcherDocumentCount: 0,
      maxWatcherDocuments: config.maxWatcherDocuments,
    });
  }

  async start(): Promise<void> { await this.ensureStarted(); }

  async ensureStarted(signal?: AbortSignal): Promise<{ coldStart: boolean; startupDurationMs?: number }> {
    if (signal?.aborted) throw new Error("cancelled");
    if (this.permanentlyStopped) throw new Error("ODOOLS_START_FAILED: OdooLS session is stopped");
    if (this.cleanupTasks.size) throw new Error("ODOOLS_START_FAILED: prior resource cleanup is still pending; retry after cleanup completes");
    if (this.child && this.initialized && !this.restartLoop && !this.activationPromise) return { coldStart: false };
    const waitedForRestart = Boolean(this.restartLoop);
    const coldStart = !waitedForRestart;
    const startedAt = Date.now();
    const shared = this.restartLoop ?? this.activationPromise ?? this.createActivation();
    await this.waitForCaller(shared, signal);
    if (!this.child || !this.initialized) throw new Error("ODOOLS_START_FAILED: backend did not become initialized");
    return { coldStart, startupDurationMs: Date.now() - startedAt };
  }

  private createActivation(): Promise<void> {
    if (this.child) throw new Error("ODOOLS_START_FAILED: refusing to overwrite a live backend");
    const activation = this.activate();
    const wrapped = activation.finally(() => {
      if (this.activationPromise === wrapped) this.activationPromise = undefined;
      this.activationAbortController = undefined;
    });
    this.activationPromise = wrapped;
    return wrapped;
  }

  private async activate(): Promise<void> {
    const controller = new AbortController();
    this.activationAbortController = controller;
    let stage = "input validation";
    const timer = setTimeout(() => controller.abort(new Error(`ODOOLS_READINESS_TIMEOUT: startup timed out after ${this.config.startupTimeoutMs}ms during ${stage}; inspect backend logs and watcher roots or increase startupTimeoutMs`)), this.config.startupTimeoutMs);
    this.readiness.setLifecycleState("activating");
    try {
      await this.waitForCaller((async () => {
        await this.revalidateActivationInputs(controller.signal);
        controller.signal.throwIfAborted();
        this.stopping = false;
        stage = "initialize";
        await this.startProcess(controller.signal);
        controller.signal.throwIfAborted();
        stage = "backend readiness";
        await this.waitUntilReady(this.config.startupTimeoutMs, controller.signal);
        controller.signal.throwIfAborted();
        stage = "watcher setup";
        await this.startWatcher();
        controller.signal.throwIfAborted();
        this.readiness.clearRecoveryState();
      })(), controller.signal);
    } catch (error) {
      await this.settleCleanup(this.stopInternal(false), "activation cleanup");
      const failure = controller.signal.aborted && controller.signal.reason instanceof Error ? controller.signal.reason : error;
      const message = failure instanceof Error ? failure.message : String(failure);
      if (/^(RUNTIME_MISSING|RUNTIME_INVALID|WORKSPACE_CHANGED|GENERATED_CONFIG_INVALID|ODOOLS_START_FAILED|ODOOLS_READINESS_TIMEOUT):/.test(message)) throw failure;
      if (/timed out/i.test(message)) throw new Error(`ODOOLS_READINESS_TIMEOUT: ${message}`);
      throw new Error(`ODOOLS_START_FAILED: ${message}`);
    } finally { clearTimeout(timer); }
  }

  private async revalidateActivationInputs(signal?: AbortSignal): Promise<void> {
    const check = async (path: string, code: string, mode?: number) => {
      try { const canonical = await realpath(path); if (canonical !== path) throw new Error("canonical path changed"); if (mode !== undefined) await access(path, mode); }
      catch (error) { throw new Error(`${code}: ${error instanceof Error ? error.message : String(error)}`); }
    };
    await check(this.config.workspace, "WORKSPACE_CHANGED");
    await check(this.config.binary, "RUNTIME_MISSING", constants.X_OK);
    try {
      const version = await commandOutput(this.config.binary, ["--version"], signal);
      if (!version.includes(ENGINE_VERSION)) throw new Error(`expected ${ENGINE_VERSION}, got ${version.trim()}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/ENOENT|no such file/i.test(message)) throw new Error(`RUNTIME_MISSING: ${message}`);
      throw new Error(`RUNTIME_INVALID: ${message}`);
    }
    await check(this.config.config, "GENERATED_CONFIG_INVALID", constants.R_OK);
    try {
      const document = parseToml(await readFile(this.config.config, "utf8")) as { config?: Array<{ name?: unknown }> };
      if (!document.config?.some((profile) => profile.name === this.config.profile)) throw new Error(`profile ${this.config.profile} does not exist`);
    } catch (error) { throw new Error(`GENERATED_CONFIG_INVALID: ${error instanceof Error ? error.message : String(error)}`); }
  }

  private async waitForCaller(promise: Promise<void>, signal?: AbortSignal): Promise<void> {
    if (!signal) return await promise;
    if (signal.aborted) throw new Error("cancelled");
    let callback!: () => void;
    const aborted = new Promise<never>((_resolve, reject) => {
      callback = () => reject(new Error("cancelled"));
      this.addAbortWaiter(signal, callback);
    });
    try { await Promise.race([promise, aborted]); }
    finally { this.removeAbortWaiter(signal, callback); }
  }

  private addAbortWaiter(signal: AbortSignal, callback: () => void): void {
    let entry = this.abortWaiters.get(signal);
    if (!entry) {
      const callbacks = new Set<() => void>();
      const listener = () => { for (const waiter of [...callbacks]) waiter(); callbacks.clear(); this.abortWaiters.delete(signal); };
      entry = { callbacks, listener }; this.abortWaiters.set(signal, entry);
      signal.addEventListener("abort", listener, { once: true });
    }
    entry.callbacks.add(callback);
  }

  private removeAbortWaiter(signal: AbortSignal, callback: () => void): void {
    const entry = this.abortWaiters.get(signal); if (!entry) return;
    entry.callbacks.delete(callback);
    if (!entry.callbacks.size) { signal.removeEventListener("abort", entry.listener); this.abortWaiters.delete(signal); }
  }

  private async ensureLogsDirectory(): Promise<string> {
    if (!this.logsDirectory) {
      if (this.config.logsDirectory) this.logsDirectory = this.config.logsDirectory;
      else {
        const operationalBase = process.env.XDG_RUNTIME_DIR || tmpdir();
        const baseInfo = await lstat(operationalBase);
        const worldWritable = (baseInfo.mode & 0o002) !== 0;
        const sticky = (baseInfo.mode & 0o1000) !== 0;
        if (!baseInfo.isDirectory() || baseInfo.isSymbolicLink() || (worldWritable && !sticky)) throw new Error("ODOOLS_START_FAILED: unsafe operational temp base");
        await access(operationalBase, constants.R_OK | constants.W_OK | constants.X_OK);
        this.ownedOperationalDirectory = await mkdtemp(resolve(operationalBase, "odools-session-"));
        this.logsDirectory = resolve(this.ownedOperationalDirectory, "logs"); await mkdir(this.logsDirectory, { mode: 0o700 });
      }
    }
    const info = await lstat(this.logsDirectory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("ODOOLS_START_FAILED: unsafe logs directory");
    await access(this.logsDirectory, constants.R_OK | constants.W_OK | constants.X_OK);
    return this.logsDirectory;
  }

  private async startProcess(signal?: AbortSignal): Promise<void> {
    if (this.child) throw new Error("refusing to overwrite a live OdooLS child");
    const logsDirectory = await this.ensureLogsDirectory();
    if (signal?.aborted || this.permanentlyStopped) {
      if (this.ownedOperationalDirectory) { await rm(this.ownedOperationalDirectory, { recursive: true, force: true }); this.ownedOperationalDirectory = undefined; this.logsDirectory = undefined; }
      throw new Error("OdooLS startup cancelled");
    }
    this.parser = new LspFrameParser(); this.stderrBytes = 0; this.initialized = false;
    const child = spawn(this.config.binary, ["--config-path", this.config.config, "--selected-config", this.config.profile, "--logs-directory", logsDirectory], { cwd: this.config.workspace, env: childEnvironment(this.config), stdio: ["pipe", "pipe", "pipe"] });
    this.child = child; this.lastPid = child.pid; this.readiness.setAlive(true);
    child.stdout.on("data", (chunk: Buffer) => this.parser.push(chunk));
    this.parser.on("message", (message) => this.handle(message as RpcMessage));
    this.parser.on("error", (error) => { this.readiness.setRecovery({ lastError: this.safeError(error) }); void this.disposeChild(); });
    child.stderr.on("data", (chunk: Buffer) => { if (this.stderrBytes >= 64 * 1024) return; const text = chunk.subarray(0, 64 * 1024 - this.stderrBytes).toString(); this.stderrBytes += Buffer.byteLength(text); this.emit("stderr", text); });
    child.on("error", (error) => this.onUnexpectedExit(error));
    child.on("exit", (code, signal) => { if (this.child === child) { this.child = undefined; this.initialized = false; if (!this.stopping) this.onUnexpectedExit(new Error(`OdooLS exited (${String(code ?? signal)})`)); } });
    try {
      await this.request("initialize", { processId: process.pid, rootUri: pathToFileURL(this.config.workspace).href, capabilities: { workspace: { configuration: true } }, initializationOptions: { selectedProfile: this.config.profile } }, this.config.startupTimeoutMs);
      if (this.stopping || this.child !== child) throw new Error("OdooLS startup cancelled");
      this.notify("initialized", {}); this.initialized = true;
      for (const [uri, document] of this.documents) this.notify("textDocument/didOpen", { textDocument: { uri, languageId: document.languageId, version: document.version, text: document.text } });
    } catch (error) { await this.disposeChild(); this.readiness.setAlive(false); throw error; }
  }

  async stop(): Promise<void> { this.permanentlyStopped = true; await this.stopInternal(true); }

  private async settleCleanup(cleanup: Promise<void>, label: string): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    const report = (detail: string) => {
      this.cleanupDelayed = true;
      this.readiness.setRecovery({ lastError: `${label}: ${detail}; disposal continues in background; retry after cleanup completes` });
    };
    const observed = cleanup.catch((error) => {
      this.permanentlyStopped = true;
      report(`cleanup failed: ${this.safeError(error)}`);
    }).finally(() => {
      this.cleanupTasks.delete(observed);
      if (!this.cleanupTasks.size && this.cleanupDelayed && !this.permanentlyStopped) {
        this.cleanupDelayed = false;
        this.readiness.setRecovery({ lastError: null });
      }
    });
    this.cleanupTasks.add(observed);
    try {
      await Promise.race([observed, new Promise<void>((resolve) => {
        timer = setTimeout(() => { report(`cleanup exceeded ${CLEANUP_GRACE_MS}ms grace`); resolve(); }, CLEANUP_GRACE_MS);
      })]);
    } finally { if (timer) clearTimeout(timer); }
  }

  private async stopInternal(cancelActivation: boolean): Promise<void> {
    if (cancelActivation) this.activationAbortController?.abort();
    if (this.stopping && !this.child && !this.restartLoop) {
      this.readiness.setLifecycleState(this.permanentlyStopped ? "stopped" : "dormant"); return;
    }
    this.readiness.setLifecycleState("stopping");
    this.stopping = true; this.restartAbortController?.abort();
    const watcher = this.watcher; this.watcher = undefined;
    const watcherCleanup = watcher ? this.settleCleanup(watcher.close(), "watcher cleanup") : Promise.resolve();
    if (this.restartLoop) await this.settleCleanup(this.restartLoop, "restart cleanup");
    this.readiness.setRecovery({ watcherDocumentCount: 0, watcherState: this.config.watcherEnabled ? "stopped" : "disabled" });
    if (this.child) {
      try { if (this.initialized) await this.request("shutdown", null, Math.min(this.config.requestTimeoutMs, 200)); } catch { /* force cleanup */ }
      try { this.notify("exit"); } finally { await this.disposeChild(); }
    }
    this.rejectAll(new Error("OdooLS session stopped")); this.documents.clear(); this.watcherDocuments.clear(); this.updateWatcherCount(); this.readiness.setAlive(false);
    await watcherCleanup;
    if (this.ownedOperationalDirectory) { await rm(this.ownedOperationalDirectory, { recursive: true, force: true }); this.ownedOperationalDirectory = undefined; this.logsDirectory = undefined; }
    this.readiness.setLifecycleState(this.permanentlyStopped ? "stopped" : "dormant");
  }

  async open(uri: string, path: string, text?: string, isCurrent: () => boolean = () => true): Promise<void> {
    const existing = this.documents.get(uri); const current = text ?? await readFile(path, "utf8");
    if (!isCurrent()) return;
    if (!existing) {
      const document = { path, version: 1, text: current, languageId: language(path) }; this.documents.set(uri, document);
      this.notify("textDocument/didOpen", { textDocument: { uri, languageId: document.languageId, version: document.version, text: current } });
    } else if (existing.text !== current) {
      existing.version++; existing.text = current; existing.path = path;
      this.notify("textDocument/didChange", { textDocument: { uri, version: existing.version }, contentChanges: [{ text: current }] });
    }
  }

  async request(method: string, params?: unknown, timeout = this.config.requestTimeoutMs, signal?: AbortSignal): Promise<unknown> {
    if (!this.child) throw new Error("OdooLS session is not running");
    const id = this.nextId++;
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.cancel(id); this.pending.delete(id); pending.abortCleanup?.(); reject(new Error(`OdooLS request timed out: ${method}`)); }, timeout);
      const pending: Pending = { resolve, reject, timer };
      if (signal) { const abort = () => { this.cancel(id); this.pending.delete(id); clearTimeout(timer); reject(new Error(`OdooLS request cancelled: ${method}`)); }; signal.addEventListener("abort", abort, { once: true }); pending.abortCleanup = () => signal.removeEventListener("abort", abort); }
      this.pending.set(id, pending); this.write({ jsonrpc: "2.0", id, method, params });
    });
  }
  notify(method: string, params?: unknown): void { if (this.child && !this.child.stdin.destroyed) this.write({ jsonrpc: "2.0", method, params }); }
  private write(message: unknown): void { this.child?.stdin.write(encodeFrame(message)); }
  private cancel(id: JsonRpcId): void { this.notify("$/cancelRequest", { id }); }

  private handle(message: RpcMessage): void {
    this.readiness.touch();
    if (message.id !== undefined && !message.method) { const pending = this.pending.get(message.id); if (!pending) return; this.pending.delete(message.id); clearTimeout(pending.timer); pending.abortCleanup?.(); if (message.error) pending.reject(new Error(message.error.message ?? "OdooLS request failed")); else pending.resolve(message.result); return; }
    if (message.id !== undefined && message.method) { this.handleReverseRequest(message); return; }
    const params = message.params;
    if (message.method === "$/progress") { const kind = params?.value?.kind; const token = String(params?.token ?? ""); if (kind === "begin") this.readiness.progressBegin(token); if (kind === "end") this.readiness.progressEnd(token); }
    else if (message.method === "$Odoo/loadingStatusUpdate") this.readiness.setLoading(params !== false && params !== "stop");
    else if (message.method === "$Odoo/setConfiguration") this.readiness.setConfiguration(Array.isArray(params) ? params : params?.diagnostics ?? []);
    else if (message.method === "$/odoo/diagnostic_config") this.readiness.addConfigurationDiagnostics(Array.isArray(params) ? params : params?.diagnostics ?? [params]);
    else if (message.method === "$Odoo/javascriptReady") this.readiness.setJavascriptState("ready");
    else if (message.method === "$Odoo/javascriptUnavailable") this.readiness.setJavascriptState("unavailable", [String(params?.message ?? params ?? "JavaScript unavailable")]);
    else if (message.method === "$Odoo/jsLsStatus" || message.method === "$/odoo/jsLsStatus") this.readiness.setJavascriptStatus(params === true || params?.ready === true || params?.status === "ready" || params?.status === true);
    else if (message.method === "$/cancelRequest") { const id = params?.id as JsonRpcId; this.observedCancelIds.push(id); this.emit("cancelReceived", id); }
  }
  private handleReverseRequest(message: RpcMessage): void {
    let result: unknown = null;
    if (message.method === "workspace/configuration") result = (message.params?.items ?? []).map(() => ({ selectedProfile: this.config.profile }));
    else if (message.method === "window/workDoneProgress/create") result = null;
    this.write({ jsonrpc: "2.0", id: message.id, result });
  }

  private onUnexpectedExit(error: Error): void {
    if (this.stopping || this.restartLoop || this.activationPromise) return;
    this.rejectAll(new Error(`OdooLS crashed: ${this.safeError(error)}`));
    this.readiness.setRecovery({ lastCrash: this.safeError(error) });
    const now = Date.now(); this.restartTimes = this.restartTimes.filter((time) => now - time <= this.config.restartWindowMs);
    this.restartLoop = this.recover().finally(() => { this.restartLoop = undefined; });
  }
  private async recover(): Promise<void> {
    const watcher = this.watcher; this.watcher = undefined;
    if (watcher) await this.settleCleanup(watcher.close(), "recovery watcher cleanup");
    if (this.stopping || this.permanentlyStopped || this.cleanupTasks.size) return;
    this.readiness.setRecovery({ watcherDocumentCount: 0, watcherState: this.config.watcherEnabled ? "stopped" : "disabled" });
    const now = Date.now();
    if (this.restartTimes.length >= this.config.restartMaxAttempts) { this.readiness.setRecovery({ lastError: "automatic restart budget exhausted" }, "failed"); return; }
    this.restartTimes.push(now); this.restartCount++; this.readiness.resetForRestart();
    this.readiness.setRecovery({ restartCount: this.restartCount, watcherState: this.config.watcherEnabled ? "starting" : "disabled" }, "restarting");
    this.restartAbortController = new AbortController();
    try {
      await abortableDelay(this.config.restartBackoffMs, this.restartAbortController.signal);
      if (this.stopping) return;
      await this.startProcess(this.restartAbortController.signal);
      await this.waitUntilReady(this.config.startupTimeoutMs, this.restartAbortController.signal);
      await this.startWatcher(); this.readiness.clearRecoveryState();
    } catch (error) {
      if (!this.stopping) this.readiness.setRecovery({ lastError: this.safeError(error) }, "failed");
    } finally { this.restartAbortController = undefined; }
  }

  private async startWatcher(): Promise<void> {
    if (!this.config.watcherEnabled || this.watcher || this.stopping) return;
    this.readiness.setRecovery({ watcherState: "starting", watcherError: null });
    const watcher: SourceWatcher = new SourceWatcher(
      this.config.allowedRoots,
      this.config.guard,
      this.config.watcherDebounceMs,
      async (changes, signal) => this.forwardWatchedChanges(changes, () => !signal.aborted && !this.stopping && this.watcher === watcher),
      (error) => { if (!this.stopping && this.watcher === watcher) this.readiness.setRecovery({ watcherState: "failed", watcherError: this.safeError(error) }); },
    );
    this.watcher = watcher;
    try { await watcher.start(); if (!this.stopping && this.watcher === watcher) this.readiness.setRecovery({ watcherState: "watching" }); }
    catch (error) { if (!this.stopping && this.watcher === watcher) this.readiness.setRecovery({ watcherState: "failed", watcherError: this.safeError(error) }); if (this.watcher === watcher) this.watcher = undefined; await this.settleCleanup(watcher.close(), "watcher startup cleanup"); }
  }

  private async forwardWatchedChanges(changes: WatchedFileChange[], isCurrent: () => boolean): Promise<void> {
    for (const change of changes) {
      if (!isCurrent()) return;
      if (change.kind === "delete") {
        if (this.documents.has(change.uri)) this.notify("textDocument/didClose", { textDocument: { uri: change.uri } });
        this.documents.delete(change.uri); this.watcherDocuments.delete(change.uri);
        this.notify("workspace/didChangeWatchedFiles", { changes: [{ uri: change.uri, type: 3 }] });
        continue;
      }
      const { file } = change;
      const watcherManaged = !this.documents.has(file.uri) || this.watcherDocuments.has(file.uri);
      await this.open(file.uri, file.absolutePath, file.text, isCurrent);
      if (!isCurrent()) return;
      if (watcherManaged) this.touchWatcherDocument(file.uri);
    }
    if (isCurrent()) this.updateWatcherCount();
  }
  private touchWatcherDocument(uri: string): void {
    this.watcherDocuments.delete(uri); this.watcherDocuments.set(uri, true);
    while (this.watcherDocuments.size > this.config.maxWatcherDocuments) {
      const evicted = this.watcherDocuments.keys().next().value as string;
      this.watcherDocuments.delete(evicted);
      if (this.documents.delete(evicted)) this.notify("textDocument/didClose", { textDocument: { uri: evicted } });
    }
  }
  private updateWatcherCount(): void { this.readiness.setRecovery({ watcherDocumentCount: this.watcherDocuments.size }); }

  private async disposeChild(): Promise<void> {
    const child = this.child; this.child = undefined; this.initialized = false;
    if (!child) return;
    if (!child.stdin.destroyed) child.stdin.destroy();
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    await new Promise<void>((resolve) => { if (child.exitCode !== null || child.signalCode !== null) resolve(); else { const timer = setTimeout(() => { child.kill("SIGKILL"); resolve(); }, 100); child.once("exit", () => { clearTimeout(timer); resolve(); }); } });
  }
  private rejectAll(error: Error): void { for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.abortCleanup?.(); pending.reject(error); } this.pending.clear(); }
  private safeError(error: unknown): string { return String(error instanceof Error ? error.message : error).replace(/[\r\n]+/g, " ").slice(0, 500); }
  async waitUntilReady(timeoutMs = this.config.startupTimeoutMs, signal?: AbortSignal): Promise<void> {
    const start = Date.now();
    while (!this.readiness.isReady()) { if (signal?.aborted) throw new Error("OdooLS readiness wait cancelled"); if (Date.now() - start > timeoutMs) throw new Error(`OdooLS readiness timed out: ${JSON.stringify(this.readiness.snapshot())}`); await abortableDelay(50, signal); }
  }
}

function language(path: string): string { return path.endsWith(".py") || path.endsWith(".pyi") ? "python" : path.endsWith(".xml") ? "xml" : path.endsWith(".js") ? "javascript" : path.endsWith(".ts") ? "typescript" : "plaintext"; }
function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (!ms) return signal?.aborted ? Promise.reject(new Error("cancelled")) : Promise.resolve();
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new Error("cancelled")); return; }
    const cleanup = () => signal?.removeEventListener("abort", abort);
    const finish = () => { cleanup(); resolve(); };
    const timer = setTimeout(finish, ms);
    const abort = () => { clearTimeout(timer); cleanup(); reject(new Error("cancelled")); };
    signal?.addEventListener("abort", abort, { once: true });
  });
}
