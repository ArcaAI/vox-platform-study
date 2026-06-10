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
 * are ignored; the terminal `closed:true` event closes the stream.
 *
 * Resilience (TASK-348):
 *   - The one-shot ticket is consumed on connect, so the browser's native
 *     EventSource auto-reconnect can never succeed. On error the hook closes
 *     the dead source and re-mints a fresh ticket with bounded backoff
 *     (MAJ-4); `status: 'error'` is surfaced only once retries exhaust.
 *   - A `closed:true` snapshot replayed on subscribe (the server keeps it for
 *     1h) is recorded but does NOT stop the stream; a later non-closed event
 *     (a fresh run for the same consultation) resets the terminal flags so
 *     the new run renders (MIN-6). Only a closed event arriving after live
 *     events on the same connection is treated as the genuine terminal.
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

/** Bounded ticket-re-minting reconnect (MAJ-4): 3 attempts, 1s→2s→4s backoff. */
const MAX_RECONNECT_ATTEMPTS = 3;
const RECONNECT_BASE_DELAY_MS = 1_000;
const RECONNECT_MAX_DELAY_MS = 5_000;

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
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    // Set once the GENUINE terminal event arrives — no further processing or reconnects.
    let terminal = false;
    let consecutiveFailures = 0;

    setStatus('connecting');
    setError(null);

    const scheduleReconnect = (err?: unknown) => {
      // The one-shot ticket was spent on connect — native auto-reconnect can't
      // succeed, so close the dead source and re-mint instead (MAJ-4).
      source?.close();
      source = null;
      consecutiveFailures += 1;
      if (consecutiveFailures > MAX_RECONNECT_ATTEMPTS) {
        // Graceful degradation: the panel falls back to its static text.
        setStatus('error');
        setError(err instanceof Error ? err.message : 'Harness progress stream disconnected');
        return;
      }
      const delay = Math.min(RECONNECT_BASE_DELAY_MS * 2 ** (consecutiveFailures - 1), RECONNECT_MAX_DELAY_MS);
      setStatus('connecting');
      retryTimer = setTimeout(() => {
        if (!cancelled) void connect();
      }, delay);
    };

    const connect = async () => {
      // Until a live (non-closed) event is seen on THIS connection, a closed
      // event is the replayed snapshot of an earlier run, not our terminal (MIN-6).
      let sawLiveEvent = false;
      try {
        const { ticket } = await fetchStreamTicket(apiClient, harnessProgressScope(consultationId));
        if (cancelled) return;

        const url = buildHarnessProgressStreamUrl(apiClient, consultationId, ticket);
        source = new EventSource(url);

        source.onopen = () => {
          if (!cancelled) setStatus('open');
        };

        source.onmessage = (e: MessageEvent) => {
          if (cancelled || terminal) return;
          consecutiveFailures = 0; // data flowing → the connection is healthy
          const message = reduceHarnessProgressMessage(typeof e.data === 'string' ? e.data : '');
          if (message.kind === 'event') {
            sawLiveEvent = true;
            setStages(message.event.stages);
            setTotal(message.event.total);
            // A fresh run can follow a stale terminal snapshot — clear the
            // terminal flags so the new run renders (MIN-6).
            setClosed(false);
            setStatus('open');
            setError(null);
          } else if (message.kind === 'closed') {
            setStages(message.event.stages);
            setTotal(message.event.total);
            setClosed(true);
            setStatus('closed');
            if (sawLiveEvent) {
              // Terminal for the run we watched live: stop for good.
              terminal = true;
              source?.close();
            }
            // Otherwise keep listening — this was a replayed snapshot and a
            // new run for the same consultation may start (MIN-6).
          }
        };

        source.onerror = () => {
          if (cancelled || terminal) return;
          scheduleReconnect();
        };
      } catch (err) {
        if (cancelled) return;
        scheduleReconnect(err);
      }
    };

    void connect();

    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
      source?.close();
    };
  }, [apiClient, consultationId, enabled]);

  return { stages, total, closed, status, error };
}
