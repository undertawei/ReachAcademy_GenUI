export interface WorkerLifecycleConfig {
  drainTimeoutMs: number;
  terminationGraceSeconds: number;
  healthPort?: number;
}
export interface DrainableWorker {
  isRunning(): boolean;
  isPaused(): boolean;
  pause(doNotWaitActive: true): Promise<void>;
  close(): Promise<void>;
  on(event: 'error', listener: () => void): unknown;
}
export interface WorkerLifecycle {
  readonly stopping: boolean;
  readonly ready: boolean;
  readonly workerCount: number;
  readonly completion: Promise<{ code: number; reason: string; workers: number; errors: number }>;
  shutdown(): WorkerLifecycle['completion'];
  registerWorker(worker: DrainableWorker): void;
  registerProducer(producer: { close(): Promise<void> }): void;
  registerCleanup(cleanup: () => Promise<void>): void;
  start(startup: () => Promise<void>): Promise<void>;
}
export function resolveWorkerLifecycleConfig(
  env: Record<string, string | undefined>,
): WorkerLifecycleConfig;
export function createWorkerLifecycle(
  config: WorkerLifecycleConfig,
  ports?: {
    exit?: (code: number) => void;
    log?: (event: { event: string; phase: string; workers: number; errors: number }) => void;
  },
): WorkerLifecycle;
