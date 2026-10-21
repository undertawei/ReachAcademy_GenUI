import { AsyncLocalStorage } from 'node:async_hooks';
import { performance } from 'node:perf_hooks';
import { Counter, Gauge, Histogram, Registry } from '@prometheus-io/client';

const PHASES = [
  'authorize',
  'import-recovery',
  'workspace-read',
  'recovery-projection',
  'materialized-read',
  'cache-decode',
  'projection-decode',
  'recovery-parse',
  'serialize',
] as const;
export type WorkspaceReadPhase = (typeof PHASES)[number];
type Sample = { elapsed_ms: number; count: number };
type ReadContext = {
  phases: Partial<Record<WorkspaceReadPhase, Sample>>;
  decodedBytes: number;
  projectionDecodedBytes: number;
};

/** Fixed route, fixed phase names and numeric summaries only; never accepts content or identities. */
export function createWorkspaceReadDiagnostics(
  options: {
    now?: () => number;
    log?: (value: Record<string, unknown>) => void;
  } = {},
) {
  const now = options.now ?? (() => performance.now());
  const log = options.log ?? ((value) => console.warn(JSON.stringify(value)));
  const storage = new AsyncLocalStorage<ReadContext>();
  const registry = new Registry();
  const inflight = new Gauge({
    name: 'reach_workspace_read_inflight',
    help: 'Workspace GET handlers currently running; excludes pre-handler socket/Next scheduling.',
    registers: [registry],
  });
  const phases = new Histogram({
    name: 'reach_workspace_read_phase_seconds',
    help: 'Inclusive workspace read phase wall time; nested phases overlap and must not be summed.',
    labelNames: ['phase'] as const,
    buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
    registers: [registry],
  });
  const bytes = new Counter({
    name: 'reach_workspace_read_cache_decoded_bytes_total',
    help: 'Cached JSON bytes decoded during workspace GET handlers, including repeated decoding.',
    registers: [registry],
  });
  const projectionBytes = new Counter({
    name: 'reach_workspace_read_projection_decoded_bytes_total',
    help: 'Cached V8 projection bytes decoded during workspace GET handlers.',
    registers: [registry],
  });
  let lastLogAt = -Infinity;

  function observe(phase: WorkspaceReadPhase, startedAt: number) {
    const context = storage.getStore();
    if (!context || !PHASES.includes(phase)) return;
    const elapsed = Math.max(0, now() - startedAt);
    const sample = (context.phases[phase] ??= { elapsed_ms: 0, count: 0 });
    sample.elapsed_ms += elapsed;
    sample.count += 1;
    phases.observe({ phase }, elapsed / 1000);
  }

  return {
    registry,
    async run<T>(work: () => Promise<T>): Promise<T> {
      const context: ReadContext = { phases: {}, decodedBytes: 0, projectionDecodedBytes: 0 };
      const startedAt = now();
      const cpu = process.cpuUsage();
      inflight.inc();
      try {
        return await storage.run(context, work);
      } finally {
        inflight.dec();
        const finishedAt = now();
        if (finishedAt - startedAt >= 1_000 && finishedAt - lastLogAt >= 30_000) {
          lastLogAt = finishedAt;
          try {
            const cpuDelta = process.cpuUsage(cpu);
            log({
              event: 'workspace_read_slow',
              route: '/api/reach-deck/workspace',
              elapsed_ms: finishedAt - startedAt,
              // This is explicitly process-wide, not CPU attributed to this individual request.
              process_cpu_during_request_ms: (cpuDelta.user + cpuDelta.system) / 1_000,
              decoded_bytes: context.decodedBytes,
              projection_decoded_bytes: context.projectionDecodedBytes,
              phases: context.phases,
            });
          } catch {
            // A failed diagnostic sink must not replace the request result or error.
          }
        }
      }
    },
    measure<T>(phase: WorkspaceReadPhase, work: () => T): T {
      if (!storage.getStore()) return work();
      const startedAt = now();
      try {
        return work();
      } finally {
        observe(phase, startedAt);
      }
    },
    async measureAsync<T>(phase: WorkspaceReadPhase, work: () => Promise<T>): Promise<T> {
      if (!storage.getStore()) return work();
      const startedAt = now();
      try {
        return await work();
      } finally {
        observe(phase, startedAt);
      }
    },
    recordBytes(value: number): void {
      const context = storage.getStore();
      if (!context || !Number.isSafeInteger(value) || value < 0) return;
      context.decodedBytes += value;
      bytes.inc(value);
    },
    recordProjectionBytes(value: number): void {
      const context = storage.getStore();
      if (!context || !Number.isSafeInteger(value) || value < 0) return;
      context.projectionDecodedBytes += value;
      projectionBytes.inc(value);
    },
  };
}

const KEY = Symbol.for('reachany.ai-runtime.workspace-read-diagnostics.v1');
const scope = globalThis as typeof globalThis & {
  [KEY]?: ReturnType<typeof createWorkspaceReadDiagnostics>;
};
const diagnostics = (scope[KEY] ??= createWorkspaceReadDiagnostics());
export const withWorkspaceReadDiagnostics = diagnostics.run;
export const measureWorkspaceReadPhase = diagnostics.measure;
export const measureWorkspaceReadPhaseAsync = diagnostics.measureAsync;
export const recordWorkspaceReadBytes = diagnostics.recordBytes;
export const recordWorkspaceReadProjectionBytes = diagnostics.recordProjectionBytes;
export const renderWorkspaceReadMetrics = () => diagnostics.registry.metrics();
