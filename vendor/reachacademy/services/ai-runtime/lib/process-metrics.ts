import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { Counter, Gauge, Histogram, Registry } from '@prometheus-io/client';

type DelayMonitor = Pick<
  ReturnType<typeof monitorEventLoopDelay>,
  'enable' | 'disable' | 'reset' | 'percentile' | 'max' | 'count'
>;

/** One sampler per process, owned by the private metrics listener(s), never by a request. */
export function createRuntimeProcessMetrics(
  delay: DelayMonitor = monitorEventLoopDelay({ resolution: 20 }),
) {
  const registry = new Registry();
  const cpu = new Counter({
    name: 'reach_process_cpu_seconds_total',
    help: 'Process CPU seconds since process start; includes all concurrent requests and workers.',
    labelNames: ['mode'] as const,
    registers: [registry],
  });
  const memory = new Gauge({
    name: 'reach_process_memory_bytes',
    help: 'Process memory, sampled every five seconds while the private metrics listener is open.',
    labelNames: ['kind'] as const,
    registers: [registry],
  });
  const lag = new Gauge({
    name: 'reach_process_event_loop_delay_seconds',
    help: 'Event-loop delay in the last completed five-second sampling window; zero before samples.',
    labelNames: ['statistic'] as const,
    registers: [registry],
  });
  const utilization = new Gauge({
    name: 'reach_process_event_loop_utilization_ratio',
    help: 'Event-loop active fraction during the last process sampling window.',
    registers: [registry],
  });
  const lagWindows = new Histogram({
    name: 'reach_process_event_loop_window_max_seconds',
    help: 'Maximum event-loop delay per completed sampling window; retains spikes between scrapes.',
    buckets: [0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
    registers: [registry],
  });
  const sampledAt = new Gauge({
    name: 'reach_process_sample_timestamp_seconds',
    help: 'Time of the latest process sample; stale samples indicate a blocked or stopped sampler.',
    registers: [registry],
  });
  let previousCpu = { user: 0, system: 0 };
  let previousUtilization = performance.eventLoopUtilization();
  let timer: ReturnType<typeof setInterval> | undefined;
  let owners = 0;

  function sample() {
    const currentCpu = process.cpuUsage();
    cpu.inc({ mode: 'user' }, Math.max(0, currentCpu.user - previousCpu.user) / 1e6);
    cpu.inc({ mode: 'system' }, Math.max(0, currentCpu.system - previousCpu.system) / 1e6);
    previousCpu = currentCpu;
    const usage = process.memoryUsage();
    memory.set({ kind: 'rss' }, usage.rss);
    memory.set({ kind: 'heap_used' }, usage.heapUsed);
    memory.set({ kind: 'heap_total' }, usage.heapTotal);
    memory.set({ kind: 'external' }, usage.external);
    memory.set({ kind: 'array_buffers' }, usage.arrayBuffers);
    const currentUtilization = performance.eventLoopUtilization();
    utilization.set(
      performance.eventLoopUtilization(currentUtilization, previousUtilization).utilization,
    );
    previousUtilization = currentUtilization;
    lag.set({ statistic: 'p99' }, delay.count > 0 ? delay.percentile(99) / 1e9 : 0);
    lag.set({ statistic: 'max' }, delay.count > 0 ? delay.max / 1e9 : 0);
    if (delay.count > 0) lagWindows.observe(delay.max / 1e9);
    delay.reset();
    sampledAt.set(Date.now() / 1000);
  }

  function safelySample() {
    try {
      sample();
    } catch {
      // Observability must never crash the API. The sample timestamp exposes stale collection.
    }
  }

  return {
    registry,
    acquire(): () => void {
      if (owners++ === 0) {
        previousUtilization = performance.eventLoopUtilization();
        delay.enable();
        safelySample();
        timer = setInterval(safelySample, 5_000);
        timer.unref();
      }
      let released = false;
      return () => {
        if (released) return;
        released = true;
        if (--owners === 0) {
          clearInterval(timer);
          timer = undefined;
          delay.disable();
          delay.reset();
        }
      };
    },
  };
}

const KEY = Symbol.for('reachany.ai-runtime.process-metrics.v1');
const scope = globalThis as typeof globalThis & {
  [KEY]?: ReturnType<typeof createRuntimeProcessMetrics>;
};
export const runtimeProcessMetrics = (scope[KEY] ??= createRuntimeProcessMetrics());
