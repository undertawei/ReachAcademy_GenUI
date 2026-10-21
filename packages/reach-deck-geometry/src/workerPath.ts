import { createRequire } from 'node:module';

export function resolveGeometryWorkerPath(): string {
  return createRequire(import.meta.url).resolve('@reachany/reach-deck-geometry/worker');
}
