/**
 * @arcaai/vox — `useWorkflowRun`.
 *
 * The browser half of the workflow invocation plane: list what can run, start a
 * run, watch it live, cancel it. The server half is
 * `@arcaai/vox-node`'s `hope.workflows` / `hope.consultations.workflows`; both
 * speak the same gateway routes, so a team can prototype in the UI and move the
 * same call server-side without relearning the contract.
 *
 * ```tsx
 * const { workflows, start, events, status, isRunning } = useWorkflowRun();
 *
 * await start(workflows[0].slug, { note }); // unbound plane
 * await start(slug, input, { consultationId }); // clinical plane
 * ```
 *
 * ## What this hook does that a `fetch` would not
 *
 * 1. **Streams with RESUME.** It opens the run's SSE stream through `SSEClient`
 *    with `resume: true`, so a reconnect replays `lastEventId` and the frames in
 *    the gap are not lost. Getting that right by hand means knowing that the
 *    snapshot frame deliberately carries no cursor.
 * 2. **Refuses reserved run-identity keys before the request leaves.** The
 *    consultation is named by the URL; restating it in `input` is a 400. See
 *    {@link RESERVED_RUN_IDENTITY_KEYS}.
 * 3. **Distinguishes "no answer" from "an empty answer."** `workflows: null`
 *    means the read has not resolved (or failed); `[]` means the tenant has
 *    published none. Collapsing them tells a user they have no workflows because
 *    a request blipped — the same rule `useSelectableConsultationWorkflows`
 *    follows.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useApiOperation } from './useApiOperation';
import { WORKFLOW_ENDPOINTS, workflowRunStreamScope } from '../core/constants';
import { SSEClient, type SSEApiClient } from '../core/SSEClient';
import type {
  WorkflowRunEvent,
  WorkflowRunEventPayload,
  WorkflowRunHandle,
  WorkflowRunStatus,
  WorkflowSchemaDescription,
  WorkflowSummary,
} from '../types/workflowRun';
import { isTerminalRunStatus } from '../types/workflowRun';

/**
 * The keys the interpreter reads as RUN IDENTITY, which the server stamps
 * itself and a caller may therefore never supply.
 *
 * Verbatim mirror of `RESERVED_RUN_IDENTITY_KEYS` in
 * `packages/applications/src/services/workflow-exposure/exposure-palette-policy.ts`.
 * The gateway REFUSES these with a 400 rather than dropping them, because a
 * silent drop would let a caller send `{ consultationId }`, receive a 202, and
 * believe it had addressed that consultation while the run acted on something
 * else. Refusing here as well turns that into a synchronous error at the call
 * site instead of a round trip.
 */
export const RESERVED_RUN_IDENTITY_KEYS: readonly string[] = Object.freeze(['consultationId', 'externalPatientId', 'userId', 'jobId', 'sessionId']);

/** The reserved keys present in `input`, in declaration order — empty when clean. */
export function reservedRunIdentityKeysIn(input: Record<string, unknown> | undefined | null): string[] {
  if (input === null || input === undefined || typeof input !== 'object') return [];
  return RESERVED_RUN_IDENTITY_KEYS.filter((key) => Object.prototype.hasOwnProperty.call(input, key));
}

/** Thrown by {@link UseWorkflowRunReturn.start} when `input` carries a server-stamped identity key. */
export class ReservedRunIdentityError extends Error {
  readonly keys: readonly string[];

  constructor(keys: readonly string[]) {
    super(
      `Workflow input may not contain the reserved run-identity ${keys.length === 1 ? 'key' : 'keys'} ${keys.map((k) => `\`${k}\``).join(', ')}. ` +
        'The server stamps run identity itself — pass `{ consultationId }` as a START OPTION (it becomes part of the URL), never inside `input`.',
    );
    this.name = 'ReservedRunIdentityError';
    this.keys = keys;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Options for {@link UseWorkflowRunReturn.start}. */
export interface StartWorkflowRunOptions {
  /**
   * Run against THIS consultation — the clinical plane
   * (`POST /consultations/:consultationId/workflows/:slug/runs`).
   *
   * It becomes part of the URL and is re-resolved server-side against your
   * tenant. Absent, the run goes to the unbound plane and can write no clinical
   * row at all.
   */
  consultationId?: string;
  /**
   * Sent as `Idempotency-Key`. A retry with the same value JOINS the run
   * already in flight rather than starting — and billing — a second; the
   * returned handle then reports `status: 'already_running'`.
   *
   * Use a value stable for the LOGICAL attempt (a form submission id, a record
   * id), never a fresh UUID per click, which defeats the mechanism.
   */
  idempotencyKey?: string;
  /** Open the event stream as soon as the run starts. Default `true`. */
  stream?: boolean;
}

/** Options for {@link useWorkflowRun}. */
export interface UseWorkflowRunOptions {
  // TODO(TASK-864): workflow socket protocol — a `transport: 'sse' | 'socket'` option lands here
  // when the run stream gains a socket lane; SSE with `Last-Event-ID` resume stays the default.
  /**
   * Load the catalogue on mount. Pass a `consultationId` to load the
   * CONSULTATION-BOUND catalogue, which is wider — it also lists
   * `consultation`-palette definitions, invokable on that plane and nowhere
   * else. Omit to skip the auto-load entirely.
   */
  consultationId?: string;
  /** Skip the on-mount catalogue read (call `refreshWorkflows()` yourself). Default `false`. */
  skipInitialLoad?: boolean;
  /** How many frames to keep in {@link UseWorkflowRunReturn.events}. Default `500`. */
  maxEvents?: number;
}

export interface UseWorkflowRunReturn {
  /** The catalogue, or `null` when the read has not resolved — or failed. NEVER conflate with `[]`. */
  workflows: WorkflowSummary[] | null;
  /** Re-read the catalogue. Resolves to `null` rather than rejecting. */
  refreshWorkflows: (consultationId?: string) => Promise<WorkflowSummary[] | null>;
  /**
   * One definition's generated contract (TASK-890) — input/output component schemas, trigger
   * kinds, protocols, admitted delivery lanes, AsyncAPI fragment.
   *
   * {@link workflows} already carries `inputSchema` / `outputSchema` / `protocols` /
   * `triggerKinds` per entry, so reach for this when you want the OpenAPI/AsyncAPI
   * PROJECTIONS — a portal page, a generated client — not to decide what to send. Resolves to
   * `null` rather than rejecting: a contract panel must not break the screen it sits on.
   */
  schema: (slug: string) => Promise<WorkflowSchemaDescription | null>;
  /** The handle of the most recently started run. */
  handle: WorkflowRunHandle | null;
  /** Latest known status of that run, updated live from the stream. */
  status: WorkflowRunStatus | null;
  /** Every frame received on the current run's stream, newest last, capped at `maxEvents`. */
  events: WorkflowRunEvent[];
  /** `true` between `start()` and the run reaching a terminal status. */
  isRunning: boolean;
  /** `true` while a catalogue read or a start request is in flight. */
  isLoading: boolean;
  error: Error | null;
  /**
   * Start a run. Throws {@link ReservedRunIdentityError} synchronously — before
   * any request — when `input` carries a server-stamped identity key.
   */
  start: (slug: string, input: Record<string, unknown>, options?: StartWorkflowRunOptions) => Promise<WorkflowRunHandle>;
  /** Watch an ALREADY-STARTED run (e.g. one whose id was persisted across a reload). Returns a stop function. */
  watch: (slug: string, runId: string, lastEventId?: string) => () => void;
  /** Read the run's status once, authoritatively. */
  fetchStatus: (slug: string, runId: string) => Promise<WorkflowRunStatus>;
  /** Send the cancel signal. Returns once SENT — cancellation may not be complete. */
  cancel: (slug: string, runId: string) => Promise<void>;
  /** Close the stream without cancelling the run — a durable run outlives your view of it. */
  stopWatching: () => void;
  /**
   * The opaque resume cursor last seen, or `null`. Persist it and pass it back
   * to `watch()` to resume across a page reload without losing frames.
   */
  lastEventId: string | null;
}

const DEFAULT_MAX_EVENTS = 500;

/** Every stream frame type this hook subscribes to — the gateway's full vocabulary. */
const STREAM_EVENT_TYPES: readonly string[] = Object.freeze([
  'workflow.run.progress',
  'workflow.run.completed',
  'workflow.node.started',
  'workflow.node.completed',
  'workflow.node.failed',
  'workflow.loop.iteration',
  'workflow.guardrail.verdict',
  'workflow.token.delta',
]);

export function useWorkflowRun(options: UseWorkflowRunOptions = {}): UseWorkflowRunReturn {
  const { consultationId, skipInitialLoad = false, maxEvents = DEFAULT_MAX_EVENTS } = options;
  const { execute, isLoading, error, apiClient, logger } = useApiOperation('useWorkflowRun');

  const [workflows, setWorkflows] = useState<WorkflowSummary[] | null>(null);
  const [handle, setHandle] = useState<WorkflowRunHandle | null>(null);
  const [status, setStatus] = useState<WorkflowRunStatus | null>(null);
  const [events, setEvents] = useState<WorkflowRunEvent[]>([]);
  const [isRunning, setIsRunning] = useState(false);
  const [lastEventId, setLastEventId] = useState<string | null>(null);

  const sseRef = useRef<SSEClient | null>(null);

  const stopWatching = useCallback(() => {
    // Disconnect ONLY. Never a cancel: the run is a durable execution, and
    // closing a view of it must not end it — the same guarantee the gateway
    // makes by registering no `close` handler that signals the run.
    sseRef.current?.disconnect();
    sseRef.current = null;
  }, []);

  // Unmount must not leave an EventSource (and its ticket refresh loop) open.
  useEffect(() => stopWatching, [stopWatching]);

  const refreshWorkflows = useCallback(
    async (scopedConsultationId?: string): Promise<WorkflowSummary[] | null> => {
      const path = scopedConsultationId === undefined ? WORKFLOW_ENDPOINTS.LIST : WORKFLOW_ENDPOINTS.CONSULTATION_LIST(scopedConsultationId);
      try {
        return await execute<WorkflowSummary[] | null>('listWorkflows', async (client) => {
          const response = await client.get<{ data?: WorkflowSummary[] }>(path);
          // A payload without a `data` array is "we could not ask", not "the
          // tenant has none" — a false empty state is worse than no state.
          const data = Array.isArray(response?.data) ? response.data : null;
          setWorkflows(data);
          return data;
        });
      } catch {
        // Fail-open: `execute` has already recorded the reason on `error`. A
        // workflow picker must not break the screen it sits on.
        setWorkflows(null);
        return null;
      }
    },
    [execute],
  );

  useEffect(() => {
    if (skipInitialLoad) return;
    void refreshWorkflows(consultationId);
  }, [refreshWorkflows, consultationId, skipInitialLoad]);

  const schema = useCallback(
    async (slug: string): Promise<WorkflowSchemaDescription | null> => {
      try {
        return await execute<WorkflowSchemaDescription | null>('getWorkflowSchema', async (client) => {
          const description = await client.get<WorkflowSchemaDescription>(WORKFLOW_ENDPOINTS.SCHEMA(slug));
          return description !== null && typeof description === 'object' ? description : null;
        });
      } catch {
        // Fail-open: `execute` has recorded the reason on `error`.
        return null;
      }
    },
    [execute],
  );

  const fetchStatus = useCallback(
    async (slug: string, runId: string): Promise<WorkflowRunStatus> =>
      execute<WorkflowRunStatus>('getWorkflowRun', async (client) => {
        const result = await client.get<WorkflowRunStatus>(WORKFLOW_ENDPOINTS.RUN(slug, runId));
        setStatus(result);
        if (isTerminalRunStatus(result.status)) setIsRunning(false);
        return result;
      }),
    [execute],
  );

  const watch = useCallback(
    (slug: string, runId: string, startCursor?: string): (() => void) => {
      if (!apiClient) throw new Error('SDK not initialized');
      stopWatching();

      // The scope carries the RUN id: the gateway mints a ticket for one run
      // (`@StreamScope({ namespace: 'workflow_run', param: 'runId' })`), and
      // `SSEClient` re-mints on every connect — including each resume.
      const sse = new SSEClient(workflowRunStreamScope(runId), apiClient as unknown as SSEApiClient, logger);
      sseRef.current = sse;

      for (const type of STREAM_EVENT_TYPES) {
        sse.onEvent(type, (data: string) => {
          let envelope: WorkflowRunEvent;
          try {
            envelope = JSON.parse(data) as WorkflowRunEvent;
          } catch {
            // One unreadable frame must not tear down a stream whose remaining
            // frames are fine — and the run is unaffected either way.
            return;
          }
          const cursor = sse.getLastEventId();
          setLastEventId(cursor);
          setEvents((prev) => {
            const next = [...prev, { ...envelope, ...(cursor === null ? {} : { resumeToken: cursor }) }];
            return next.length > maxEvents ? next.slice(next.length - maxEvents) : next;
          });

          const payload = envelope.payload as WorkflowRunEventPayload | undefined;
          if (payload?.status !== undefined && typeof payload.status === 'string') {
            setStatus({
              runId: payload.runId ?? runId,
              slug: payload.slug ?? slug,
              workflowVersionNumber: payload.workflowVersionNumber ?? 0,
              status: payload.status,
              stages: payload.stages ?? [],
              startedAt: payload.startedAt ?? null,
              endedAt: payload.endedAt ?? null,
              resultRef: (payload.resultRef as Record<string, unknown> | undefined) ?? null,
            });
          }
          if (envelope.type === 'workflow.run.completed' || (typeof payload?.status === 'string' && isTerminalRunStatus(payload.status))) {
            setIsRunning(false);
            stopWatching();
          }
        });
      }

      // `resume: true` is the whole point: this client reconnects by building a
      // NEW EventSource (each connect mints a fresh single-use ticket), which
      // discards the browser's own lastEventId. Without this, every reconnect
      // silently drops the frames in the gap.
      // Absolute URL: SSE connects DIRECTLY to the gateway (EventSource cannot
      // go through the client's own fetch pipeline), so the base must be joined
      // here — the same construction `useConsultationJob` uses.
      sse.connect(`${apiClient.getBaseUrl()}${WORKFLOW_ENDPOINTS.RUN_STREAM(slug, runId)}`, {
        resume: true,
        lastEventId: startCursor,
        autoReconnect: true,
      });

      return stopWatching;
    },
    [apiClient, logger, maxEvents, stopWatching],
  );

  const start = useCallback(
    async (slug: string, input: Record<string, unknown>, startOptions: StartWorkflowRunOptions = {}): Promise<WorkflowRunHandle> => {
      const offending = reservedRunIdentityKeysIn(input);
      if (offending.length > 0) throw new ReservedRunIdentityError(offending);

      const path =
        startOptions.consultationId === undefined
          ? WORKFLOW_ENDPOINTS.RUNS(slug)
          : WORKFLOW_ENDPOINTS.CONSULTATION_RUNS(startOptions.consultationId, slug);

      const started = await execute<WorkflowRunHandle>('startWorkflowRun', async (client) => {
        const body = { input };
        return startOptions.idempotencyKey === undefined
          ? client.post<WorkflowRunHandle>(path, body)
          : client.postWithHeaders<WorkflowRunHandle>(path, body, { 'Idempotency-Key': startOptions.idempotencyKey });
        // NOTE: no `?mode=` — the browser always starts async and then WATCHES.
        // `mode=blocking` would hold a fetch open against a ~60s gateway ceiling
        // from a UI thread, and `mode=stream` would put the run's whole event
        // stream on a POST this client cannot resume (a resume must be a GET on
        // the run; re-POSTing would start a second run).
      });

      setHandle(started);
      setEvents([]);
      setLastEventId(null);
      setStatus(null);
      setIsRunning(true);

      if (startOptions.stream !== false) watch(slug, started.runId);
      return started;
    },
    [execute, watch],
  );

  const cancel = useCallback(
    async (slug: string, runId: string): Promise<void> => {
      await execute<unknown>('cancelWorkflowRun', (client) => client.post(WORKFLOW_ENDPOINTS.RUN_CANCEL(slug, runId)));
      // Deliberately NOT setIsRunning(false): the signal was sent, the run has
      // not necessarily stopped. The stream's terminal frame is what says so.
    },
    [execute],
  );

  return {
    workflows,
    refreshWorkflows,
    schema,
    handle,
    status,
    events,
    isRunning,
    isLoading,
    error,
    start,
    watch,
    fetchStatus,
    cancel,
    stopWatching,
    lastEventId,
  };
}
