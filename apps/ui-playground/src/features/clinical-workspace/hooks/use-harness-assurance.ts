/**
 * useHarnessAssurance (TASK-355 Phase D Slice 6b — Q5 live per-claim assurance feed).
 *
 * Subscribes to `GET /consultations/:id/harness-assurance/stream` (SSE) while an
 * optimistically delivered draft awaits its inferential verdict
 * (`DRAFT_PENDING_SENSORS`). Because `EventSource` can't send an Authorization
 * header, we first mint a one-shot ticket via `POST /auth/stream-ticket`
 * (scope `consultation_harness_assurance:<id>`) and connect with `?ticket=<tok>`
 * — mirroring `useHarnessProgress`.
 *
 * Every SSE message is FULL-STATE (the complete accumulated claim-verdict list),
 * so state management is trivial: keep the latest event. Heartbeats and parse
 * failures are ignored; the terminal `assurance_complete` event (`closed:true`)
 * carries the aggregate gateDecision / safetyFlag / postSignAlert and closes the
 * stream. Resilience matches `useHarnessProgress`: the spent one-shot ticket
 * makes native auto-reconnect impossible, so on error we close the dead source
 * and re-mint with bounded backoff; a stale closed snapshot replayed on connect
 * is recorded but does not stop a later fresh run for the same consultation.
 */
import { useEffect, useRef, useState } from 'react';
import { useArcaStore, type AgenticClient } from '@arcaai/vox';
import { buildHarnessAssuranceStreamUrl, fetchStreamTicket } from '../api/clinical-workspace.api';
import { harnessAssuranceScope } from '../constants';
import { reduceHarnessAssuranceMessage, type HarnessAssuranceClaim } from '../lib/harness-assurance';

export type HarnessAssuranceStreamStatus = 'idle' | 'connecting' | 'open' | 'closed' | 'error';

export interface UseHarnessAssuranceResult {
  /** Latest full per-claim verdict list (empty until the first event arrives). */
  claims: HarnessAssuranceClaim[];
  /** Total verifiable claims in the run (when the harness reported it). */
  total: number | undefined;
  /** Aggregate gate verdict (PASS | REGEN | FLAG) — populated on the terminal event. */
  gateDecision: string | null;
  /** True when the safety sensor FLAGged the note (terminal event). */
  safetyFlag: boolean;
  /** True when assurance ran with reduced coverage (a sensor degraded). */
  reducedAssurance: boolean;
  /** Q2b — an adverse verdict landed AFTER an early sign (amendment alert). */
  postSignAlert: boolean;
  /** True once the terminal assurance event arrived (verdict settled). */
  closed: boolean;
  status: HarnessAssuranceStreamStatus;
  error: string | null;
}

export interface UseHarnessAssuranceOptions {
  consultationId: string | null;
  /** Connect only while a draft is awaiting its assurance verdict. */
  enabled: boolean;
}

/** Bounded ticket-re-minting reconnect (mirror of progress): 3 attempts, 1s→2s→4s backoff. */
const MAX_RECONNECT_ATTEMPTS = 3;
const RECONNECT_BASE_DELAY_MS = 1_000;
const RECONNECT_MAX_DELAY_MS = 5_000;

export function useHarnessAssurance({ consultationId, enabled }: UseHarnessAssuranceOptions): UseHarnessAssuranceResult {
  const apiClient = useArcaStore((s: { apiClient: AgenticClient | null }) => s.apiClient);

  const [claims, setClaims] = useState<HarnessAssuranceClaim[]>([]);
  const [total, setTotal] = useState<number | undefined>(undefined);
  const [gateDecision, setGateDecision] = useState<string | null>(null);
  const [safetyFlag, setSafetyFlag] = useState(false);
  const [reducedAssurance, setReducedAssurance] = useState(false);
  const [postSignAlert, setPostSignAlert] = useState(false);
  const [closed, setClosed] = useState(false);
  const [status, setStatus] = useState<HarnessAssuranceStreamStatus>('idle');
  const [error, setError] = useState<string | null>(null);

  // Reset the accumulated state whenever the consultation changes.
  const lastConsultationRef = useRef<string | null>(null);
  useEffect(() => {
    if (consultationId !== lastConsultationRef.current) {
      lastConsultationRef.current = consultationId;
      setClaims([]);
      setTotal(undefined);
      setGateDecision(null);
      setSafetyFlag(false);
      setReducedAssurance(false);
      setPostSignAlert(false);
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
    let terminal = false;
    let consecutiveFailures = 0;

    setStatus('connecting');
    setError(null);

    const scheduleReconnect = (err?: unknown) => {
      source?.close();
      source = null;
      consecutiveFailures += 1;
      if (consecutiveFailures > MAX_RECONNECT_ATTEMPTS) {
        setStatus('error');
        setError(err instanceof Error ? err.message : 'Harness assurance stream disconnected');
        return;
      }
      const delay = Math.min(RECONNECT_BASE_DELAY_MS * 2 ** (consecutiveFailures - 1), RECONNECT_MAX_DELAY_MS);
      setStatus('connecting');
      retryTimer = setTimeout(() => {
        if (!cancelled) void connect();
      }, delay);
    };

    const applyEvent = (event: ReturnType<typeof reduceHarnessAssuranceMessage>): void => {
      if (event.kind !== 'event' && event.kind !== 'closed') return;
      setClaims(event.event.claims);
      setTotal(event.event.total);
      setGateDecision(event.event.gateDecision);
      setSafetyFlag(event.event.safetyFlag);
      setReducedAssurance(event.event.reducedAssurance);
      setPostSignAlert(event.event.postSignAlert);
    };

    const connect = async () => {
      // Until a live (non-closed) event is seen on THIS connection, a closed
      // event is the replayed snapshot of an earlier run, not our terminal.
      let sawLiveEvent = false;
      try {
        const { ticket } = await fetchStreamTicket(apiClient, harnessAssuranceScope(consultationId));
        if (cancelled) return;

        const url = buildHarnessAssuranceStreamUrl(apiClient, consultationId, ticket);
        source = new EventSource(url);

        source.onopen = () => {
          if (!cancelled) setStatus('open');
        };

        source.onmessage = (e: MessageEvent) => {
          if (cancelled || terminal) return;
          consecutiveFailures = 0; // data flowing → the connection is healthy
          const message = reduceHarnessAssuranceMessage(typeof e.data === 'string' ? e.data : '');
          if (message.kind === 'event') {
            sawLiveEvent = true;
            applyEvent(message);
            setClosed(false);
            setStatus('open');
            setError(null);
          } else if (message.kind === 'closed') {
            applyEvent(message);
            setClosed(true);
            setStatus('closed');
            if (sawLiveEvent) {
              terminal = true;
              source?.close();
            }
            // Otherwise keep listening — replayed snapshot; a new run may start.
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

  return { claims, total, gateDecision, safetyFlag, reducedAssurance, postSignAlert, closed, status, error };
}
