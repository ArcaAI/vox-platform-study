/**
 * @arcaai/vox — `useRun`: one hook for one run, workflow or agent (TASK-1039).
 *
 * ```tsx
 * const run = useRun<{ note: string }, { text: string }>({ workflow: 'note-writer' });
 *
 * await run.start({ note }, { idempotencyKey: `note-${visitId}` });
 * run.text;     // grows as the model writes
 * run.status;   // 'RUNNING' → 'COMPLETED' | 'FAILED' | 'CANCELED' | 'TIMED_OUT'
 * run.result;   // the delivered value, once COMPLETED (a large one is fetched and hash-checked)
 * await run.cancel();
 * ```
 *
 * Pass `runId` (and, if you persisted it, `after`) to ATTACH to a run instead of starting one —
 * on mount the hook follows it from that cursor, so a reload, a route change or a second tab
 * picks a run back up:
 *
 * ```tsx
 * const run = useRun({ workflow: 'note-writer', runId: savedRunId, after: savedSeq });
 * // persist `run.runId` and `run.lastSeq` as they change
 * ```
 *
 * ## What it does so you do not
 *
 * - **Speaks protocol v2 and hides it.** Frames go through the normaliser, which for one release
 *   also reads the legacy workflow frames, so the same code runs against a gateway that has not
 *   shipped v2.
 * - **Sends an `Idempotency-Key` on every start.** A retry with the same key joins the run in
 *   flight instead of starting — and billing — a second one. Pass a key stable for the LOGICAL
 *   attempt (a form submission id, a record id); the default is fresh per call.
 * - **Streams with a run-scoped ticket.** A workflow run mints a single-use ticket for ONE run
 *   (`POST …/runs/:runId/stream-ticket`) on every connect; the ticket is the credential, so this
 *   works for an API-key app that holds no JWT, and nothing but the ticket reaches the URL.
 *   An AGENT run has no ticket route yet, so it streams over `fetch`, which carries the client's
 *   own headers (the same credentials, resumable with `Last-Event-ID`).
 * - **Resumes by `seq`** on a drop and on mount, applies `run.resync`, and never infers loss from
 *   a jump in `seq` (the public plane is filtered out of one stored sequence; only the server
 *   signals loss).
 * - **Never cancels on its own.** Unmounting, or losing the connection, only ends YOUR view of a
 *   run — a run is a durable execution. `cancel()` is the only thing that stops one.
 */

import { useCallback, useEffect, useReducer, useRef } from 'react';
import { useAgenticStore } from '../store';
import { RUN_ENDPOINTS, type RunKind } from '../core/constants';
import { createEventSourceConnector, createFetchConnector, followRun, type RunConnector, type RunCursor } from '../core/run/RunStreamClient';
import { fetchRunResult } from '../core/run/fetchRunResult';
import { INITIAL_RUN_STATE, runReducer, type RunEvent, type RunState } from '../core/run/runState';
import type { RunGuardrailNotice, RunStatus } from '../core/run/run-protocol';
import { ReservedRunIdentityError, reservedRunIdentityKeysIn } from './useWorkflowRun';

/** Options for {@link useRun}. Exactly one of `workflow` / `agent` is required. */
export interface UseRunOptions {
  /** Slug of a published workflow. */
  workflow?: string;
  /** Slug of a published agent. */
  agent?: string;
  /** Attach to this existing run on mount instead of starting one. */
  runId?: string;
  /** With `runId`: resume after this `seq` (the `lastSeq` a previous mount persisted). Omit to replay the retained window from the start. */
  after?: number;
  /** How many events to keep in {@link UseRunReturn.events}. Default `500`. */
  maxEvents?: number;
  /** Reconnects a stream may spend without receiving a frame before it gives up. Default `5`. */
  maxReconnects?: number;
  /** First reconnect delay in ms (doubles per consecutive failure, capped at 5 s). Default `250`. */
  reconnectDelayMs?: number;
  /**
   * TASK-1050: called ONCE per notice id when a `guardrail.notice` event (or `run.completed.guardrailNotices`) arrives.
   * Show a warning popup and carry on; a `guardrail.blocked` notice is followed by `run.paused` (resumable) or a
   * `GUARDRAIL_BLOCKED` failure — show `notice.defaultMessage` as the termination message and offer Resume when
   * `notice.resumable`. Keep the reference stable (a ref or `useCallback`), or the latest one is read at call time.
   */
  onGuardrailNotice?: (notice: RunGuardrailNotice) => void;
}

/** Options for {@link UseRunReturn.start}. */
export interface StartRunOptions {
  /**
   * Sent as `Idempotency-Key`. The same key with the same input JOINS the run already in flight.
   * Use a value stable for the logical attempt, never a fresh UUID per click. Default: a fresh UUID.
   */
  idempotencyKey?: string;
  /** Run the WORKFLOW against this consultation (the clinical plane). Not available for agents. */
  consultationId?: string;
}

export interface UseRunReturn<TInput = Record<string, unknown>, TOutput = unknown> {
  /**
   * Start a run and follow it. Resolves when the gateway has accepted the run (not when it ends).
   * Rejects — and sets {@link error} — when the start is refused; throws
   * {@link ReservedRunIdentityError} before any request when a workflow input carries a
   * server-stamped identity key.
   */
  start: (input: TInput, options?: StartRunOptions) => Promise<{ runId: string }>;
  /** The run's text as it is written (`output.text.delta` for field `text`), grouped per node in order of first delta. */
  text: string;
  /** Every event received, newest last, capped at `maxEvents`. Narrow on `type` for the typed `data`. */
  events: RunEvent[];
  /** The delivered value once the run COMPLETED (fetched for you; a large one is hash-checked), else `null`. */
  result: TOutput | null;
  /** `null` until a run exists. */
  status: RunStatus | null;
  runId: string | null;
  /** Every guardrail notice the run raised, one per `noticeId` (TASK-1050). Empty when nothing was flagged. */
  guardrailNotices: readonly RunGuardrailNotice[];
  /** Set while the run waits at a guardrail hold (`run.paused`). The run is NOT finished: `status` stays `RUNNING`. */
  paused: { readonly noticeId: string; readonly nodeId: string; readonly reason: string } | null;
  /** The highest `seq` reached — persist it with `runId` and pass both back to resume after a reload. */
  lastSeq: number;
  /** Ask the run to stop. Idempotent; resolves once the signal is SENT (watch `status` for the end). A run already seen finished sends nothing. */
  cancel: () => Promise<void>;
  /** The start failure, a stream that could not be re-established, a failed run (`RunFailedError`), or a result that could not be read. */
  error: Error | null;
}

function newIdempotencyKey(): string {
  const cryptoRef = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  return cryptoRef?.randomUUID?.() ?? `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

/** Resolve a gateway-relative path (`/api/v1/…`) against the client's base URL, which may or may not already end in `/api/v1`. */
function resolveGatewayUrl(baseUrl: string, path: string): string {
  if (/^https?:\/\//i.test(path)) return path;
  const origin = baseUrl
    .trim()
    .replace(/\/+$/, '')
    .replace(/\/api\/v1$/i, '');
  return `${origin}${path.startsWith('/') ? '' : '/'}${path}`;
}

function appendCursor(url: string, cursor: RunCursor): string {
  const separator = url.includes('?') ? '&' : '?';
  if (cursor.after !== undefined && cursor.after > 0) return `${url}${separator}after=${cursor.after}`;
  if (cursor.legacyId !== undefined) return `${url}${separator}lastEventId=${encodeURIComponent(cursor.legacyId)}`;
  return url;
}

interface RunStreamTicket {
  ticket: string;
  sseUrl?: string;
}

export function useRun<TInput = Record<string, unknown>, TOutput = unknown>(options: UseRunOptions): UseRunReturn<TInput, TOutput> {
  const { workflow, agent, runId: attachRunId, after: attachAfter, maxEvents = 500, maxReconnects, reconnectDelayMs, onGuardrailNotice } = options;
  if ((workflow === undefined) === (agent === undefined)) {
    throw new Error('useRun needs exactly one of `workflow` or `agent` (a slug).');
  }
  const kind: RunKind = workflow !== undefined ? 'workflow' : 'agent';
  const slug = (workflow ?? agent) as string;

  const store = useAgenticStore();
  const apiClient = store.apiClient;

  const [state, dispatch] = useReducer(
    runReducer as (s: RunState<TOutput>, a: Parameters<typeof runReducer<TOutput>>[1]) => RunState<TOutput>,
    INITIAL_RUN_STATE as RunState<TOutput>,
  );

  const lifecycle = useRef<AbortController | null>(null);
  const currentRunId = useRef<string | null>(null);
  const finished = useRef(false);
  const cancelRequest = useRef<Promise<void> | null>(null);
  // The latest callback, read at call time, so a new closure each render does not re-open the stream.
  const noticeHandler = useRef(onGuardrailNotice);
  noticeHandler.current = onGuardrailNotice;
  const announcedNotices = useRef<Set<string>>(new Set());

  const stopFollowing = useCallback((): void => {
    // Disconnect ONLY. Never a cancel: the run is a durable execution.
    lifecycle.current?.abort();
    lifecycle.current = null;
  }, []);

  useEffect(() => stopFollowing, [stopFollowing]);

  const follow = useCallback(
    (runId: string, afterSeq?: number): void => {
      if (!apiClient) throw new Error('SDK not initialized');
      stopFollowing();
      const controller = new AbortController();
      lifecycle.current = controller;
      currentRunId.current = runId;
      finished.current = false;
      cancelRequest.current = null;
      announcedNotices.current = new Set();

      const connector: RunConnector =
        kind === 'workflow'
          ? createEventSourceConnector(async (cursor) => {
              // A fresh ticket for EVERY connect: it is single-use, and a reconnect is a new subscription.
              const ticket = await apiClient.post<RunStreamTicket>(RUN_ENDPOINTS.STREAM_TICKET(slug, runId));
              const base = ticket.sseUrl
                ? resolveGatewayUrl(apiClient.getBaseUrl(), ticket.sseUrl)
                : `${apiClient.getBaseUrl()}${RUN_ENDPOINTS.EVENTS('workflow', slug, runId)}?protocol=2&ticket=${encodeURIComponent(ticket.ticket)}`;
              return appendCursor(base, cursor);
            })
          : createFetchConnector(({ headers, signal }) =>
              apiClient.requestRaw(`${RUN_ENDPOINTS.EVENTS('agent', slug, runId)}?protocol=2`, { headers, signal }),
            );

      const loadResult = async (): Promise<void> => {
        try {
          const value = await fetchRunResult(apiClient, kind, slug, runId, { signal: controller.signal });
          if (!controller.signal.aborted) dispatch({ type: 'result', value: value as TOutput | null });
        } catch (error) {
          if (!controller.signal.aborted) dispatch({ type: 'error', error: error as Error });
        }
      };

      void followRun({
        runId,
        connector,
        after: afterSeq,
        signal: controller.signal,
        maxReconnects,
        reconnectDelayMs,
        onEvent: (event, info) => {
          dispatch({ type: 'event', event: event as RunEvent, reset: info.reset, protocol: info.protocol, maxEvents });
          const notices: readonly RunGuardrailNotice[] =
            event.type === 'guardrail.notice' ? [event.data] : event.type === 'run.completed' ? (event.data.guardrailNotices ?? []) : [];
          for (const notice of notices) {
            if (announcedNotices.current.has(notice.noticeId)) continue;
            announcedNotices.current.add(notice.noticeId);
            noticeHandler.current?.(notice);
          }
          const ended = event.type === 'run.completed' || event.type === 'run.failed' || event.type === 'run.cancelled';
          const resyncedToEnd = event.type === 'run.resync' && ['COMPLETED', 'FAILED', 'CANCELED', 'TIMED_OUT'].includes(event.data.snapshot.status);
          if (ended || resyncedToEnd) finished.current = true;
          if (event.type === 'run.completed' || (event.type === 'run.resync' && event.data.snapshot.status === 'COMPLETED')) void loadResult();
        },
      }).catch((error: unknown) => {
        if (!controller.signal.aborted) dispatch({ type: 'error', error: error as Error });
      });
    },
    [apiClient, kind, slug, maxEvents, maxReconnects, reconnectDelayMs, stopFollowing],
  );

  // Resume on mount: a `runId` means "this run already exists — pick it up".
  useEffect(() => {
    if (attachRunId === undefined || !apiClient) return;
    dispatch({ type: 'started', runId: attachRunId });
    follow(attachRunId, attachAfter);
    // `attachAfter` is the cursor at MOUNT; a later change of it must not re-attach.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attachRunId, apiClient]);

  const start = useCallback(
    async (input: TInput, startOptions: StartRunOptions = {}): Promise<{ runId: string }> => {
      if (!apiClient) throw new Error('SDK not initialized');
      if (kind === 'agent' && startOptions.consultationId !== undefined) {
        throw new Error('`consultationId` binds a WORKFLOW run to a consultation; an agent run cannot be bound to one.');
      }
      if (kind === 'workflow') {
        const offending = reservedRunIdentityKeysIn(input as Record<string, unknown>);
        if (offending.length > 0) throw new ReservedRunIdentityError(offending);
      }

      const headers = { 'Idempotency-Key': startOptions.idempotencyKey ?? newIdempotencyKey() };
      const path =
        kind === 'workflow' && startOptions.consultationId !== undefined
          ? `/consultations/${encodeURIComponent(startOptions.consultationId)}/workflows/${encodeURIComponent(slug)}/runs`
          : RUN_ENDPOINTS.START(kind, slug);
      // A workflow takes its input enveloped; an agent takes its invocation body flat.
      const body = kind === 'workflow' ? { input } : input;

      let handle: { runId: string };
      try {
        handle = await apiClient.postWithHeaders<{ runId: string }>(path, body, headers);
      } catch (error) {
        dispatch({ type: 'error', error: error as Error });
        throw error;
      }

      dispatch({ type: 'started', runId: handle.runId });
      follow(handle.runId);
      return { runId: handle.runId };
    },
    [apiClient, follow, kind, slug],
  );

  const cancel = useCallback((): Promise<void> => {
    const runId = currentRunId.current;
    if (!apiClient || runId === null || finished.current) return Promise.resolve();
    if (cancelRequest.current === null) {
      cancelRequest.current = apiClient.post(RUN_ENDPOINTS.CANCEL(kind, slug, runId)).then(
        () => undefined,
        (error: unknown) => {
          cancelRequest.current = null; // a failed request can be retried
          dispatch({ type: 'error', error: error as Error });
          throw error;
        },
      );
    }
    return cancelRequest.current;
  }, [apiClient, kind, slug]);

  return {
    start,
    text: state.text,
    events: state.events,
    result: state.result,
    status: state.status,
    runId: state.runId,
    guardrailNotices: state.guardrailNotices,
    paused: state.paused,
    lastSeq: state.lastSeq,
    cancel,
    error: state.error,
  };
}
