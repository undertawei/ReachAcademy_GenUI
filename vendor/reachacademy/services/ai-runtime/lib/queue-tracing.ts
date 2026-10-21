import { SpanKind, type Telemetry } from 'bullmq';
import {
  activeTraceCarrier,
  observabilityEnabled,
  startObservationSpan,
  tracingEnabled,
  withTraceContext,
  type TraceCarrier,
  type TraceHandle,
} from '@reachany/observability/tracing';
import { parseTraceparent } from '@reachany/observability';
import channels from './worker-channels.json' with { type: 'json' };

type QueueContext = { carrier: TraceCarrier; handle?: TraceHandle };

/** BullMQ's native opts.telemetry envelope avoids changing or hashing business payloads. */
export function runtimeQueueTelemetry(queueName: string): Telemetry<QueueContext> | undefined {
  if (!observabilityEnabled()) return undefined;
  const channel = Object.values(channels).find((value) => value.queueName === queueName);
  const queue = channel?.queueName ?? 'unknown';
  return {
    contextManager: {
      active: () => ({ carrier: activeTraceCarrier() }),
      with: (value: QueueContext, execute) =>
        value.handle ? withTraceContext(value.handle, execute) : execute(),
      getMetadata: (value: QueueContext) => (tracingEnabled() ? JSON.stringify(value.carrier) : ''),
      fromMetadata: (_active: QueueContext, metadata: string): QueueContext => {
        try {
          if (metadata.length > 2048) return { carrier: {} };
          const value = JSON.parse(metadata) as TraceCarrier;
          if (!parseTraceparent(value?.traceparent)) return { carrier: {} };
          return {
            carrier: {
              traceparent: value.traceparent,
              ...(typeof value.requestId === 'string' &&
              /^[A-Za-z0-9._:-]{1,128}$/.test(value.requestId)
                ? { requestId: value.requestId }
                : {}),
            },
          };
        } catch {
          return { carrier: {} };
        }
      },
    },
    tracer: {
      startSpan: (_name, options, parent) => {
        const kind =
          options?.kind === SpanKind.PRODUCER
            ? 'producer'
            : options?.kind === SpanKind.CONSUMER
              ? 'consumer'
              : 'internal';
        const operation =
          kind === 'producer' ? 'publish' : kind === 'consumer' ? 'process' : 'operation';
        let handle: TraceHandle | undefined;
        try {
          handle = startObservationSpan({
            name: `queue.${operation}`,
            kind,
            carrier: parent?.carrier ?? activeTraceCarrier(),
            attributes: {
              'messaging.system': 'bullmq',
              'messaging.destination.name': queue,
              'messaging.operation.type': operation,
              channel: channel?.key ?? 'unknown',
            },
          });
        } catch {
          /* Observation initialization cannot block queue work. */
        }
        let errorType: string | undefined;
        return {
          setSpanOnContext: (current: QueueContext) =>
            handle ? { carrier: handle.carrier, handle } : current,
          // BullMQ attaches job options, result, IDs and exception text: never export them.
          setAttribute: () => {},
          setAttributes: () => {},
          addEvent: () => {},
          recordException: () => {
            errorType = 'queue_operation_failed';
          },
          end: () => {
            try {
              handle?.finish(undefined, errorType);
            } catch {
              /* Keep the job result. */
            }
          },
        };
      },
    },
  };
}
