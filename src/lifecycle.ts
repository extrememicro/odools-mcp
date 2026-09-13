export interface StartStopLifecycle {
  start(): Promise<void>;
  cancelStart?(): void;
  stop(): Promise<void>;
}

export class ShutdownCoordinator {
  private promise?: Promise<void>;

  constructor(
    private readonly shutdownLifecycle: () => Promise<void>,
    private readonly cleanup: () => Promise<void>,
  ) {}

  request(): Promise<void> {
    this.promise ??= this.shutdownLifecycle().finally(this.cleanup);
    return this.promise;
  }
}

export class LifecycleCoordinator {
  private target?: StartStopLifecycle;
  private startPromise?: Promise<void>;
  private shutdownPromise?: Promise<void>;
  private shutdownRequested = false;
  private cancellationRequested = false;

  async start(target: StartStopLifecycle): Promise<void> {
    if (this.target) throw new Error("Lifecycle already started");
    this.target = target;
    if (this.shutdownRequested) {
      this.shutdownPromise = undefined;
      await this.shutdown();
      return;
    }
    this.startPromise = target.start();
    try {
      await this.startPromise;
    } finally {
      if (this.shutdownRequested) await this.shutdown();
    }
  }

  shutdown(): Promise<void> {
    this.shutdownRequested = true;
    if (!this.cancellationRequested) { this.cancellationRequested = true; this.target?.cancelStart?.(); }
    this.shutdownPromise ??= this.settleStartThenStop();
    return this.shutdownPromise;
  }

  private async settleStartThenStop(): Promise<void> {
    try { await this.startPromise; } catch { /* startup owns cleanup; final stop remains mandatory */ }
    await this.target?.stop();
  }
}
