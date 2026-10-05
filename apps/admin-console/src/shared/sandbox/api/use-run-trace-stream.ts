'use client';

/**
 * The admin trace of one run — `GET admin/workflow-runs/:runId/trace/stream` (TASK-1038 B3a),
 * protocol v2, read by the Studio Test tab (TASK-1036 §10.2).
 *
 * Why not `useEventStream` (`@/shared/streams`): that hook owns ticket + reconnect for a stream
 * that RESTARTS, and builds its URL as `<path>?ticket=` with no room for `?protocol=2&after=<seq>`.
 * This stream RESUMES: every reconnect mints a FRESH single-use ticket (rule 13 — a JWT never
 * travels in a URL; a consumed ticket is never replayed, so the native EventSource retry is always
 * suppressed) and asks for `after=<the last seq this client saw>` (protocol-v2.md §6.2). The
 * cursor follows the contract's client rule exactly (`advanceRunCursor`): a jump in `seq` is
 * never loss, replays are dropped, `ping` only moves the cursor, `run.resync` is delivered and
 * the fold replaces its state with the snapshot.
 *
 * The connection closes itself on the run's terminal event (or a terminal resync snapshot).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { publicEnv } from '@/config/public-env';
import { RUN_TRACE_EVENT_TYPES, advanceRunCursor, isTerminalRunEvent, parseRunEventFrame, type RunEvent } from './run-protocol';

export type RunTraceStreamStatus = 'idle' | 'connecting' | 'open' | 'error' | 'closed';

export interface RunTraceStream {
  status: RunTraceStreamStatus;
  /** Every delivered event of the run, in delivery order (a `run.resync` included). */
  events: RunEvent[];
  /** The last `seq` seen — what the next reconnect resumes after. */
  cursor: number;
  error: string | null;
  /** Re-open a stream that gave up (fresh ticket, same cursor). */
  reconnect: () => void;
}

const MAX_RETRIES = 5;

export function runTraceStreamPath(runId: string): string {
  return `admin/workflow-runs/${encodeURIComponent(runId)}/trace/stream`;
}

export function runTraceStreamScope(runId: string): string {
  // TASK-1038 E2: the admin trace has its own JWT-only ticket namespace (never `workflow_run`).
  return `workflow_run_trace:${runId}`;
}

function traceUrl(runId: string, after: number, ticket: string): string {
  const search = new URLSearchParams({ protocol: '2', after: String(after), ticket });
  return `${publicEnv.apiHost}/api/v1/${runTraceStreamPath(runId)}?${search.toString()}`;
}

interface TraceState {
  runId: string | null;
  events: RunEvent[];
  cursor: number;
}

export function useRunTraceStream(runId: string | null): RunTraceStream {
  const [trace, setTrace] = useState<TraceState>({ runId, events: [], cursor: 0 });
  const [status, setStatus] = useState<RunTraceStreamStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  const [epoch, setEpoch] = useState(0);
  // A new run starts over — adjusted during render (React's "state derived from a prop change").
  if (trace.runId !== runId) setTrace({ runId, events: [], cursor: 0 });

  const cursorRef = useRef(0);
  const terminalRef = useRef(false);

  const reconnect = useCallback(() => {
    setError(null);
    setEpoch((previous) => previous + 1);
  }, []);

  // A run id change resets the resume point; a reconnect (epoch) keeps it. Declared BEFORE the
  // connect effect so it runs first in the same commit.
  useEffect(() => {
    cursorRef.current = 0;
    terminalRef.current = false;
  }, [runId]);

  useEffect(() => {
    if (!runId || terminalRef.current) return;
    const abort = new AbortController();
    let source: EventSource | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;

    const onFrame = (raw: string): void => {
      const event = parseRunEventFrame(raw);
      if (!event || event.runId !== runId) return;
      // Any delivered frame forgives earlier failures (a connection that delivers is healthy).
      attempt = 0;
      const step = advanceRunCursor(cursorRef.current, event);
      cursorRef.current = step.cursor;
      setTrace((previous) =>
        previous.runId !== runId ? previous : { runId, cursor: step.cursor, events: step.deliver ? [...previous.events, event] : previous.events },
      );
      if (step.deliver && isTerminalRunEvent(event)) {
        terminalRef.current = true;
        source?.close();
        source = null;
        setStatus('closed');
      }
    };

    const fail = (message: string): void => {
      if (abort.signal.aborted || terminalRef.current) return;
      if (attempt < MAX_RETRIES) {
        attempt += 1;
        setStatus('connecting');
        retryTimer = setTimeout(() => {
          retryTimer = null;
          void connect();
        }, attempt * 1_000);
        return;
      }
      setError(message);
      setStatus('error');
    };

    async function connect(): Promise<void> {
      setStatus('connecting');
      let ticket: string;
      try {
        const response = await fetch('/api/auth/stream-ticket', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ scope: runTraceStreamScope(runId as string) }),
          signal: abort.signal,
        });
        if (!response.ok) throw new Error(`Stream ticket request failed (${response.status})`);
        ticket = ((await response.json()) as { ticket: string }).ticket;
      } catch (mintError) {
        if (abort.signal.aborted) return;
        fail(mintError instanceof Error ? mintError.message : 'Failed to mint a stream ticket');
        return;
      }
      if (abort.signal.aborted || terminalRef.current) return;

      const next = new EventSource(traceUrl(runId as string, cursorRef.current, ticket));
      source = next;
      next.onopen = () => {
        setError(null);
        setStatus('open');
      };
      const forward = (event: MessageEvent) => onFrame(typeof event.data === 'string' ? event.data : JSON.stringify(event.data));
      next.onmessage = forward;
      for (const type of RUN_TRACE_EVENT_TYPES) next.addEventListener(type, forward as EventListener);
      next.onerror = () => {
        // Never let the browser replay the consumed ticket: close and reconnect ourselves.
        next.close();
        if (source === next) source = null;
        fail('The trace connection was lost.');
      };
    }

    void connect();
    return () => {
      abort.abort();
      if (retryTimer) clearTimeout(retryTimer);
      source?.close();
      source = null;
    };
  }, [runId, epoch]);

  const current = trace.runId === runId ? trace : { runId, events: [], cursor: 0 };
  return { status: runId ? status : 'idle', events: current.events, cursor: current.cursor, error, reconnect };
}
