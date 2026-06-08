/**
 * useLiveSummaryStream (TASK-330 P3, WS4).
 *
 * Subscribes to `GET /consultations/:id/live-summary/stream` (SSE). Because
 * `EventSource` can't send an Authorization header, we first mint a one-shot
 * ticket via `POST /auth/stream-ticket` (scope `consultation_live_summary:<id>`)
 * and connect with `?ticket=<tok>` — mirroring the existing job-updates SSE.
 *
 * Raw `message` payloads are classified by the pure `reduceLiveSummaryMessage`
 * reducer: summary/closed events update state, heartbeats and parse failures
 * are ignored. The terminal `closed:true` event closes the stream.
 */
import { useEffect, useRef, useState } from 'react';
import { useArcaStore, type AgenticClient } from '@arcaai/vox';
import { buildLiveSummaryStreamUrl, fetchStreamTicket } from '../api/clinical-workspace.api';
import { liveSummaryScope } from '../constants';
import { reduceLiveSummaryMessage } from '../lib/live-summary';
import type { LiveSummaryEvent } from '../types';

export type LiveSummaryStreamStatus = 'idle' | 'connecting' | 'open' | 'closed' | 'error';

export interface UseLiveSummaryStreamResult {
  event: LiveSummaryEvent | null;
  status: LiveSummaryStreamStatus;
  error: string | null;
  lastUpdatedAt: string | null;
}

export interface UseLiveSummaryStreamOptions {
  consultationId: string | null;
  /** Connect only while recording is active. */
  enabled: boolean;
}

export function useLiveSummaryStream({ consultationId, enabled }: UseLiveSummaryStreamOptions): UseLiveSummaryStreamResult {
  const apiClient = useArcaStore((s: { apiClient: AgenticClient | null }) => s.apiClient);

  const [event, setEvent] = useState<LiveSummaryEvent | null>(null);
  const [status, setStatus] = useState<LiveSummaryStreamStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<string | null>(null);

  // Reset the accumulated summary whenever the consultation changes.
  const lastConsultationRef = useRef<string | null>(null);
  useEffect(() => {
    if (consultationId !== lastConsultationRef.current) {
      lastConsultationRef.current = consultationId;
      setEvent(null);
      setLastUpdatedAt(null);
      setError(null);
    }
  }, [consultationId]);

  useEffect(() => {
    if (!enabled || !consultationId || !apiClient) {
      setStatus('idle');
      return;
    }
    if (typeof EventSource === 'undefined') {
      setStatus('error');
      setError('Server-Sent Events are not supported in this environment');
      return;
    }

    let cancelled = false;
    let source: EventSource | null = null;
    setStatus('connecting');
    setError(null);

    (async () => {
      try {
        const { ticket } = await fetchStreamTicket(apiClient, liveSummaryScope(consultationId));
        if (cancelled) return;

        const url = buildLiveSummaryStreamUrl(apiClient, consultationId, ticket);
        source = new EventSource(url);

        source.onopen = () => {
          if (!cancelled) setStatus('open');
        };

        source.onmessage = (e: MessageEvent) => {
          if (cancelled) return;
          const message = reduceLiveSummaryMessage(typeof e.data === 'string' ? e.data : '');
          if (message.kind === 'event' || message.kind === 'closed') {
            setEvent(message.event);
            setLastUpdatedAt(message.event.updatedAt);
          }
          if (message.kind === 'closed') {
            setStatus('closed');
            source?.close();
          }
        };

        source.onerror = () => {
          if (cancelled) return;
          // The browser auto-reconnects; only surface a hard error once closed.
          if (source && source.readyState === EventSource.CLOSED) {
            setStatus('error');
            setError('Live summary stream disconnected');
          }
        };
      } catch (err) {
        if (cancelled) return;
        setStatus('error');
        setError(err instanceof Error ? err.message : 'Failed to open live summary stream');
      }
    })();

    return () => {
      cancelled = true;
      source?.close();
    };
  }, [apiClient, consultationId, enabled]);

  return { event, status, error, lastUpdatedAt };
}
