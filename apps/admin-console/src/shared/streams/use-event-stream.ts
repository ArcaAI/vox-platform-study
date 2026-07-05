'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { publicEnv } from '@/config/public-env';

/** Wire shape of POST /api/auth/stream-ticket (gateway IssueStreamTicketResponse). */
interface StreamTicketResponse {
    ticket: string;
    expiresAt: number;
    scope: string;
}

export type StreamStatus = 'idle' | 'connecting' | 'open' | 'error' | 'closed';

export interface UseEventStreamOptions {
    /**
     * Gateway SSE path relative to /api/v1 (no leading slash), e.g.
     * `admin/dna-writing-styles/jobs/123/stream`. null/undefined disables.
     */
    path: string | null | undefined;
    /**
     * Ticket scope `<namespace>:<resourceId>` — must match the route's
     * @StreamScope declaration for the gateway to accept the ticket.
     */
    scope: string | null | undefined;
    /** Named SSE events to subscribe to besides the default `message`. */
    eventNames?: readonly string[];
    /** Every received event: (type, raw data string). Latest closure wins. */
    onEvent?: (type: string, data: string) => void;
    /**
     * Reconnect attempts after a drop. Each reconnect mints a FRESH ticket —
     * tickets are single-use, so the native EventSource retry (which replays
     * the consumed ticket URL) is always suppressed. Default 3.
     */
    maxRetries?: number;
    enabled?: boolean;
}

export interface EventStreamHandle {
    status: StreamStatus;
    /** Message from the last mint/stream failure (null while healthy). */
    error: string | null;
    /**
     * Terminal stop (e.g. the consumer saw the stream's final event). No
     * further retries until reopen().
     */
    close: () => void;
    /** Restarts a closed/errored stream with a fresh ticket + retry budget. */
    reopen: () => void;
}

/** SSE URL the browser connects to DIRECTLY (streams never traverse the BFF proxy). */
function streamUrl(path: string, ticket: string): string {
    return `${publicEnv.apiHost}/api/v1/${path}?ticket=${encodeURIComponent(ticket)}`;
}

/**
 * Ticket-authenticated EventSource (rule 13: JWTs never appear in URLs —
 * streams authenticate with single-use ~30s tickets minted through the BFF).
 *
 * Lifecycle: mint ticket -> open EventSource -> forward events. On error the
 * source is closed immediately and, within the retry budget, a fresh ticket
 * is minted with linear backoff. Teardown (unmount or identity change) aborts
 * any in-flight mint, cancels pending retries and closes the source, so a
 * remount can never inherit a stale connection.
 */
export function useEventStream({ path, scope, eventNames = [], onEvent, maxRetries = 3, enabled = true }: UseEventStreamOptions): EventStreamHandle {
    const [status, setStatus] = useState<StreamStatus>('idle');
    const [error, setError] = useState<string | null>(null);
    // Bumping the epoch re-runs the connect effect (reopen after close/error).
    const [epoch, setEpoch] = useState(0);

    const onEventRef = useRef(onEvent);
    useEffect(() => {
        onEventRef.current = onEvent;
    }, [onEvent]);

    // Joined for effect-dep stability; names never contain commas in practice.
    const eventNamesKey = eventNames.join(',');

    const closedRef = useRef(false);
    const sourceRef = useRef<EventSource | null>(null);
    const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    const close = useCallback(() => {
        closedRef.current = true;
        if (retryTimerRef.current) {
            clearTimeout(retryTimerRef.current);
            retryTimerRef.current = null;
        }
        sourceRef.current?.close();
        sourceRef.current = null;
        setStatus('closed');
    }, []);

    const reopen = useCallback(() => {
        closedRef.current = false;
        setError(null);
        setEpoch((previous) => previous + 1);
    }, []);

    const active = enabled && !!path && !!scope;

    useEffect(() => {
        if (!active) return;

        closedRef.current = false;
        const abort = new AbortController();
        const names = eventNamesKey ? eventNamesKey.split(',') : [];
        let attempt = 0;

        async function connect(): Promise<void> {
            setStatus('connecting');
            let ticket: string;
            try {
                const response = await fetch('/api/auth/stream-ticket', {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({ scope }),
                    signal: abort.signal,
                });
                if (!response.ok) {
                    throw new Error(`Stream ticket request failed (${response.status})`);
                }
                ticket = ((await response.json()) as StreamTicketResponse).ticket;
            } catch (mintError) {
                if (abort.signal.aborted) return;
                fail(mintError instanceof Error ? mintError.message : 'Failed to mint a stream ticket');
                return;
            }
            if (abort.signal.aborted || closedRef.current) return;

            const source = new EventSource(streamUrl(path as string, ticket));
            sourceRef.current = source;

            source.onopen = () => {
                attempt = 0;
                setError(null);
                setStatus('open');
            };
            const forward = (type: string) => (event: MessageEvent) => {
                onEventRef.current?.(type, typeof event.data === 'string' ? event.data : JSON.stringify(event.data));
            };
            source.onmessage = forward('message');
            for (const name of names) {
                source.addEventListener(name, forward(name) as EventListener);
            }
            source.onerror = () => {
                // A consumed single-use ticket must never be replayed: kill the
                // native retry loop and reconnect (fresh ticket) ourselves.
                source.close();
                if (sourceRef.current === source) sourceRef.current = null;
                if (abort.signal.aborted || closedRef.current) return;
                fail('Stream connection lost');
            };
        }

        function fail(message: string): void {
            if (attempt < maxRetries) {
                attempt += 1;
                setStatus('connecting');
                retryTimerRef.current = setTimeout(() => {
                    retryTimerRef.current = null;
                    void connect();
                }, attempt * 1_000);
                return;
            }
            setError(message);
            setStatus('error');
        }

        void connect();

        return () => {
            abort.abort();
            if (retryTimerRef.current) {
                clearTimeout(retryTimerRef.current);
                retryTimerRef.current = null;
            }
            sourceRef.current?.close();
            sourceRef.current = null;
        };
    }, [active, path, scope, maxRetries, epoch, eventNamesKey]);

    return { status: active ? status : 'idle', error, close, reopen };
}
