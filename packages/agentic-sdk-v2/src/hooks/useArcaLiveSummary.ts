/**
 * @arcaai/vox - useArcaLiveSummary Hook (TASK-543)
 *
 * SDK-native subscription to the LIVE running-SOAP stream a consultation emits
 * while recording (`GET /consultations/:id/live-summary/stream`). The server
 * publishes FULL-STATE snapshots (sections / entities / per-flush generation
 * stats), so the hook stays stateless: keep only the latest snapshot and close
 * on the terminal `closed: true` event (single-use ticket — never leave a
 * zombie EventSource on a dead channel).
 *
 * TRANSPORT: the stream TICKET is minted through the REST client (so a BFF's
 * auth/tenant injection applies), while the EventSource opens against
 * `apiClient.getStreamBaseUrl()` — the gateway directly when a `wsUrl` gateway
 * base is configured, else the REST base. This keeps long-lived SSE off the
 * REST BFF (the recommended pattern), with no per-host workaround. The ticket
 * scope is `consultation_live_summary:<id>`.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useApiOperation } from './useApiOperation';
import { SSEClient, type SSEApiClient } from '../core/SSEClient';
import { CONSULTATION_ENDPOINTS, liveSummaryScopeFor } from '../core/constants';
import type { LiveSummarySnapshot } from '../types/liveSummary';

export type LiveSummaryStreamStatus = 'idle' | 'connecting' | 'open' | 'error' | 'closed';

export interface UseArcaLiveSummaryReturn {
  /** Latest full-state snapshot (null before the first event). */
  snapshot: LiveSummarySnapshot | null;
  status: LiveSummaryStreamStatus;
  error: Error | null;
  /** Open (or re-open) the stream for a consultation. */
  start: (consultationId: string) => void;
  /** Close the stream and reset to idle. */
  stop: () => void;
}

export function useArcaLiveSummary(): UseArcaLiveSummaryReturn {
  const { apiClient, logger } = useApiOperation('useArcaLiveSummary');

  const [snapshot, setSnapshot] = useState<LiveSummarySnapshot | null>(null);
  const [status, setStatus] = useState<LiveSummaryStreamStatus>('idle');
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
      setSnapshot(null);
      setError(null);
      setStatus('connecting');

      const sse = new SSEClient(liveSummaryScopeFor(consultationId), apiClient as unknown as SSEApiClient, logger);
      sseRef.current = sse;

      sse.onOpen(() => setStatus('open'));

      sse.onMessage((data: string) => {
        try {
          const next = JSON.parse(data) as LiveSummarySnapshot;
          setSnapshot(next);
          if (next.closed) {
            sse.disconnect();
            if (sseRef.current === sse) sseRef.current = null;
            setStatus('closed');
          }
        } catch (parseError) {
          logger?.warn('Failed to parse live-summary SSE event', {
            operation: 'useArcaLiveSummary',
            component: 'useArcaLiveSummary',
            error: parseError as Error,
          });
        }
      });

      sse.onError(() => {
        setError(new Error('Live-summary SSE connection error'));
        setStatus('error');
      });

      sse.connect(`${apiClient.getStreamBaseUrl()}${CONSULTATION_ENDPOINTS.LIVE_SUMMARY_STREAM(consultationId)}`, { autoReconnect: true });
    },
    [apiClient, logger, teardown],
  );

  // Close on unmount so a navigating consumer never leaks the connection.
  useEffect(() => teardown, [teardown]);

  return { snapshot, status, error, start, stop };
}
