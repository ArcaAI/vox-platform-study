/**
 * `hope.workflows` — the WORKFLOW INVOCATION plane.
 *
 * The surface a developer writes against to run a tenant's published
 * workflows as products. Backed by the routes lane A shipped:
 *
 * ```
 * GET /api/v1/workflows -> list()
 * POST /api/v1/workflows/{slug}/runs -> run() / runAndWait() / runAndStream()
 * GET /api/v1/workflows/{slug}/runs/{runId} -> getRun()
 * POST /api/v1/workflows/{slug}/runs/{runId}/cancel -> cancelRun()
 * GET /api/v1/workflows/{slug}/runs/{runId}/stream -> streamRun() / waitForRun()
 * ```
 *
 * The consultation-bound half lives on {@link ConsultationWorkflowsResource}
 * (`hope.consultations.workflows`) — a separate route family, a separate
 * ability and a separate scope, because "may run a workflow" and "may run one
 * that writes into a clinical record" are different powers.
 *
 * ## Three things this resource does that a thin wrapper would not
 *
 * 1. **Refuses reserved run-identity keys before the request leaves** — see
 *    `core/run-identity.ts`. The gateway's 400 is correct; a synchronous
 *    error at the call site is teachable.
 * 2. **Resumes a dropped stream** — {@link WorkflowsResource.streamRun}
 *    tracks each frame's opaque `id` and reconnects with `Last-Event-ID`, so
 *    a disconnect costs latency, never events. Doing this by hand means
 *    knowing that the snapshot frame deliberately carries no token.
 * 3. **Refuses the wrong credential class where the gateway still does** — the
 *    CONSULTATION-bound plane records `svcScopes: []` in `route-manifest.json`,
 *    i.e. deny-by-default for a service account, so a service-account client
 *    gets a plain explanation instead of a 403 that looks like a missing grant.
 *    The UNBOUND plane no longer needs that: TASK-930 declares
 *    `svc:workflow:definition:read` / `svc:workflow:run:read` /
 *    `svc:workflow:run:write` on it, so both machine credential classes reach it.
 */

import { CredentialClassError, ReservedRunIdentityError, SocketUnavailableError } from '../core/errors';
import { generateUuidV7 } from '../core/idempotency';
import { reservedRunIdentityKeysIn } from '../core/run-identity';
import { parseSseStream } from '../core/sse';
import { readSocketFrames, resolveSocketUrl, type SocketFrame, type WorkflowRunStreamTicket } from '../core/socket';
import type { Transport } from '../core/transport';
import { encodePathSegment } from '../core/url';
import type {
  StartWorkflowRunRequest,
  WorkflowReview,
  WorkflowReviewDecision,
  WorkflowReviewDecisionResult,
  WorkflowRunCancelResult,
  WorkflowRunEvent,
  WorkflowRunEventPayload,
  WorkflowRunHandle,
  WorkflowRunStatus,
  WorkflowSchemaDescription,
  WorkflowSummary,
} from '../types/workflow';
import { isTerminalRunStatus } from '../types/workflow';

/**
 * Every gateway route this plane calls, as `(method, path)` pairs in
 * `route-manifest.json`'s own spelling.
 *
 * Exported so `workflows.contract.task850.test.ts` can assert each one EXISTS
 * in the shipped manifest with the credential class this resource assumes.
 * A list the tests derive from the implementation is the only version that
 * cannot go stale while the tests stay green.
 */
export const WORKFLOW_PLANE_ROUTES: ReadonlyArray<{ method: string; path: string }> = Object.freeze([
  { method: 'GET', path: '/api/v1/workflows' },
  { method: 'GET', path: '/api/v1/workflows/{slug}/schema' },
  { method: 'POST', path: '/api/v1/workflows/{slug}/runs' },
  { method: 'GET', path: '/api/v1/workflows/{slug}/runs/{runId}' },
  { method: 'POST', path: '/api/v1/workflows/{slug}/runs/{runId}/cancel' },
  { method: 'GET', path: '/api/v1/workflows/{slug}/runs/{runId}/stream' },
  { method: 'POST', path: '/api/v1/workflows/{slug}/runs/{runId}/stream-ticket' },
  { method: 'GET', path: '/api/v1/workflows/{slug}/runs/{runId}/reviews/{nodeId}' },
  { method: 'POST', path: '/api/v1/workflows/{slug}/runs/{runId}/reviews/{nodeId}/decide' },
  { method: 'GET', path: '/api/v1/consultations/{consultationId}/workflows' },
  { method: 'POST', path: '/api/v1/consultations/{consultationId}/workflows/{slug}/runs' },
]);

/**
 * The gateway's `mode=blocking` 504 is a fixed ceiling, not a transient
 * failure — never retry it. See `core/retry.ts#nonRetryableStatuses`.
 */
const BLOCKING_NON_RETRYABLE: ReadonlySet<number> = new Set([504]);

/** How many times a dropped stream is reconnected before giving up. */
const DEFAULT_MAX_RESUME_ATTEMPTS = 5;

/** Options common to every run-start call. */
export interface StartRunOptions {
  signal?: AbortSignal;
  /**
   * Sent as the `Idempotency-Key` header. **A retry with the same value JOINS
   * the run already in flight instead of starting — and billing — a second
   * one**; the run id is derived from `(tenant, slug, key)` and Temporal
   * refuses a duplicate execution under it. The response's
   * `status: 'already_running'` tells you a join happened.
   *
   * Use a key that is stable for the LOGICAL attempt (an order id, a message
   * id, a job row's primary key) — not a fresh UUID per HTTP try, which
   * defeats the whole mechanism.
   */
  idempotencyKey?: string;
  /**
   * Mint an `Idempotency-Key` (UUIDv7) for this call when you have no natural
   * key of your own. Ignored when {@link idempotencyKey} is set.
   *
   * Weaker than supplying your own: it protects a TRANSPORT-level retry inside
   * this SDK, but a fresh process calling again generates a fresh key and
   * starts a second run. Prefer a key derived from your own domain.
   */
  idempotent?: boolean;
  /** Overrides the client's per-request timeout. Raise it for `runAndWait`, whose server ceiling is ~60s. */
  timeoutMs?: number;
}

/** Options for {@link WorkflowsResource.streamRun}. */
export interface StreamRunOptions {
  signal?: AbortSignal;
  /**
   * Start from a cursor you already hold — the `resumeToken` of the last frame
   * a previous process/connection successfully handled. Omit on a first
   * connect; the SDK then starts at the beginning of the retained window.
   *
   * Persist `resumeToken` (not the envelope's `id`) if you need to resume
   * across a process restart.
   */
  lastEventId?: string;
  /**
   * Reconnect when the stream ends before the run is terminal. Default `true`
   * — a dropped connection should cost latency, not events.
   */
  autoResume?: boolean;
  /** Reconnect attempts before giving up. Default `5`. Ignored by the socket lane, which does not resume. */
  maxResumeAttempts?: number;
  /**
   * Which lane the run's events arrive on. Default `'sse'`.
   *
   * **`'sse'` is the default because it is the only lane that RESUMES.** A dropped SSE
   * connection reconnects with `Last-Event-ID` and loses no frames; a dropped socket ends the
   * iteration, because its ticket is single-use and the gateway replays nothing after the
   * cursor you opened with.
   *
   * Reach for `'socket'` when something between you and the gateway BUFFERS
   * `text/event-stream` — the symptom is a run that looks stalled and then completes all at
   * once — or when a socket is the budget you already hold. It mints a run-scoped, single-use
   * ticket (`POST …/runs/{runId}/stream-ticket`) and opens the URL that response returns; a
   * JWT never travels in a query string. Needs `globalThis.WebSocket`, i.e. **Node 22+**;
   * without it the SDK throws {@link SocketUnavailableError} rather than importing a polyfill
   * or silently serving the transport you ruled out.
   */
  transport?: 'sse' | 'socket';
}

function runsPath(slug: string): string {
  return `workflows/${encodePathSegment(slug)}/runs`;
}

function runPath(slug: string, runId: string): string {
  return `${runsPath(slug)}/${encodePathSegment(runId)}`;
}

function reviewPath(slug: string, runId: string, nodeId: string): string {
  return `${runPath(slug, runId)}/reviews/${encodePathSegment(nodeId)}`;
}

/**
 * Refuse a service-account client on an API-key-only plane.
 *
 * Deliberately checked in the RESOURCE and not the transport: the transport
 * carries whatever credential it was configured with and is right to be
 * ignorant of which plane a path belongs to. Which credential class a route
 * accepts is a property of the ROUTE.
 *
 * Since TASK-930 the only caller is the CONSULTATION-bound plane
 * (`/consultations/{id}/workflows*`), which still records `svcScopes: []`: running
 * a workflow that writes into a clinical record is not a power the platform hands
 * a machine identity. The unbound plane's routes now declare their `svc:*` scopes,
 * so {@link WorkflowsResource} overrides the check away rather than explaining a
 * refusal the gateway would not make. Still exported: an integrator switching
 * credential classes catches this by name.
 */
export function assertApiKeyPlane(isServiceAccount: boolean, surface: string): void {
  if (!isServiceAccount) return;
  throw new CredentialClassError(
    `${surface} is reachable with an API key only. This client was constructed with a service account, and the gateway declares no ` +
      'service-account scope for the workflow invocation plane (`svcScopes: []` in route-manifest.json), so the request would be ' +
      'refused with a 403 that no role grant can fix. Construct a second HopeClient with `apiKey` for this work — the admin plane ' +
      '(`hope.admin.*`) is the mirror image: service account only.',
  );
}

/**
 * Refuse the socket lane on a runtime without `globalThis.WebSocket`, BEFORE anything is spent.
 *
 * `readSocketFrames` throws the same error, but only once it is reached — by which time a
 * single-use, ~30-second ticket has been minted and, in `runAndStream`, a run has been STARTED.
 * Checking first turns "your run is going and you cannot watch it" into a synchronous refusal.
 */
function assertSocketRuntime(): void {
  if (typeof (globalThis as { WebSocket?: unknown }).WebSocket !== 'function') throw new SocketUnavailableError();
}

/** Throw a {@link ReservedRunIdentityError} when `input` carries a server-stamped identity key. */
function assertNoReservedIdentity(input: Record<string, unknown>): void {
  const offending = reservedRunIdentityKeysIn(input);
  if (offending.length > 0) throw new ReservedRunIdentityError(offending);
}

function idempotencyHeaders(options: StartRunOptions): Record<string, string> | undefined {
  const key = options.idempotencyKey ?? (options.idempotent === true ? generateUuidV7() : undefined);
  return key === undefined ? undefined : { 'Idempotency-Key': key };
}

/** Decode one SSE frame into an envelope carrying its own resume cursor. */
function toRunEvent(data: string, resumeToken: string | undefined): WorkflowRunEvent | null {
  let envelope: unknown;
  try {
    envelope = JSON.parse(data);
  } catch {
    // A frame we cannot parse is skipped rather than thrown: one malformed
    // frame must not destroy a stream whose remaining frames are fine, and
    // the run itself is unaffected by our inability to read one event.
    return null;
  }
  if (typeof envelope !== 'object' || envelope === null) return null;
  return { ...(envelope as WorkflowRunEvent), ...(resumeToken === undefined ? {} : { resumeToken }) };
}

/** Decode one socket frame — the gateway sends `{ event, id?, data }`, where `data` is already the envelope. */
function socketFrameToRunEvent(frame: SocketFrame): WorkflowRunEvent | null {
  if (typeof frame.data !== 'object' || frame.data === null) return null;
  // `id` is the SAME opaque cursor the SSE lane carries on its `id:` line, which is what lets a
  // caller persist `resumeToken` from either lane and hand it back to the other.
  return { ...(frame.data as WorkflowRunEvent), ...(frame.id === undefined ? {} : { resumeToken: frame.id }) };
}

/** `true` when this event means the run has reached a terminal state. */
function isTerminalEvent(event: WorkflowRunEvent): boolean {
  if (event.type === 'workflow.run.completed') return true;
  const status = (event.payload as WorkflowRunEventPayload | undefined)?.status;
  return typeof status === 'string' && isTerminalRunStatus(status);
}

/**
 * The shared invocation engine both planes use.
 *
 * Both route families are the SAME contract with a different prefix and a
 * different authorization pair, so they share one implementation: two copies
 * would be two places for the resume logic, the reserved-key refusal and the
 * blocking-ceiling handling to drift apart — which is precisely the drift the
 * gateway avoided by having both controllers call one `deliverRun`.
 */
abstract class WorkflowInvocationBase {
  protected constructor(
    protected readonly transport: Transport,
    /** `true` when this client authenticates as a service account — see {@link assertApiKeyPlane}. */
    protected readonly isServiceAccount: boolean,
  ) {}

  /** Human-readable name of this plane, used in the credential-class error. */
  protected abstract surfaceName(): string;

  /**
   * Refuse the wrong credential class for THIS plane, before the request leaves.
   *
   * Strict by default — the consultation-bound plane is API-key/JWT only — and
   * overridden to a no-op by {@link WorkflowsResource}, whose routes accept a service
   * account since TASK-930. A hook rather than a boolean flag so the override carries
   * the reason it exists at the place a reader looks for it.
   */
  protected assertCredentialClass(): void {
    assertApiKeyPlane(this.isServiceAccount, this.surfaceName());
  }

  /** Gateway-relative path of the run COLLECTION for `slug` (where a run is POSTed). */
  protected abstract collectionPath(slug: string, scopeId?: string): string;

  /** Gateway-relative path of the LISTING for this plane. */
  protected abstract listPath(scopeId?: string): string;

  protected async listWorkflows(scopeId?: string, signal?: AbortSignal): Promise<WorkflowSummary[]> {
    this.assertCredentialClass();
    const response = await this.transport.request<{ data?: WorkflowSummary[] }>({ path: this.listPath(scopeId), signal });
    return Array.isArray(response?.data) ? response.data : [];
  }

  protected async startRun(slug: string, body: StartWorkflowRunRequest, options: StartRunOptions, scopeId?: string): Promise<WorkflowRunHandle> {
    this.assertCredentialClass();
    assertNoReservedIdentity(body.input);
    const headers = idempotencyHeaders(options);
    return this.transport.request<WorkflowRunHandle>({
      method: 'POST',
      path: this.collectionPath(slug, scopeId),
      body: { input: body.input },
      headers,
      signal: options.signal,
      timeoutMs: options.timeoutMs,
      hasIdempotencyKey: headers !== undefined,
    });
  }

  protected async startRunBlocking(
    slug: string,
    body: StartWorkflowRunRequest,
    options: StartRunOptions,
    scopeId?: string,
  ): Promise<WorkflowRunStatus> {
    this.assertCredentialClass();
    assertNoReservedIdentity(body.input);
    const headers = idempotencyHeaders(options);
    return this.transport.request<WorkflowRunStatus>({
      method: 'POST',
      path: this.collectionPath(slug, scopeId),
      query: { mode: 'blocking' },
      body: { input: body.input },
      headers,
      signal: options.signal,
      timeoutMs: options.timeoutMs,
      hasIdempotencyKey: headers !== undefined,
      // The 504 ceiling is deterministic; retrying spends another 60s to
      // reach the same answer. See BLOCKING_NON_RETRYABLE.
      nonRetryableStatuses: BLOCKING_NON_RETRYABLE,
    });
  }

  /**
   * `?mode=stream`: start the run and read its event stream on the SAME
   * response — one round trip instead of POST-then-GET.
   *
   * **The resume goes to the RUN, not back through this POST.** Re-POSTing on
   * a dropped connection would start a second run (or, with an idempotency
   * key, re-open a second view of the first while the SDK had a perfectly good
   * `runId`). The `runId` arrives in the very first snapshot frame, so from
   * the second connection onward this is an ordinary
   * `GET …/runs/{runId}/stream` with `Last-Event-ID`.
   */
  protected async *startRunStreaming(
    slug: string,
    body: StartWorkflowRunRequest,
    options: StartRunOptions & StreamRunOptions,
    scopeId?: string,
  ): AsyncGenerator<WorkflowRunEvent, void, void> {
    this.assertCredentialClass();
    assertNoReservedIdentity(body.input);
    const headers = { Accept: 'text/event-stream', ...(idempotencyHeaders(options) ?? {}) };

    const response = await this.transport.stream({
      method: 'POST',
      path: this.collectionPath(slug, scopeId),
      query: { mode: 'stream' },
      body: { input: body.input },
      headers,
      signal: options.signal,
      timeoutMs: options.timeoutMs,
      hasIdempotencyKey: options.idempotencyKey !== undefined || options.idempotent === true,
    });

    const state: ResumeState = { lastEventId: undefined, terminal: false, runId: undefined };
    yield* readFrames(response, state, options.signal);

    if (state.terminal || state.runId === undefined || options.autoResume === false) return;
    // Hand off to the ordinary run stream, which owns the reconnect loop. The
    // POST above WAS the first connection, so the budget here is resumes only.
    yield* this.resumeRunStream(slug, state.runId, state, options, options.maxResumeAttempts ?? DEFAULT_MAX_RESUME_ATTEMPTS, scopeId);
  }

  /**
   * Read a run's events over a WebSocket instead of SSE (TASK-931).
   *
   * Three steps, in this order, and the order is the contract: check the runtime has a socket
   * (a single-use ticket spent on a runtime that cannot open it is a ticket wasted), mint the
   * run-scoped ticket, then open the `url` the gateway returned — resolved against the
   * client's own `baseUrl`, `http(s)` → `ws(s)`.
   *
   * No resume loop. The ticket is single-use and ~30s-lived, so a re-mint after a drop would
   * be a NEW subscription, not a resumption; SSE is the lane that resumes, and this option's
   * doc says so. A caller who needs to pick up where a socket left off passes the last
   * `resumeToken` back as `lastEventId`, which the gateway reads off the query string.
   */
  protected async *streamRunOverSocket(slug: string, runId: string, options: StreamRunOptions): AsyncGenerator<WorkflowRunEvent, void, void> {
    assertSocketRuntime();
    const ticket = await this.transport.request<WorkflowRunStreamTicket>({
      method: 'POST',
      path: `${runPath(slug, runId)}/stream-ticket`,
      signal: options.signal,
    });
    const url = resolveSocketUrl(this.transport.baseUrl, ticket.url, options.lastEventId);
    for await (const frame of readSocketFrames(url, { signal: options.signal })) {
      const event = socketFrameToRunEvent(frame);
      if (event !== null) yield event;
    }
  }

  /** Path of the run's SSE endpoint. Overridden where the plane's runs live under a different prefix. */
  protected streamPath(slug: string, runId: string, _scopeId?: string): string {
    return `${runPath(slug, runId)}/stream`;
  }

  /**
   * The connect/reconnect loop, shared by `streamRun` and the `mode=stream`
   * hand-off.
   *
   * `connections` is a count of CONNECTIONS this loop may open, not of
   * resumes, because the two callers differ in whether the first connection
   * has already happened: `streamRun` opens it here (so it budgets
   * `maxResumeAttempts + 1`), while `runAndStream` already spent its first
   * connection on the POST (so it budgets exactly `maxResumeAttempts`).
   * Expressing the budget in the unit the loop actually spends keeps that
   * off-by-one in one place instead of two.
   */
  protected async *resumeRunStream(
    slug: string,
    runId: string,
    state: ResumeState,
    options: StreamRunOptions,
    connections: number,
    scopeId?: string,
  ): AsyncGenerator<WorkflowRunEvent, void, void> {
    for (let attempt = 0; attempt < connections && !state.terminal; attempt += 1) {
      const response = await this.transport.stream({
        path: this.streamPath(slug, runId, scopeId),
        headers: {
          Accept: 'text/event-stream',
          // Omitted entirely on a first connect: an empty header would name a
          // cursor the gateway cannot resolve, and forbids inventing one.
          ...(state.lastEventId === undefined ? {} : { 'Last-Event-ID': state.lastEventId }),
        },
        signal: options.signal,
      });
      const before = state.frames;
      yield* readFrames(response, state, options.signal);
      // A reconnect that delivered nothing and did not terminate is not
      // progress — without this the loop would spin `maxAttempts` times against
      // a stream that has nothing more to give.
      if (!state.terminal && state.frames === before) return;
    }
  }
}

/** Mutable cursor carried across reconnects. */
interface ResumeState {
  lastEventId: string | undefined;
  terminal: boolean;
  runId: string | undefined;
  frames?: number;
}

/** Read one connection's frames into `state`, yielding each decoded event. */
async function* readFrames(response: Response, state: ResumeState, signal?: AbortSignal): AsyncGenerator<WorkflowRunEvent, void, void> {
  if (!response.body) return;
  for await (const frame of parseSseStream(response.body, { signal })) {
    const event = toRunEvent(frame.data, frame.id);
    if (event === null) continue;
    // Advance the cursor ONLY for a frame that carried one. The snapshot frame
    // has no `id:` by design; treating its absence as "reset to the beginning"
    // would re-deliver the whole retained window on every reconnect.
    if (frame.id !== undefined) state.lastEventId = frame.id;
    state.runId ??= (event.payload as WorkflowRunEventPayload | undefined)?.runId ?? event.correlationId;
    state.frames = (state.frames ?? 0) + 1;
    if (isTerminalEvent(event)) state.terminal = true;
    yield event;
  }
}

/**
 * `hope.workflows.reviews` — read and release a run's `core.humanReview` nodes (TASK-890).
 *
 * A Human-review node parks a run on a person and waits, durably, for as long as the node
 * says. Everything downstream of the handle that does not fire is skipped. So this is the
 * surface that decides whether a paused run ever finishes — and the two properties it holds
 * are both about what it will NOT do:
 *
 * 1. **It never invents a reviewer.** `reviewerId` is not part of the request body and cannot
 *    be sent; the gateway stamps the acting user from your credential. An approval is an
 *    attribution, and a field here would let one caller sign another's name to it.
 * 2. **It never turns a failure into "nothing to decide".** `exists: false` is the
 *    interpreter's own answer for a review that has not started or has already settled. A
 *    gateway or interpreter outage throws instead — because a reviewer UI that renders an
 *    empty queue during an outage silently loses the work it was built to protect.
 *
 * A review is decided ONCE: the durable child ignores a second signal, so `decide` is safe to
 * retry.
 */
export class WorkflowReviewsResource {
  constructor(private readonly transport: Transport) {}

  /**
   * `GET /api/v1/workflows/{slug}/runs/{runId}/reviews/{nodeId}` — is this review waiting, and
   * what has been decided?
   *
   * A graph may carry several review nodes, which is why a review is addressed by
   * `(runId, nodeId)` and not by the run alone.
   */
  async get(slug: string, runId: string, nodeId: string, options: { signal?: AbortSignal } = {}): Promise<WorkflowReview> {
    return this.transport.request<WorkflowReview>({ path: reviewPath(slug, runId, nodeId), signal: options.signal });
  }

  /**
   * `POST …/reviews/{nodeId}/decide` — release the review; the graph resumes down the
   * `approved` or `rejected` handle.
   *
   * Returns once the signal was SENT. The run continues on its own clock, so watch the run
   * stream (or poll `getRun`) for what happens next rather than reading the return value as
   * "the workflow has moved on".
   */
  async decide(
    slug: string,
    runId: string,
    nodeId: string,
    body: WorkflowReviewDecision,
    options: { signal?: AbortSignal } = {},
  ): Promise<WorkflowReviewDecisionResult> {
    return this.transport.request<WorkflowReviewDecisionResult>({
      method: 'POST',
      path: `${reviewPath(slug, runId, nodeId)}/decide`,
      // Rebuilt field by field rather than spread: the gateway DTO forbids undeclared
      // properties, so forwarding a caller's object wholesale turns one stray key — a
      // hand-written `reviewerId` most of all — into a 400 the caller cannot read.
      body: {
        decision: body.decision,
        ...(body.comment === undefined ? {} : { comment: body.comment }),
        ...(body.editedPayload === undefined ? {} : { editedPayload: body.editedPayload }),
      },
      signal: options.signal,
    });
  }
}

/**
 * `hope.workflows` — run a tenant's published workflows.
 *
 * ```ts
 * const hope = new HopeClient({ baseUrl: process.env.HOPE_API_URL!, apiKey: process.env.HOPE_API_KEY! });
 *
 * const [workflow] = await hope.workflows.list();
 * for await (const event of hope.workflows.runAndStream(workflow.slug, { input: { note } })) {
 *   console.log(event.type);
 * }
 * ```
 */
export class WorkflowsResource extends WorkflowInvocationBase {
  /**
   * `hope.workflows.reviews` — the human-review sub-surface. Composed here rather than hung off
   * the client so it is reachable exactly where the runs it acts on are.
   */
  readonly reviews: WorkflowReviewsResource;

  constructor(transport: Transport, isServiceAccount = false) {
    super(transport, isServiceAccount);
    this.reviews = new WorkflowReviewsResource(transport);
  }

  protected surfaceName(): string {
    return 'The workflow invocation plane (`hope.workflows`)';
  }

  /**
   * Both machine credential classes reach this plane (TASK-930 §3): an API key, and a service
   * account holding `svc:workflow:definition:read` / `svc:workflow:run:read` /
   * `svc:workflow:run:write`. Overridden to a no-op rather than deleted from the base, because
   * {@link ConsultationWorkflowsResource} — the same code, the clinical prefix — still refuses
   * a service account, and one class silently inheriting the other's rule is how that would rot.
   */
  protected override assertCredentialClass(): void {}

  protected collectionPath(slug: string): string {
    return runsPath(slug);
  }

  protected listPath(): string {
    return 'workflows';
  }

  /** `GET /api/v1/workflows` — the tenant's published, invokable workflows. Never `null`: `[]` means the tenant has published none. */
  async list(options: { signal?: AbortSignal } = {}): Promise<WorkflowSummary[]> {
    return this.listWorkflows(undefined, options.signal);
  }

  /**
   * `GET /api/v1/workflows/{slug}/schema` — the generated contract of one published
   * definition: input/output component schemas, trigger kinds, output protocols, the delivery
   * lanes it admits, and an AsyncAPI fragment for its run events.
   *
   * {@link list} already carries the same four facts per workflow, so reach for this when you
   * want the OpenAPI/AsyncAPI PROJECTIONS — generating a client, rendering a portal page —
   * rather than deciding what to send. Discovering a catalogue does not need an N+1 of these.
   */
  async schema(slug: string, options: { signal?: AbortSignal } = {}): Promise<WorkflowSchemaDescription> {
    return this.transport.request<WorkflowSchemaDescription>({ path: `workflows/${encodePathSegment(slug)}/schema`, signal: options.signal });
  }

  /**
   * Start a run and return immediately with its handle (`?mode=async`, the
   * default). The run continues regardless of what this process does next.
   */
  async run(slug: string, body: StartWorkflowRunRequest, options: StartRunOptions = {}): Promise<WorkflowRunHandle> {
    return this.startRun(slug, body, options);
  }

  /**
   * Start a run and WAIT for it to finish (`?mode=blocking`), returning the
   * terminal status.
   *
   * Throws {@link GatewayTimeoutError} at the gateway's ~60s ceiling — which
   * means the run is still going, not that it failed. For anything that might
   * take longer, prefer {@link runAndStream}.
   */
  async runAndWait(slug: string, body: StartWorkflowRunRequest, options: StartRunOptions = {}): Promise<WorkflowRunStatus> {
    return this.startRunBlocking(slug, body, options);
  }

  /**
   * Start a run and consume its event stream in one call (`?mode=stream`),
   * reconnecting transparently if the connection drops.
   */
  runAndStream(
    slug: string,
    body: StartWorkflowRunRequest,
    options: StartRunOptions & StreamRunOptions = {},
  ): AsyncGenerator<WorkflowRunEvent, void, void> {
    if (options.transport === 'socket') return this.startRunThenSocket(slug, body, options);
    return this.startRunStreaming(slug, body, options);
  }

  /**
   * `transport: 'socket'` variant of {@link runAndStream}: start the run ASYNC, then open the
   * socket against the `runId` it returns.
   *
   * `?mode=stream` would put the events on the POST's own response body, which is an SSE
   * stream by construction — there is no socket to hand off to. So the socket lane costs one
   * extra round trip on the start, and says so here rather than pretending otherwise.
   */
  private async *startRunThenSocket(
    slug: string,
    body: StartWorkflowRunRequest,
    options: StartRunOptions & StreamRunOptions,
  ): AsyncGenerator<WorkflowRunEvent, void, void> {
    assertSocketRuntime();
    const handle = await this.run(slug, body, options);
    yield* this.streamRunOverSocket(slug, handle.runId, options);
  }

  /** `GET /api/v1/workflows/{slug}/runs/{runId}` — live status, stages and delivered result. */
  async getRun(slug: string, runId: string, options: { signal?: AbortSignal } = {}): Promise<WorkflowRunStatus> {
    return this.transport.request<WorkflowRunStatus>({ path: runPath(slug, runId), signal: options.signal });
  }

  /** `POST /api/v1/workflows/{slug}/runs/{runId}/cancel`. Returns once the signal is SENT — cancellation may not be complete. */
  async cancelRun(slug: string, runId: string, options: { signal?: AbortSignal } = {}): Promise<WorkflowRunCancelResult> {
    return this.transport.request<WorkflowRunCancelResult>({ method: 'POST', path: `${runPath(slug, runId)}/cancel`, signal: options.signal });
  }

  /**
   * `GET /api/v1/workflows/{slug}/runs/{runId}/stream` — snapshot-then-delta
   * SSE, **with resume**.
   *
   * The first frame is a snapshot of current status (and carries no resume
   * token — there is no stream position to name). Every frame after it is a
   * real event pushed by the interpreter, and its `resumeToken` is the cursor.
   *
   * If the connection drops before the run is terminal, this reconnects with
   * `Last-Event-ID` set to the last token it saw, so nothing between the two
   * connections is lost. You do not have to do anything to get that; set
   * `autoResume: false` to opt out.
   */
  streamRun(slug: string, runId: string, options: StreamRunOptions = {}): AsyncGenerator<WorkflowRunEvent, void, void> {
    if (options.transport === 'socket') return this.streamRunOverSocket(slug, runId, options);
    const state: ResumeState = { lastEventId: options.lastEventId, terminal: false, runId };
    // One connection for the initial connect, plus the resume budget on top —
    // `autoResume: false` spends the first and buys none.
    const resumes = options.autoResume === false ? 0 : (options.maxResumeAttempts ?? DEFAULT_MAX_RESUME_ATTEMPTS);
    return this.resumeRunStream(slug, runId, state, options, resumes + 1);
  }

  /**
   * Wait for an ALREADY-STARTED run to finish, over the event stream (never a
   * poll loop), and return its terminal status.
   *
   * Pairs with {@link run}: start now, hand the `runId` to another process,
   * wait there. Unlike {@link runAndWait} there is no 60s ceiling — the
   * stream is resumed across disconnects for as long as the run takes.
   */
  async waitForRun(slug: string, runId: string, options: StreamRunOptions = {}): Promise<WorkflowRunStatus> {
    let last: WorkflowRunEvent | undefined;
    for await (const event of this.streamRun(slug, runId, options)) {
      if (isTerminalEvent(event)) last = event;
    }
    if (last === undefined) {
      // The stream ended without a terminal frame (resume attempts exhausted).
      // One authoritative read is the honest answer — not a synthesized status.
      return this.getRun(slug, runId, { signal: options.signal });
    }
    const payload = last.payload as WorkflowRunEventPayload;
    return {
      runId: payload.runId,
      slug: payload.slug,
      workflowVersionNumber: payload.workflowVersionNumber,
      status: payload.status,
      stages: payload.stages ?? [],
      startedAt: payload.startedAt ?? null,
      endedAt: payload.endedAt ?? null,
      resultRef: (payload.resultRef as Record<string, unknown> | undefined) ?? null,
    };
  }
}

/**
 * `hope.consultations.workflows` — run a published workflow AGAINST one
 * consultation.
 *
 * The clinical plane. Everything {@link WorkflowsResource} does, plus the one
 * difference that defines it: **the consultation is named by the URL**, and
 * the server re-resolves it against your tenant before anything downstream
 * sees it. You never put a consultation id in `input` — that is a 400, and
 * this SDK refuses it before the request goes out.
 *
 * It also lists MORE than `hope.workflows.list()`: consultation-palette
 * definitions are invokable here and nowhere else.
 */
export class ConsultationWorkflowsResource extends WorkflowInvocationBase {
  constructor(transport: Transport, isServiceAccount = false) {
    super(transport, isServiceAccount);
  }

  protected surfaceName(): string {
    return 'The consultation workflow plane (`hope.consultations.workflows`)';
  }

  protected listPath(consultationId?: string): string {
    return `consultations/${encodePathSegment(consultationId ?? '')}/workflows`;
  }

  protected collectionPath(slug: string, consultationId?: string): string {
    return `${this.listPath(consultationId)}/${encodePathSegment(slug)}/runs`;
  }

  /**
   * Runs started here are read back through the UNBOUND run routes: lane A
   * shipped no consultation-scoped status/stream/cancel routes, and the
   * `statusUrl`/`streamUrl` in the 202 handle point at `/workflows/…` for
   * exactly that reason. Pointing them elsewhere would 404.
   */
  protected streamPath(slug: string, runId: string): string {
    return `${runPath(slug, runId)}/stream`;
  }

  /** `GET /api/v1/consultations/{consultationId}/workflows` — what may be run against THIS consultation. */
  async list(consultationId: string, options: { signal?: AbortSignal } = {}): Promise<WorkflowSummary[]> {
    return this.listWorkflows(consultationId, options.signal);
  }

  /** Start a run against this consultation; returns immediately with the handle. */
  async run(consultationId: string, slug: string, body: StartWorkflowRunRequest, options: StartRunOptions = {}): Promise<WorkflowRunHandle> {
    return this.startRun(slug, body, options, consultationId);
  }

  /** Start a run against this consultation and wait for the terminal status (~60s ceiling → {@link GatewayTimeoutError}). */
  async runAndWait(consultationId: string, slug: string, body: StartWorkflowRunRequest, options: StartRunOptions = {}): Promise<WorkflowRunStatus> {
    return this.startRunBlocking(slug, body, options, consultationId);
  }

  /** Start a run against this consultation and consume its stream, with resume. */
  runAndStream(
    consultationId: string,
    slug: string,
    body: StartWorkflowRunRequest,
    options: StartRunOptions & StreamRunOptions = {},
  ): AsyncGenerator<WorkflowRunEvent, void, void> {
    return this.startRunStreaming(slug, body, options, consultationId);
  }
}
