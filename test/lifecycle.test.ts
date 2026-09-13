import { describe, expect, it, vi } from "vitest";
import { LifecycleCoordinator, ShutdownCoordinator, type StartStopLifecycle } from "../src/lifecycle.js";

function deferred(): { promise: Promise<void>; resolve(): void; reject(error: Error): void } {
  let resolve!: () => void; let reject!: (error: Error) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => { resolve = resolvePromise; reject = rejectPromise; });
  return { promise, resolve, reject };
}

describe("CLI lifecycle coordination", () => {
  it("memoizes simultaneous shutdown triggers and cleans only after lifecycle settlement", async () => {
    const lifecycle = deferred();
    const events: string[] = [];
    const shutdownLifecycle = vi.fn(async () => { events.push("shutdown"); await lifecycle.promise; events.push("stopped"); });
    const cleanup = vi.fn(async () => { events.push("cleanup"); });
    const coordinator = new ShutdownCoordinator(shutdownLifecycle, cleanup);
    const requests = [coordinator.request(), coordinator.request(), coordinator.request(), coordinator.request()];
    expect(shutdownLifecycle).toHaveBeenCalledTimes(1);
    expect(cleanup).not.toHaveBeenCalled();
    lifecycle.resolve();
    await Promise.all(requests);
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(events).toEqual(["shutdown", "stopped", "cleanup"]);
  });
  it.each(["EOF", "SIGTERM"])("waits for deferred startup and stops exactly once after %s-equivalent shutdown", async () => {
    const startup = deferred(); const events: string[] = [];
    const target: StartStopLifecycle = {
      start: vi.fn(async () => { events.push("start"); await startup.promise; events.push("started"); }),
      cancelStart: vi.fn(() => events.push("cancel")),
      stop: vi.fn(async () => { events.push("stop"); }),
    };
    const lifecycle = new LifecycleCoordinator();
    const starting = lifecycle.start(target);
    const shutdownA = lifecycle.shutdown(); const shutdownB = lifecycle.shutdown();
    await Promise.resolve();
    expect(target.stop).not.toHaveBeenCalled();
    startup.resolve();
    await Promise.all([starting, shutdownA, shutdownB]);
    expect(target.cancelStart).toHaveBeenCalledTimes(1);
    expect(target.stop).toHaveBeenCalledTimes(1);
    expect(events.indexOf("stop")).toBeGreaterThan(events.indexOf("started"));
  });

  it("performs one final stop after failed startup settles", async () => {
    const startup = deferred();
    const target: StartStopLifecycle = { start: vi.fn(() => startup.promise), cancelStart: vi.fn(), stop: vi.fn(async () => undefined) };
    const lifecycle = new LifecycleCoordinator(); const starting = lifecycle.start(target); const shutdown = lifecycle.shutdown();
    startup.reject(new Error("startup failed"));
    await expect(starting).rejects.toThrow("startup failed");
    await shutdown;
    expect(target.stop).toHaveBeenCalledTimes(1);
  });
});
