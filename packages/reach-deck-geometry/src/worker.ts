import { parentPort } from 'node:worker_threads';
import { evaluateGeometry } from './index.js';
import { createGeometrySessionV2 } from './sessionV2.js';

if (!parentPort) throw new Error('geometry_worker_requires_parent');
const port = parentPort;
port.once('message', (message: unknown) => {
  try {
    if (message === null || typeof message !== 'object') throw new Error('invalid_worker_message');
    const request = message as { type?: unknown; markers?: unknown };
    if (
      request.type !== 'evaluate' ||
      !Array.isArray(request.markers) ||
      request.markers.length < 1 ||
      request.markers.length > 4
    )
      throw new Error('invalid_worker_message');
    const results = request.markers.map(
      (entry: { instanceId: string; envelope: unknown; state?: unknown }) => {
        if (Object.hasOwn(entry, 'state')) {
          const session = createGeometrySessionV2(entry.envelope, entry.instanceId);
          try {
            if (entry.state !== null) {
              const adopted = session.setState(entry.state);
              if (!adopted.ok)
                return {
                  instanceId: entry.instanceId,
                  valid: false,
                  diagnostics: [{ code: adopted.code, path: '$state' }],
                };
            }
            const computed = session.getComputedState();
            return {
              instanceId: entry.instanceId,
              valid: computed.valid,
              diagnostics: computed.diagnostics,
            };
          } finally {
            session.dispose();
          }
        }
        const { valid, diagnostics } = evaluateGeometry(entry.envelope);
        return { instanceId: entry.instanceId, valid, diagnostics };
      },
    );
    port.postMessage({ type: 'result', results });
  } catch {
    port.postMessage({ type: 'failed' });
  }
});
port.postMessage({ type: 'ready' });
