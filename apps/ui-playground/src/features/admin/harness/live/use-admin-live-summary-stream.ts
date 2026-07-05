/**
 * useAdminLiveSummaryStream (TASK-341 B5).
 *
 * The admin-plane sibling of the clinical-workspace `useLiveSummaryStream`: it
 * lets a tenant-admin OBSERVE a consultation's live SOAP in the admin console.
 * It mints a one-shot ticket via the admin client (admin bearer + `X-Tenant-Id`)
 * rather than the impersonated-user SDK client, then opens the same
 * `GET /consultations/:id/live-summary/stream` SSE relay with `?ticket=`.
 *
 * The raw `message` payloads are classified by the SAME pure
 * `reduceLiveSummaryMessage` reducer the doctor cockpit uses (summary/closed
 * update state; heartbeats and parse failures are ignored), and it yields the
 * `{ event, status, error, lastUpdatedAt }` shape consumed by `LiveSummaryPanel`.
 */
import { useEffect, useRef, useState } from 'react';
import { liveSummaryScope } from '@/features/clinical-workspace/constants';
import { reduceLiveSummaryMessage } from '@/features/clinical-workspace/lib/live-summary';
import type { LiveSummaryEvent } from '@/features/clinical-workspace/types';
import { buildLiveSummaryStreamUrl, fetchStreamTicket } from '../api/live';

export type AdminLiveSummaryStreamStatus = 'idle' | 'connecting' | 'open' | 'closed' | 'error';

export interface UseAdminLiveSummaryStreamResult {
  event: LiveSummaryEvent | null;
  status: AdminLiveSummaryStreamStatus;
  error: string | null;
  lastUpdatedAt: string | null;
}

export interface UseAdminLiveSummaryStreamOptions {
  consultationId: string | null;
  /** Connect only while a session is selected and observable. */
  enabled: boolean;
  /** Selected tenant for a global-admin observer; propagated into the ticket mint. */
  tenantId?: string;
}

export function useAdminLiveSummaryStream({ consultationId, enabled, tenantId }: UseAdminLiveSummaryStreamOptions): UseAdminLiveSummaryStreamResult {
  const [event, setEvent] = useState<LiveSummaryEvent | null>(null);
  const [status, setStatus] = useState<AdminLiveSummaryStreamStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<string | null>(null);

  // Reset the accumulated summary whenever the observed consultation changes.
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
    if (!enabled || !consultationId) {
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
        const { ticket } = await fetchStreamTicket(liveSummaryScope(consultationId), tenantId);
        if (cancelled) return;

        source = new EventSource(buildLiveSummaryStreamUrl(consultationId, ticket));

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
  }, [consultationId, enabled, tenantId]);

  return { event, status, error, lastUpdatedAt };
}
