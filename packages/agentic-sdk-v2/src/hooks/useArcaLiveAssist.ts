/**
 * @arcaai/vox - useArcaLiveAssist Hook
 *
 * SDK-native subscription to the live clinician-assist stream — the correction
 * proposals and interpreter suggestions the `agent.grammar` node publishes
 * while a consultation runs (`GET /consultations/:id/live-assist/stream`).
 *
 * TRANSPORT: identical to `useArcaLiveSummary`. The stream TICKET is minted
 * through the REST client (so a BFF's auth/tenant injection applies), while the
 * EventSource opens against `apiClient.getStreamBaseUrl()` — the gateway
 * directly when a `wsUrl` gateway base is configured, else the REST base. The
 * ticket scope is `consultation_live_assist:<id>`, single-use, re-minted on
 * every reconnect.
 *
 * Two ways this feed differs from the live-summary one, both load-bearing:
 *
 *  - **No terminal event.** The gateway never sends a `closed` frame; the
 *    client closes the stream (on `stop()`, on unmount, or when the
 *    consultation id changes). Nothing here waits for a final event.
 *  - **Full state, both branches, every time.** The gateway folds the branch a
 *    publish did NOT carry back onto the snapshot, so each event is the whole
 *    current truth: the hook keeps only the latest one. A branch the server
 *    omitted means "there are none" — merging successive events client-side
 *    would resurrect withdrawn PHI.
 *
 * The feed is ADVISORY and fails OPEN: a parse failure or a dropped connection
 * degrades the assist panel, never the consultation. Nothing here has been
 * applied to the note (`corrections.applied` is `false` under proposal-first) —
 * the clinician decides, and a consumer should check `corrections.textSha256`
 * against the text it is about to patch before honouring a proposal's offsets.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useApiOperation } from './useApiOperation';
import { SSEClient, type SSEApiClient } from '../core/SSEClient';
import { CONSULTATION_ENDPOINTS, liveAssistScopeFor } from '../core/constants';
import type { LiveAssistCorrections, LiveAssistEvent, LiveAssistSuggestion } from '../types/liveAssist';

export type LiveAssistStreamStatus = 'idle' | 'connecting' | 'open' | 'error' | 'closed';

export interface UseArcaLiveAssistReturn {
  /** Latest full-state snapshot (null before the first event). */
  lastEvent: LiveAssistEvent | null;
  /** The current suggestions branch — empty when the latest snapshot omitted it. */
  suggestions: LiveAssistSuggestion[];
  /** The current corrections branch — null when the latest snapshot omitted it. */
  corrections: LiveAssistCorrections | null;
  status: LiveAssistStreamStatus;
  /** `status === 'open'`, for the common "is the panel live?" check. */
  connected: boolean;
  error: Error | null;
  /** Open (or re-open) the stream for a consultation. */
  start: (consultationId: string) => void;
  /** Close the stream and reset to closed — this feed has no terminal event. */
  stop: () => void;
}

/**
 * @param consultationId - when supplied, the stream opens on mount and follows
 *   the id across changes. Omit it to drive the stream manually with
 *   `start()` / `stop()`.
 */
export function useArcaLiveAssist(consultationId?: string): UseArcaLiveAssistReturn {
  const { apiClient, logger } = useApiOperation('useArcaLiveAssist');

  const [lastEvent, setLastEvent] = useState<LiveAssistEvent | null>(null);
  const [status, setStatus] = useState<LiveAssistStreamStatus>('idle');
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
    (id: string) => {
      if (!apiClient) throw new Error('SDK not initialized');

      // Replace any prior stream (single-use tickets — no zombie EventSource).
      teardown();
      setLastEvent(null);
      setError(null);
      setStatus('connecting');

      const sse = new SSEClient(liveAssistScopeFor(id), apiClient as unknown as SSEApiClient, logger);
      sseRef.current = sse;

      sse.onOpen(() => setStatus('open'));

      sse.onMessage((data: string) => {
        try {
          setLastEvent(JSON.parse(data) as LiveAssistEvent);
        } catch (parseError) {
          // Advisory feed: drop the frame, keep the last good snapshot.
          logger?.warn('Failed to parse live-assist SSE event', {
            operation: 'useArcaLiveAssist',
            component: 'useArcaLiveAssist',
            error: parseError as Error,
          });
        }
      });

      sse.onError(() => {
        setError(new Error('Live-assist SSE connection error'));
        setStatus('error');
      });

      sse.connect(`${apiClient.getStreamBaseUrl()}${CONSULTATION_ENDPOINTS.LIVE_ASSIST_STREAM(id)}`, { autoReconnect: true });
    },
    [apiClient, logger, teardown],
  );

  // Auto-connect for the common case, and follow the id when it changes.
  useEffect(() => {
    if (!consultationId || !apiClient) return;
    start(consultationId);
    return teardown;
  }, [consultationId, apiClient, start, teardown]);

  // Close on unmount so a navigating consumer never leaks the connection.
  useEffect(() => teardown, [teardown]);

  return {
    lastEvent,
    suggestions: lastEvent?.suggestions ?? [],
    corrections: lastEvent?.corrections ?? null,
    status,
    connected: status === 'open',
    error,
    start,
    stop,
  };
}
