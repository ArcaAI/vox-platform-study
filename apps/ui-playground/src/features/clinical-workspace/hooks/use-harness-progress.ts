/**
 * useHarnessProgress (TASK-345 — live harness activity feed).
 *
 * Subscribes to `GET /consultations/:id/harness-progress/stream` (SSE) while
 * the review panel sits in its "generating" state. Because `EventSource` can't
 * send an Authorization header, we first mint a one-shot ticket via
 * `POST /auth/stream-ticket` (scope `consultation_harness_progress:<id>`) and
 * connect with `?ticket=<tok>` — mirroring `useLiveSummaryStream`.
 *
 * Every SSE message is FULL-STATE (the complete folded stage list), so state
 * management is trivial: keep the latest event. Heartbeats and parse failures
 * are ignored; the terminal `closed:true` event (draft persisted) closes the
 * stream. A dead pipeline simply yields no stages — the panel keeps its static
 * fallback text.
 */
import { useEffect, useRef, useState } from 'react';
import { useArcaStore, type AgenticClient } from '@arcaai/vox';
import { buildHarnessProgressStreamUrl, fetchStreamTicket } from '../api/clinical-workspace.api';
import { harnessProgressScope } from '../constants';
import { reduceHarnessProgressMessage, type HarnessProgressStage } from '../lib/harness-progress';

export type HarnessProgressStreamStatus = 'idle' | 'connecting' | 'open' | 'closed' | 'error';

export interface UseHarnessProgressResult {
  /** Latest full stage checklist (empty until the first event arrives). */
  stages: HarnessProgressStage[];
  /** Total stages in the run (when the harness reported it). */
  total: number | undefined;
  /** True once the terminal event arrived (draft persisted). */
  closed: boolean;
  status: HarnessProgressStreamStatus;
  error: string | null;
}

export interface UseHarnessProgressOptions {
  consultationId: string | null;
  /** Connect only while the draft "generating" wait state is active. */
  enabled: boolean;
}

export function useHarnessProgress({ consultationId, enabled }: UseHarnessProgressOptions): UseHarnessProgressResult {
  const apiClient = useArcaStore((s: { apiClient: AgenticClient | null }) => s.apiClient);

  const [stages, setStages] = useState<HarnessProgressStage[]>([]);
  const [total, setTotal] = useState<number | undefined>(undefined);
  const [closed, setClosed] = useState(false);
  const [status, setStatus] = useState<HarnessProgressStreamStatus>('idle');
  const [error, setError] = useState<string | null>(null);

  // Reset the accumulated checklist whenever the consultation changes.
  const lastConsultationRef = useRef<string | null>(null);
  useEffect(() => {
    if (consultationId !== lastConsultationRef.current) {
      lastConsultationRef.current = consultationId;
      setStages([]);
      setTotal(undefined);
      setClosed(false);
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
        const { ticket } = await fetchStreamTicket(apiClient, harnessProgressScope(consultationId));
        if (cancelled) return;

        const url = buildHarnessProgressStreamUrl(apiClient, consultationId, ticket);
        source = new EventSource(url);

        source.onopen = () => {
          if (!cancelled) setStatus('open');
        };

        source.onmessage = (e: MessageEvent) => {
          if (cancelled) return;
          const message = reduceHarnessProgressMessage(typeof e.data === 'string' ? e.data : '');
          if (message.kind === 'event' || message.kind === 'closed') {
            setStages(message.event.stages);
            setTotal(message.event.total);
          }
          if (message.kind === 'closed') {
            setClosed(true);
            setStatus('closed');
            source?.close();
          }
        };

        source.onerror = () => {
          if (cancelled) return;
          // The browser auto-reconnects; only surface a hard error once closed.
          if (source && source.readyState === EventSource.CLOSED) {
            setStatus('error');
            setError('Harness progress stream disconnected');
          }
        };
      } catch (err) {
        if (cancelled) return;
        // Graceful degradation: the panel keeps its static fallback text.
        setStatus('error');
        setError(err instanceof Error ? err.message : 'Failed to open harness progress stream');
      }
    })();

    return () => {
      cancelled = true;
      source?.close();
    };
  }, [apiClient, consultationId, enabled]);

  return { stages, total, closed, status, error };
}
