import type definitions from './worker-channels.json';

export type WorkerGroupKey = 'deck' | 'tutor' | 'feedforward' | 'video-processing';
export type WorkerChannelKey = keyof typeof definitions;
export interface ContractChannel {
  readonly key: WorkerChannelKey;
  readonly queueName: string;
  readonly queueSlot: string;
  readonly workloadClass: string;
  readonly concurrencyEnv: string;
  readonly defaultConcurrency: number;
  readonly group: WorkerGroupKey;
}
export interface WorkerContract {
  readonly environment: string;
  readonly namespace: string;
  readonly channels: readonly (ContractChannel & { readonly concurrency: number })[];
}
export const WORKER_CHANNELS: Readonly<Record<WorkerChannelKey, ContractChannel>>;
export const WORKER_GROUP_KEYS: readonly WorkerGroupKey[];
export const WORKER_GROUPS: Readonly<Record<WorkerGroupKey, readonly WorkerChannelKey[]>>;
export function resolveChannelConcurrency(
  channel: { concurrencyEnv: string; defaultConcurrency: number },
  env?: Record<string, string | undefined>,
): number;
export function requireQueueDimension(value: string | undefined, name: string): string;
export function resolveWorkerContract(env: Record<string, string | undefined>): WorkerContract;
