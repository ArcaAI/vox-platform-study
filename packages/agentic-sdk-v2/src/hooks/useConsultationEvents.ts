/**
 * @arcaai/vox - useConsultationEvents Hook
 *
 * SDK-native subscription to the consultation-loop workflow event stream
 * (`GET /consultations/:id/loop/stream`) — an APPEND-ONLY feed of
 * discrete `LoopEvent`s (an action started/finished, a specialist dispatched,
 * derived context re-entering the bus), unlike `useArcaLiveSummary`'s
 * full-state snapshots. Modeled on `useArcaLiveSummary` (the leaner of the
 * two existing SSE-hook exemplars): `useApiOperation` for the SDK-initialized
 * client + logger, teardown-before-restart on every `start()` (single-use
 * tickets mean a stale connection is never left dangling), a fresh
 * `SSEClient(scope, apiClient, logger)` per connect, and connecting against
 * `apiClient.getStreamBaseUrl()` rather than the REST base.
 *
 * ## No `Last-Event-Id` resume — document, don't silently inherit
 *
 * `SSEClient` has NO cursor/resume mechanism: a reconnect (auto or manual)
 * mints a brand-new single-use ticket and opens a fresh `EventSource` with no
 * `Last-Event-Id`. Events published on the Redis channel while the
 * connection was down are gone — there is no server-side buffer for this
 * stream (it deliberately has no snapshot/fold/late-join, mirroring
 * `consultation:trajectory:{id}`). The 200-message resume buffer that exists
 * elsewhere in this SDK belongs to the WebSocket TRANSCRIPT path only and
 * does not apply here. A consumer that needs a complete history should read
 * it from wherever the loop persists its own record, not from this stream.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useApiOperation } from './useApiOperation';
import { SSEClient, type SSEApiClient } from '../core/SSEClient';
import { CONSULTATION_ENDPOINTS, loopEventsScopeFor } from '../core/constants';
import type { LoopEvent } from '../types/loopEvent';

export type ConsultationEventsStreamStatus = 'idle' | 'connecting' | 'open' | 'error' | 'closed';

/** Bound on the in-memory event log so a long-running consultation can't grow this list unboundedly. */
const MAX_RETAINED_EVENTS = 500;

export interface UseConsultationEventsReturn {
  /** Every `LoopEvent` received on the current connection, oldest first, capped at the most recent `MAX_RETAINED_EVENTS`. */
  events: LoopEvent[];
  /** The most recently received event, or `null` before the first one arrives. */
  latestEvent: LoopEvent | null;
  status: ConsultationEventsStreamStatus;
  error: Error | null;
  /** Open (or re-open) the stream for a consultation. */
  start: (consultationId: string) => void;
  /** Close the stream and reset to idle. */
  stop: () => void;
}

function isHeartbeat(value: unknown): boolean {
  return typeof value === 'object' && value !== null && (value as { type?: unknown }).type === 'heartbeat';
}

function isLoopEvent(value: unknown): value is LoopEvent {
  return typeof value === 'object' && value !== null && typeof (value as { kind?: unknown }).kind === 'string';
}

export function useConsultationEvents(): UseConsultationEventsReturn {
  const { apiClient, logger } = useApiOperation('useConsultationEvents');

  const [events, setEvents] = useState<LoopEvent[]>([]);
  const [latestEvent, setLatestEvent] = useState<LoopEvent | null>(null);
  const [status, setStatus] = useState<ConsultationEventsStreamStatus>('idle');
  const [error, setError] = useState<Error | null>(null);
  const sseRef = useRef<SSEClient | null>(null);

  const teardown = useCallback(() => {
    sseRef.current?.disconnect();
    sseRef.current = null;
  }, []);

  const stop = useCallback(() => {
    teardown();
    setStatus((previous) => (previous === 'idle' ? previous : 'closed'));
  }, [teardown]);

  const start = useCallback(
    (consultationId: string) => {
      if (!apiClient) throw new Error('SDK not initialized');

      // Replace any prior stream (single-use tickets — no zombie EventSource).
      teardown();
      setEvents([]);
      setLatestEvent(null);
      setError(null);
      setStatus('connecting');

      const sse = new SSEClient(loopEventsScopeFor(consultationId), apiClient as unknown as SSEApiClient, logger);
      sseRef.current = sse;

      sse.onOpen(() => setStatus('open'));

      sse.onMessage((data: string) => {
        try {
          const parsed: unknown = JSON.parse(data);
          if (isHeartbeat(parsed)) return;
          if (!isLoopEvent(parsed)) {
            logger?.warn('Ignoring malformed consultation-loop event', {
              operation: 'useConsultationEvents',
              component: 'useConsultationEvents',
            });
            return;
          }
          setLatestEvent(parsed);
          setEvents((previous) => {
            const next = [...previous, parsed];
            return next.length > MAX_RETAINED_EVENTS ? next.slice(next.length - MAX_RETAINED_EVENTS) : next;
          });
        } catch (parseError) {
          logger?.warn('Failed to parse consultation-loop SSE event', {
            operation: 'useConsultationEvents',
            component: 'useConsultationEvents',
            error: parseError as Error,
          });
        }
      });

      sse.onError(() => {
        setError(new Error('Consultation-loop SSE connection error'));
        setStatus('error');
      });

      sse.connect(`${apiClient.getStreamBaseUrl()}${CONSULTATION_ENDPOINTS.LOOP_STREAM(consultationId)}`, { autoReconnect: true });
    },
    [apiClient, logger, teardown],
  );

  // Close on unmount so a navigating consumer never leaks the connection.
  useEffect(() => teardown, [teardown]);

  return { events, latestEvent, status, error, start, stop };
}
