/**
 * `ConsultationHandle` — one consultation, driven end to end.
 *
 * `hope.consultations.open(request)` returns one of these, and `hope.consultations.attach(id)`
 * builds one for a consultation you did not open. The handle carries the open response's fields
 * (read-only), tracks the consultation's `status`, `processing` and `version` as commands and
 * lifecycle events arrive, and exposes the verbs a visit needs:
 *
 * ```ts
 * const visit = await hope.consultations.open({ patientId, clinicianUserId });
 * const capture = await visit.start();           // opens the STT session, binds it, connects
 * capture.socket.sendPcm16(frame);               // stream audio
 * await visit.pause();                           // and visit.start() again resumes
 * const stopped = await visit.stop();            // waits for the final transcript
 * await visit.generateSummary({ wait: true });
 * await visit.approve();
 * await visit.close();
 * ```
 *
 * Every call the handle makes sends `X-Hope-Lifecycle: 2`, which asks the gateway for the real
 * seven-value status instead of the one projected for older clients.
 */

import { ConflictError, VersionConflictError } from '../core/errors';
import { generateUuidV7 } from '../core/idempotency';
import type { RealtimeSttSocket } from '../core/realtime-stt-socket';
import { subscribeToSse } from '../core/sse-subscription';
import type { StreamHandle } from '../core/sse-subscription';
import type { Transport, TransportRequestOptions } from '../core/transport';
import { encodePathSegment } from '../core/url';
import type { ConsultationOpenResponse } from '../types/consultation-realtime';
import type { AsyncJobResponse, ConsultationSummaryResponse } from '../types/consultation';
import type {
  ActivityEntry,
  ApproveOptions,
  ConsultationCommandOptions,
  AttachmentCompleteResponse,
  AttachmentInput,
  AttachmentIntentResponse,
  AttachmentResult,
  CaptureHandle,
  CaptureState,
  CaptureStateName,
  CloseOptions,
  ConsultationActivityPage,
  ConsultationLifecycleFields,
  ConsultationLifecycleStatus,
  ConsultationProcessing,
  ConsultationState,
  EncounterRecap,
  FeedbackInput,
  FeedbackReasonCodesResponse,
  FeedbackResponse,
  GenerateSummaryOptions,
  HistoryQuery,
  LifecycleEvent,
  ReopenOptions,
  SendAttachmentOptions,
  StartCaptureOptions,
  StopCaptureOptions,
  StopResult,
  ConsultationHandleCallOptions,
} from '../types/consultation-lifecycle';
import type {
  GuardrailApproveRequestAdditions,
  GuardrailApproveResponseAdditions,
  GuardrailHoldResolution,
  GuardrailNotice,
  GuardrailNoticesResponse,
} from '../types/guardrail';
import { isGuardrailHoldReason } from '../types/guardrail';
import type { SttTranscriptResult } from '../types/stt';
import { ConsultationSummariesResource } from './consultation-summaries';
import { JobsResource } from './jobs';
import type { SttResource } from './stt';

/** The header that asks the gateway for the real lifecycle vocabulary. */
export const LIFECYCLE_HEADER = 'X-Hope-Lifecycle';
export const LIFECYCLE_HEADER_VALUE = '2';

/**
 * A view of `transport` that adds `X-Hope-Lifecycle: 2` to every request it makes. The original is
 * untouched, so a client's other resources keep sending exactly what they sent before.
 */
export function withLifecycleHeader(transport: Transport): Transport {
  const merge = (options: TransportRequestOptions): TransportRequestOptions => {
    const headers = new Headers(options.headers ?? undefined);
    if (!headers.has(LIFECYCLE_HEADER)) headers.set(LIFECYCLE_HEADER, LIFECYCLE_HEADER_VALUE);
    return { ...options, headers };
  };
  const view = Object.create(transport) as Transport;
  view.request = <T = unknown>(options: TransportRequestOptions) => transport.request<T>(merge(options));
  view.stream = (options: TransportRequestOptions) => transport.stream(merge(options));
  return view;
}

/** What the handle needs from its client. */
export interface ConsultationHandleDeps {
  transport: Transport;
  stt: Pick<SttResource, 'createStreamSession' | 'socket'> & Partial<Pick<SttResource, 'closeStreamSession'>>;
  /** Used for the direct-to-storage upload, which must carry no gateway credentials. Defaults to the global `fetch`. */
  fetch?: typeof fetch;
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable for tests; drives retry jitter. */
  random?: () => number;
}

/** The fields the open response carries, plus the lifecycle fields the gateway adds. */
export type ConsultationOpenResult = Omit<ConsultationOpenResponse, 'status'> &
  Partial<ConsultationLifecycleFields> & {
    status: string;
    lifecycle?: { status: ConsultationLifecycleStatus; processing: ConsultationProcessing };
  };

/** What {@link ConsultationHandle.on} delivers per event name. */
export interface ConsultationHandleEvents {
  /** A transcript result from the live socket. */
  transcript: SttTranscriptResult;
  /** A lifecycle event from the consultation's event stream. */
  status: LifecycleEvent;
  /** The capture started, paused, resumed, expired or stopped. */
  'capture-state': { state: CaptureStateName; sessionId?: string; audioOffsetMs?: number };
  /**
   * A guardrail notice this consultation raised that the handle had not delivered yet (TASK-1050). The handle learns of
   * one from the lifecycle event stream — a block puts the consultation on a hold (`processingReason`
   * `GUARDRAIL_HOLD` / `EGRESS_REDACTION_UNAVAILABLE`) — then reads the notice by id. Each `noticeId` is delivered once.
   * Warnings raised while a note is generated arrive on that result's `guardrailNotices`; read them any time with
   * {@link ConsultationHandle.guardrailNotices}.
   */
  'guardrail-notice': GuardrailNotice;
  /** Anything that went wrong on the socket or the event stream. */
  error: unknown;
}

export type ConsultationHandleEventName = keyof ConsultationHandleEvents;

/** The object storage refused the upload (a 4xx, or the retries ran out). */
export class AttachmentUploadError extends Error {
  readonly status?: number;
  constructor(message: string, status?: number, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'AttachmentUploadError';
    this.status = status;
  }
}

/** The gateway failed or expired an attachment while processing it. */
export class AttachmentFailedError extends Error {
  readonly attachmentId: string;
  readonly code?: string;
  constructor(attachmentId: string, status: string, code?: string) {
    super(`Attachment ${attachmentId} ${status.toLowerCase()}${code ? `: ${code}` : ''}.`);
    this.name = 'AttachmentFailedError';
    this.attachmentId = attachmentId;
    this.code = code;
  }
}

const UPLOAD_MAX_ATTEMPTS = 5;
const UPLOAD_BASE_DELAY_MS = 500;
const UPLOAD_MAX_DELAY_MS = 8_000;
const COMPLETE_NOT_UPLOADED_RETRIES = 3;
const STOP_TIMEOUT_MS = 120_000;
const EVENTS_RECONNECT_BASE_MS = 1_000;
const EVENTS_RECONNECT_MAX_MS = 15_000;
const EVENTS_MAX_IDLE_RECONNECTS = 5;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer), (b) => b.toString(16).padStart(2, '0')).join('');
}

async function toBytes(data: AttachmentInput['data']): Promise<Uint8Array> {
  if (typeof data === 'string') return new TextEncoder().encode(data);
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return new Uint8Array(await data.arrayBuffer());
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new Error('sendAttachment: WebCrypto (`crypto.subtle`) is unavailable on this runtime — pass `sha256` yourself.');
  }
  return toHex(await subtle.digest('SHA-256', bytes as unknown as ArrayBuffer));
}

/** `Retry-After` as milliseconds: delta-seconds or an HTTP date. */
function retryAfterMs(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(header);
  return Number.isNaN(at) ? undefined : Math.max(0, at - Date.now());
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('The operation was aborted.', 'AbortError');
}

/** Send a control frame the socket class has no named method for (`pause`, `resume-capture`). */
function sendControl(socket: RealtimeSttSocket, frame: Record<string, unknown>): void {
  const loose = socket as unknown as {
    sendControl?: (f: Record<string, unknown>) => void;
    requireSocket?: () => { send(data: string): void };
  };
  if (typeof loose.sendControl === 'function') {
    loose.sendControl(frame);
    return;
  }
  loose.requireSocket?.().send(JSON.stringify(frame));
}

type MutableState = {
  status: ConsultationLifecycleStatus;
  processing: ConsultationProcessing;
  processingReason?: string | null;
  version: number | undefined;
};

// Merge the open response's fields onto the class type so `handle.patientId` etc. type-check.
// `status`, `processing` and `version` are declared on the class because they move.
// eslint-disable-next-line @typescript-eslint/no-empty-object-type, @typescript-eslint/no-unsafe-declaration-merging -- intentional: the constructor copies the open response's fields onto the instance, and this merge is how they are typed
export interface ConsultationHandle extends Readonly<Omit<ConsultationOpenResult, 'status' | 'processing' | 'version'>> {}

// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging -- see the interface above
export class ConsultationHandle {
  /** The consultation's lifecycle status; follows commands and lifecycle events. */
  readonly status!: ConsultationLifecycleStatus;
  /**
   * The orthogonal processing marker. A written note reads `IDLE` with `processingReason`
   * `NOTE_READY`; `AWAITING_REVIEW` is a written note that needs a human (coverage gaps or an
   * escalation); `FINALIZING_TRANSCRIPT`, `SUMMARIZING` and `PROCESSING_ATTACHMENT` are work in flight.
   */
  readonly processing!: ConsultationProcessing;
  /** The row version the next `If-Match` is built from. */
  readonly version!: number | undefined;

  readonly #deps: ConsultationHandleDeps;
  readonly #transport: Transport;
  readonly #summaries: ConsultationSummariesResource;
  readonly #jobs: JobsResource;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #random: () => number;
  readonly #listeners = new Map<ConsultationHandleEventName, Set<(payload: never) => void>>();

  #socket: RealtimeSttSocket | undefined;
  #socketOffs: Array<() => void> = [];
  #pauseExpired = false;
  #events: StreamHandle | undefined;
  #eventsSince = 0;
  #eventsIdle = 0;
  #disposed = false;
  readonly #deliveredNoticeIds = new Set<string>();

  constructor(open: ConsultationOpenResult, deps: ConsultationHandleDeps) {
    Object.assign(this, open);
    this.#deps = deps;
    this.#transport = withLifecycleHeader(deps.transport);
    this.#sleep = deps.sleep ?? defaultSleep;
    this.#random = deps.random ?? Math.random;
    this.#summaries = new ConsultationSummariesResource(this.#transport);
    this.#jobs = new JobsResource(this.#transport, this.#sleep);
    const state = this.#state();
    state.status = (open.lifecycle?.status ?? open.status) as ConsultationLifecycleStatus;
    state.processing = open.lifecycle?.processing ?? open.processing ?? 'IDLE';
    state.version = open.version;
  }

  #state(): MutableState {
    return this as unknown as MutableState;
  }

  #path(suffix = ''): string {
    return `consultations/${encodePathSegment(this.id)}${suffix}`;
  }

  /** Fold a command or read response into the handle's tracked status, processing and version. */
  #apply(
    response: Partial<ConsultationState> & {
      lifecycle?: { status: ConsultationLifecycleStatus; processing: ConsultationProcessing };
      status?: string;
    },
  ): void {
    const state = this.#state();
    const status = response.lifecycle?.status ?? response.status;
    if (status) state.status = status as ConsultationLifecycleStatus;
    const processing = response.lifecycle?.processing ?? response.processing;
    if (processing) state.processing = processing;
    if ('processingReason' in response) state.processingReason = response.processingReason ?? null;
    if (typeof response.version === 'number') state.version = response.version;
  }

  /** `true` while the consultation waits on a guardrail hold (`processingReason` `GUARDRAIL_HOLD` / `EGRESS_REDACTION_UNAVAILABLE`). */
  get onGuardrailHold(): boolean {
    return isGuardrailHoldReason(this.processingReason);
  }

  // ── events ────────────────────────────────────────────────────────────────────────────────

  /**
   * Subscribe to an event; returns the function that unsubscribes.
   *
   * - `transcript` — results from the live socket opened by {@link start}.
   * - `status` — lifecycle events (`started`, `paused`, `stopped`, `transcript_final`,
   *   `processing_changed`, `approved`, `closed`, …) from the consultation's event stream. The stream
   *   opens when the first `status` listener is added and closes with the last, and it reconnects
   *   from where it left off.
   * - `capture-state` — the capture went `capturing`, `paused`, `pause_expired` or `stopped`.
   * - `error` — a socket or event-stream failure.
   */
  on<E extends ConsultationHandleEventName>(event: E, listener: (payload: ConsultationHandleEvents[E]) => void): () => void {
    const set = this.#listeners.get(event) ?? new Set();
    set.add(listener as (payload: never) => void);
    this.#listeners.set(event, set);
    if (event === 'status' || event === 'guardrail-notice') this.#openEvents();
    return () => {
      set.delete(listener as (payload: never) => void);
      if ((event === 'status' || event === 'guardrail-notice') && !this.#wantsEvents()) this.#closeEvents();
    };
  }

  #wantsEvents(): boolean {
    return (this.#listeners.get('status')?.size ?? 0) > 0 || (this.#listeners.get('guardrail-notice')?.size ?? 0) > 0;
  }

  #emit<E extends ConsultationHandleEventName>(event: E, payload: ConsultationHandleEvents[E]): void {
    for (const listener of [...(this.#listeners.get(event) ?? [])]) {
      try {
        (listener as (p: ConsultationHandleEvents[E]) => void)(payload);
      } catch (error) {
        if (event !== 'error') this.#emit('error', error);
      }
    }
  }

  #openEvents(): void {
    if (this.#events || this.#disposed) return;
    const handle = subscribeToSse(
      this.#transport,
      {
        path: this.#path('/events'),
        query: this.#eventsSince > 0 ? { since: this.#eventsSince } : undefined,
        dispatch: (payload) => {
          const event = payload as LifecycleEvent;
          if (typeof event.seq === 'number') {
            if (event.seq <= this.#eventsSince) return;
            this.#eventsSince = event.seq;
          }
          this.#eventsIdle = 0;
          this.#apply({ status: event.status, processing: event.processing, processingReason: event.processingReason, version: event.version });
          this.#emit('status', event);
          if (isGuardrailHoldReason(event.processingReason)) void this.#deliverHoldNotices();
        },
      },
      {
        onClosed: (reason) => {
          this.#events = undefined;
          if (reason !== 'end' || this.#disposed || !this.#wantsEvents()) return;
          void this.#reconnectEvents();
        },
        onError: (error) => {
          this.#events = undefined;
          this.#emit('error', error);
        },
      },
    );
    this.#events = handle;
  }

  async #reconnectEvents(): Promise<void> {
    this.#eventsIdle += 1;
    if (this.#eventsIdle > EVENTS_MAX_IDLE_RECONNECTS) return;
    const delay = Math.min(EVENTS_RECONNECT_MAX_MS, EVENTS_RECONNECT_BASE_MS * 2 ** (this.#eventsIdle - 1));
    await this.#sleep(delay);
    if (!this.#disposed && this.#wantsEvents()) this.#openEvents();
  }

  #closeEvents(): void {
    this.#events?.close();
    this.#events = undefined;
  }

  /** Stop the event stream and the live socket. The handle's verbs still work afterwards. */
  dispose(): void {
    this.#disposed = true;
    this.#closeEvents();
    this.#detachSocket(true);
  }

  // ── capture ───────────────────────────────────────────────────────────────────────────────

  #attachSocket(socket: RealtimeSttSocket): void {
    this.#detachSocket(false);
    this.#socket = socket;
    this.#pauseExpired = false;
    this.#socketOffs = [
      socket.on('transcript', (t) => this.#emit('transcript', t)),
      socket.on('status', (s) => {
        const name = s.status === 'paused' || s.status === 'capturing' || s.status === 'pause_expired' ? s.status : undefined;
        if (!name) return;
        if (name === 'pause_expired') this.#pauseExpired = true;
        const extra = s as { sessionId?: string; audioOffsetMs?: number };
        this.#emit('capture-state', { state: name, sessionId: extra.sessionId, audioOffsetMs: extra.audioOffsetMs });
      }),
      socket.on('error', (e) => this.#emit('error', e)),
    ];
  }

  #detachSocket(closeIt: boolean): void {
    for (const off of this.#socketOffs) off();
    this.#socketOffs = [];
    const socket = this.#socket;
    this.#socket = undefined;
    if (closeIt && socket?.connected) socket.close();
  }

  #captureHandle(socket: RealtimeSttSocket, state: CaptureState, resumed: boolean): CaptureHandle {
    return { sessionId: socket.sessionId, socket, state, resumed };
  }

  /**
   * Start capturing audio, or resume a paused capture.
   *
   * From `OPEN` or `STOPPED` it opens an STT session for this consultation, tells the gateway to
   * start with it, then connects the socket — stream PCM16 into `capture.socket`. From `PAUSED`
   * it resumes: on the live socket when there is one, by reconnecting it when the connection
   * dropped, and with a fresh session when the pause ran out (`pause_expired`). On an already
   * live capture it returns that capture unchanged.
   *
   * Consent for AI documentation is checked by the gateway: a patient without it is a 409 here.
   *
   * @throws ConflictError — 409 `CONSULTATION_NOT_RECORDABLE`, `STT_SESSION_NOT_ACTIVE` or
   * `CONSULTATION_TRANSITION_ILLEGAL`.
   */
  async start(options: StartCaptureOptions = {}): Promise<CaptureHandle> {
    const { signal } = options;
    const existing = this.#socket;

    if (existing && this.status === 'RECORDING' && existing.connected) {
      return this.#captureHandle(existing, this.#lastCapture ?? this.#syntheticState(existing), true);
    }

    if (existing && this.status === 'PAUSED' && !this.#pauseExpired) {
      const wasConnected = existing.connected;
      let live = wasConnected;
      if (!live) {
        try {
          await existing.connect();
          live = true;
        } catch {
          live = false;
        }
      }
      if (live) {
        // On a connection that stayed up the capture needs the resume frame; a fresh connect
        // re-handshakes instead and has nothing to resume.
        if (wasConnected) sendControl(existing, { type: 'resume-capture' });
        const state = await this.#startCommand(existing.sessionId, signal);
        return this.#captureHandle(existing, state, true);
      }
    }

    const request: Record<string, unknown> = { consultationId: this.id };
    if (options.agentSlug !== undefined) request.agentSlug = options.agentSlug;
    if (options.language !== undefined) request.language = options.language;
    const session = await this.#deps.stt.createStreamSession(request, { signal });
    let state: CaptureState;
    try {
      state = await this.#startCommand(session.sessionId, signal);
    } catch (error) {
      await this.#deps.stt.closeStreamSession?.(session.sessionId).catch(() => undefined);
      throw error;
    }
    const socket = this.#deps.stt.socket(session);
    this.#attachSocket(socket);
    await socket.connect();
    return this.#captureHandle(socket, state, false);
  }

  #lastCapture: CaptureState | undefined;

  /**
   * Bind an STT session the caller already runs — for callers that do their own speech-to-text and
   * hold their own socket. It sends `POST :id/start { sessionId }` and nothing else: no SDK STT
   * session is created and no socket is opened. From `PAUSED` the same call resumes capture on that
   * session (a fresh one after a pause that ran out). A session different from one the handle opened
   * through {@link start} supersedes it, so the handle closes its own socket.
   *
   * @throws TypeError — locally, for an empty session id.
   * @throws ConflictError — 409 `CONSULTATION_NOT_RECORDABLE`, `STT_SESSION_NOT_ACTIVE` or
   * `CONSULTATION_TRANSITION_ILLEGAL`.
   */
  async startCapture(sttSessionId: string, options: ConsultationHandleCallOptions = {}): Promise<CaptureState> {
    if (typeof sttSessionId !== 'string' || sttSessionId.trim() === '') {
      throw new TypeError('startCapture: pass the id of the STT streaming session to bind.');
    }
    const state = await this.#startCommand(sttSessionId, options.signal);
    const own = this.#socket;
    if (own && own.sessionId !== sttSessionId) this.#detachSocket(true);
    return state;
  }

  #syntheticState(socket: RealtimeSttSocket): CaptureState {
    return {
      consultationId: this.id,
      status: this.status,
      processing: this.processing,
      encounterSeq: this.currentEncounterSeq ?? 1,
      sessionId: socket.sessionId,
      recording: true,
      paused: false,
      version: this.version ?? 0,
      updatedAt: new Date().toISOString(),
    };
  }

  async #startCommand(sessionId: string, signal?: AbortSignal): Promise<CaptureState> {
    const state = await this.#transport.request<CaptureState>({
      method: 'POST',
      path: this.#path('/start'),
      body: { sessionId },
      signal,
    });
    this.#lastCapture = state;
    this.#apply(state);
    this.#emit('capture-state', { state: 'capturing', sessionId: state.sessionId ?? sessionId });
    return state;
  }

  /**
   * Pause the capture. The audio clock stops; the transcript so far is flushed first. Resume with
   * {@link start}. A pause that outlasts the gateway's limit expires: the consultation stays
   * `PAUSED` and the next `start` opens a new session.
   */
  async pause(options: ConsultationHandleCallOptions = {}): Promise<CaptureState> {
    const socket = this.#socket;
    if (socket?.connected) {
      try {
        sendControl(socket, { type: 'pause' });
      } catch {
        // The HTTP command below is authoritative; a socket that just dropped must not block it.
      }
    }
    const state = await this.#transport.request<CaptureState>({
      method: 'POST',
      path: this.#path('/pause'),
      body: {},
      signal: options.signal,
    });
    this.#lastCapture = state;
    this.#apply(state);
    this.#emit('capture-state', { state: 'paused', sessionId: state.sessionId });
    return state;
  }

  /**
   * Stop capturing. By default the call returns once the final transcript has been rebuilt;
   * `finalTranscript.state` says `complete` or, if the wait ran out, `pending`. The live socket is
   * closed afterwards. Summarisation then runs on its own — watch `status` events or call
   * {@link generateSummary}.
   */
  async stop(options: StopCaptureOptions = {}): Promise<StopResult> {
    const body: Record<string, unknown> = { waitForFinal: options.waitForFinal ?? true };
    if (options.persistSnapshot !== undefined) body.persistSnapshot = options.persistSnapshot;
    if (options.acceptedProposals !== undefined) body.acceptedProposals = options.acceptedProposals;
    const result = await this.#transport.request<StopResult>({
      method: 'POST',
      path: this.#path('/stop'),
      body,
      timeoutMs: options.timeoutMs ?? STOP_TIMEOUT_MS,
      signal: options.signal,
    });
    this.#lastCapture = undefined;
    this.#apply(result);
    const socket = this.#socket;
    this.#detachSocket(false);
    if (socket) {
      if (socket.connected) socket.close();
      await socket.waitForClosed().catch(() => undefined);
    }
    this.#emit('capture-state', { state: 'stopped', sessionId: result.sessionId });
    return result;
  }

  // ── review commands (If-Match) ────────────────────────────────────────────────────────────

  /**
   * Re-read the consultation. The handle's `status`, `processing` and `version` follow the answer;
   * the returned state carries the rest of the lifecycle fields (`processingReason`,
   * `closedReason`, `reopenAllowed`, `currentEncounterSeq`, …) as the gateway now holds them.
   *
   * @throws NotFoundError — 404, the consultation is not the caller's.
   */
  async refresh(options: ConsultationHandleCallOptions = {}): Promise<ConsultationState> {
    const current = await this.#transport.request<ConsultationOpenResult & Partial<ConsultationState>>({
      path: this.#path(),
      signal: options.signal,
    });
    this.#apply(current as Partial<ConsultationState>);
    return { ...(current as unknown as ConsultationState), status: this.status, processing: this.processing, version: this.version as number };
  }

  async #refreshVersion(signal?: AbortSignal): Promise<number | undefined> {
    await this.refresh({ signal });
    return this.version;
  }

  /** POST a command under `If-Match`: the explicit value, else the handle's version; on one 412 re-read and retry. */
  async #occCommand(
    verb: string,
    body: Record<string, unknown>,
    options: { ifMatch?: string | number; signal?: AbortSignal },
  ): Promise<ConsultationState & Partial<GuardrailApproveResponseAdditions>> {
    const send = async (version: string | number): Promise<ConsultationState & Partial<GuardrailApproveResponseAdditions>> => {
      const strong = typeof version === 'string' && version.startsWith('"') ? version : `"${version}"`;
      const response = await this.#transport.request<ConsultationState & Partial<GuardrailApproveResponseAdditions>>({
        method: 'POST',
        path: this.#path(`/${verb}`),
        body,
        headers: { 'If-Match': strong },
        signal: options.signal,
      });
      this.#apply(response);
      return response;
    };
    const first = options.ifMatch ?? this.version ?? (await this.#refreshVersion(options.signal));
    if (first === undefined) {
      throw new TypeError(`${verb}: consultation ${this.id} has no \`version\` to build \`If-Match\` from — pass options.ifMatch.`);
    }
    try {
      return await send(first);
    } catch (error) {
      if (!(error instanceof VersionConflictError) || options.ifMatch !== undefined) throw error;
      const fresh = await this.#refreshVersion(options.signal);
      if (fresh === undefined) throw error;
      return send(fresh);
    }
  }

  // ── guardrail notices and holds (TASK-1050) ────────────────────────────────────────────────

  /** Read the consultation's notices and emit the ones not delivered before. A failed read surfaces on `error`. */
  async #deliverHoldNotices(): Promise<void> {
    try {
      for (const notice of await this.guardrailNotices()) {
        if (this.#deliveredNoticeIds.has(notice.noticeId)) continue;
        this.#deliveredNoticeIds.add(notice.noticeId);
        this.#emit('guardrail-notice', notice);
      }
    } catch (error) {
      this.#emit('error', error);
    }
  }

  /**
   * `GET consultations/:id/guardrail-notices` — every guardrail notice this consultation raised, oldest first. Notices
   * carry no content and no judge reasoning; localise on `messageKey`. A notice with `requiresAcknowledgement` is
   * acknowledged by {@link acknowledgeNotice}, or atomically by {@link approve}.
   */
  async guardrailNotices(options: ConsultationHandleCallOptions = {}): Promise<GuardrailNotice[]> {
    const response = await this.#transport.request<GuardrailNotice[] | GuardrailNoticesResponse>({
      path: this.#path('/guardrail-notices'),
      signal: options.signal,
    });
    return Array.isArray(response) ? [...response] : [...(response?.notices ?? [])];
  }

  /**
   * `POST consultations/:id/guardrail-notices/:noticeId/ack` — the clinician acknowledges one warning. `If-Match` is the
   * version the handle last saw (a stale one is re-read and retried once, like the other verbs). To acknowledge every
   * outstanding warning while signing off, call {@link approve} with `acknowledgeGuardrailNotices` instead.
   */
  acknowledgeNotice(noticeId: string, options: ConsultationCommandOptions = {}): Promise<ConsultationState> {
    return this.#occCommand(`guardrail-notices/${encodePathSegment(noticeId)}/ack`, {}, options);
  }

  /**
   * `POST consultations/:id/guardrail-hold/resume` — resolve the hold a block put the consultation on, so processing
   * continues. `resolution`: `item_excluded` (leave the blocked items out), `item_edited` (the clinician corrected the
   * item; it is re-screened) or `acknowledged` (proceed once at warn weight, recorded as a safety override; not offered
   * for the locked medical check — see `notice.resumable`). Sends `If-Match`.
   */
  resumeHold(resolution: GuardrailHoldResolution, options: ConsultationCommandOptions = {}): Promise<ConsultationState> {
    return this.#occCommand('guardrail-hold/resume', { noticeId: resolution.noticeId, resolution: resolution.resolution }, options);
  }

  /**
   * Approve the note — the clinician's sign-off. `If-Match` is the handle's version; if it is stale
   * the handle re-reads once and retries.
   *
   * Guardrail (TASK-1050): approve is never refused because of warnings. `acknowledgeGuardrailNotices: true` says the
   * client showed them in its confirm step, and every outstanding warning on the approved items is acknowledged in the
   * approve transaction (the response lists them in `acknowledgedNotices`). `resolveHold` resolves an inbound hold
   * and approves in the same call.
   *
   * @throws ConflictError — 409 `CONSULTATION_PROCESSING_IN_FLIGHT` while the note is still being
   * produced, or a safety flag the call did not override.
   */
  approve(options: ApproveOptions & GuardrailApproveRequestAdditions = {}): Promise<ConsultationState & Partial<GuardrailApproveResponseAdditions>> {
    const body: Record<string, unknown> = {};
    if (options.clinicianUserId !== undefined) body.clinicianUserId = options.clinicianUserId;
    if (options.overrideSafetyFlag !== undefined) body.overrideSafetyFlag = options.overrideSafetyFlag;
    if (options.acknowledgeGuardrailNotices !== undefined) body.acknowledgeGuardrailNotices = options.acknowledgeGuardrailNotices;
    if (options.resolveHold !== undefined) body.resolveHold = { noticeId: options.resolveHold.noticeId, resolution: options.resolveHold.resolution };
    return this.#occCommand('approve', body, options);
  }

  /** Close the consultation (`CLOSED_COMPLETE` after approval, `CLOSED_INCOMPLETE` otherwise). */
  close(options: CloseOptions = {}): Promise<ConsultationState> {
    const body: Record<string, unknown> = {};
    if (options.clinicianUserId !== undefined) body.clinicianUserId = options.clinicianUserId;
    return this.#occCommand('close', body, options);
  }

  /** Reopen an auto-closed (or, where policy allows, closed) consultation. */
  reopen(options: ReopenOptions = {}): Promise<ConsultationState> {
    const body: Record<string, unknown> = {};
    if (options.reason !== undefined) body.reason = options.reason;
    if (options.clinicianUserId !== undefined) body.clinicianUserId = options.clinicianUserId;
    return this.#occCommand('reopen', body, options);
  }

  // ── summary ───────────────────────────────────────────────────────────────────────────────

  /**
   * Generate the note. Returns the queued job; with `wait: true` it waits for the job and also
   * returns the latest note. `sectionKeys` regenerates only those sections and carries the rest of
   * the note over into a new version. Rejected with 409 once the consultation is approved.
   */
  async generateSummary(options: GenerateSummaryOptions = {}): Promise<AsyncJobResponse & { summary?: ConsultationSummaryResponse | null }> {
    const request: Record<string, unknown> = {};
    if (options.outputLanguage !== undefined) request.outputLanguage = options.outputLanguage;
    if (options.sectionKeys !== undefined) request.sectionKeys = options.sectionKeys;
    const job = await this.#summaries.generateAsync(this.id, request, { signal: options.signal });
    if (!options.wait) return job;
    const finished = await this.#jobs.waitFor(job.jobId, { signal: options.signal, pollIntervalMs: options.pollIntervalMs });
    const summary =
      (finished.status as string).toLowerCase() === 'completed' ? await this.#summaries.latest(this.id, { signal: options.signal }) : undefined;
    return { ...job, status: (finished.status as string).toLowerCase() as AsyncJobResponse['status'], summary };
  }

  // ── attachments ───────────────────────────────────────────────────────────────────────────

  async #backoff(attempt: number, retryAfter: number | undefined): Promise<void> {
    const ceiling = Math.min(UPLOAD_MAX_DELAY_MS, UPLOAD_BASE_DELAY_MS * 2 ** attempt);
    await this.#sleep(retryAfter ?? Math.floor(this.#random() * ceiling));
  }

  async #putObject(intent: AttachmentIntentResponse, bytes: Uint8Array, signal?: AbortSignal): Promise<void> {
    const doFetch = this.#deps.fetch ?? globalThis.fetch.bind(globalThis);
    const headers = new Headers();
    for (const [name, value] of Object.entries(intent.uploadHeaders ?? {})) {
      const lower = name.toLowerCase();
      // The runtime computes the length, and the URL carries its own authorisation.
      if (lower === 'content-length' || lower === 'authorization' || lower === 'x-api-key') continue;
      headers.set(name, value);
    }
    let lastError: unknown;
    for (let attempt = 0; attempt < UPLOAD_MAX_ATTEMPTS; attempt += 1) {
      if (signal?.aborted) throw abortReason(signal);
      let retryAfter: number | undefined;
      try {
        const response = await doFetch(intent.uploadUrl as string, {
          method: intent.uploadMethod ?? 'PUT',
          headers,
          body: bytes as unknown as RequestInit['body'],
          signal,
        });
        if (response.ok) return;
        const retryable = response.status === 408 || response.status === 429 || (response.status >= 500 && response.status <= 599);
        lastError = new AttachmentUploadError(`Upload to object storage failed with HTTP ${response.status}.`, response.status);
        if (!retryable) throw lastError;
        retryAfter = retryAfterMs(response.headers.get('retry-after'));
      } catch (error) {
        if (error instanceof AttachmentUploadError && !(error.status === 408 || error.status === 429 || (error.status ?? 0) >= 500)) throw error;
        if (signal?.aborted) throw error;
        if (!(error instanceof AttachmentUploadError)) {
          lastError = new AttachmentUploadError(
            `Upload to object storage failed: ${error instanceof Error ? error.message : String(error)}`,
            undefined,
            { cause: error },
          );
        }
      }
      if (attempt < UPLOAD_MAX_ATTEMPTS - 1) await this.#backoff(attempt, retryAfter);
    }
    throw lastError;
  }

  async #complete(attachmentId: string, signal?: AbortSignal): Promise<AttachmentCompleteResponse> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.#transport.request<AttachmentCompleteResponse>({
          method: 'POST',
          path: this.#path(`/attachments/${encodePathSegment(attachmentId)}/complete`),
          body: {},
          hasIdempotencyKey: true,
          signal,
        });
      } catch (error) {
        const notYet = error instanceof ConflictError && error.code === 'ATTACHMENT_NOT_UPLOADED';
        if (!notYet || attempt >= COMPLETE_NOT_UPLOADED_RETRIES) throw error;
        await this.#backoff(attempt, undefined);
      }
    }
  }

  async #awaitReady(first: AttachmentCompleteResponse, options: SendAttachmentOptions): Promise<AttachmentCompleteResponse> {
    if (first.status === 'READY') return first;
    options.onProgress?.('processing', first.attachmentId);
    const interval = options.pollIntervalMs ?? 2_000;
    const deadline = Date.now() + (options.pollTimeoutMs ?? 300_000);
    for (;;) {
      if (options.signal?.aborted) throw abortReason(options.signal);
      const current = await this.#transport.request<Omit<AttachmentCompleteResponse, 'status'> & { status: string; failureCode?: string }>({
        path: this.#path(`/attachments/${encodePathSegment(first.attachmentId)}`),
        signal: options.signal,
      });
      if (current.status === 'READY') return current as AttachmentCompleteResponse;
      if (current.status === 'FAILED' || current.status === 'EXPIRED') {
        throw new AttachmentFailedError(first.attachmentId, current.status, current.failureCode);
      }
      if (Date.now() >= deadline) throw new Error(`Attachment ${first.attachmentId} is still processing after the polling window.`);
      await this.#sleep(interval);
    }
  }

  /**
   * Attach a file to the consultation: a document or image to read, audio to transcribe, or a case
   * note. The SDK hashes the bytes, asks the gateway for an upload, sends the bytes straight to
   * object storage (no HOPE credentials leave the SDK), and completes. When the gateway offers no
   * direct upload URL the file is posted to the gateway instead. Audio and large files are
   * processed after upload; the call waits for them (`onProgress` reports `processing`).
   *
   * Transient failures — 5xx, 429 and network errors — are retried with backoff and jitter, and a
   * `Retry-After` is honoured; any other 4xx fails at once. The whole upload carries one
   * `Idempotency-Key`, so a retried request never makes a second attachment.
   *
   * @throws AttachmentUploadError — object storage refused the upload.
   * @throws AttachmentFailedError — the gateway could not process the file.
   */
  async sendAttachment(input: AttachmentInput, options: SendAttachmentOptions = {}): Promise<AttachmentResult> {
    const { signal, onProgress } = options;
    onProgress?.('hashing');
    const bytes = await toBytes(input.data);
    const sha256 = input.sha256 ?? (await sha256Hex(bytes));
    const kind = input.kind === 'pdf' ? 'document' : input.kind;

    onProgress?.('intent');
    const body: Record<string, unknown> = { kind, mime: input.mime, sizeBytes: bytes.byteLength, sha256 };
    if (input.name !== undefined) body.fileName = input.name;
    if (options.purpose !== undefined) body.purpose = options.purpose;
    if (options.encounterSeq !== undefined) body.encounterSeq = options.encounterSeq;
    const intent = await this.#transport.request<AttachmentIntentResponse>({
      method: 'POST',
      path: this.#path('/attachments'),
      body,
      headers: { 'Idempotency-Key': options.idempotencyKey ?? generateUuidV7() },
      hasIdempotencyKey: true,
      signal,
    });

    let done: AttachmentCompleteResponse;
    if (intent.uploadUrl) {
      onProgress?.('uploading', intent.attachmentId);
      await this.#putObject(intent, bytes, signal);
      onProgress?.('completing', intent.attachmentId);
      done = await this.#complete(intent.attachmentId, signal);
    } else {
      onProgress?.('uploading', intent.attachmentId);
      const form = new FormData();
      form.append('file', new Blob([bytes as unknown as ArrayBuffer], { type: input.mime }), input.name ?? 'upload');
      done = await this.#transport.request<AttachmentCompleteResponse>({
        method: 'POST',
        path: this.#path(`/attachments/${encodePathSegment(intent.attachmentId)}/content`),
        body: form,
        hasIdempotencyKey: true,
        signal,
      });
    }
    const ready = await this.#awaitReady(done, options);
    onProgress?.('ready', intent.attachmentId);
    return ready;
  }

  // ── feedback ──────────────────────────────────────────────────────────────────────────────

  /**
   * Record feedback on the note, a section, a transcript segment or the whole visit: a thumbs
   * rating (with reason codes), a comment, or a corrected text (`edit`, alias `correction`), which
   * writes a new version of the target. Ratings and comments are accepted in every status; a
   * correction after approval is a 409. Files in `attachments` are uploaded first as evidence.
   * Each call carries its own `Idempotency-Key`, so a retried request records once.
   *
   * @throws TypeError — locally, for a rating or edit with no `target`, or an empty comment.
   * @throws ApiError 400 `FEEDBACK_REASON_UNKNOWN` — a reason code outside the effective list
   * (see {@link feedbackReasonCodes}).
   */
  async sendFeedback(input: FeedbackInput, options: ConsultationHandleCallOptions = {}): Promise<FeedbackResponse> {
    if ((input.kind === 'rating' || input.kind === 'edit' || input.kind === 'correction') && !input.target) {
      throw new TypeError(`sendFeedback: a \`${input.kind}\` needs a \`target\` — say which note, section or segment it is about.`);
    }
    if (input.kind === 'comment' && (typeof input.comment !== 'string' || input.comment.trim() === '')) {
      throw new TypeError('sendFeedback: a `comment` needs non-empty text.');
    }
    if ((input.kind === 'edit' || input.kind === 'correction') && typeof input.content !== 'string') {
      throw new TypeError(`sendFeedback: an \`${input.kind}\` needs the corrected \`content\`.`);
    }

    const attachmentIds = [...(input.attachmentIds ?? [])];
    for (const file of input.attachments ?? []) {
      const uploaded = await this.sendAttachment(file, { purpose: 'feedback', signal: options.signal });
      attachmentIds.push(uploaded.attachmentId);
    }

    const body: Record<string, unknown> = {};
    if (input.kind !== 'comment' || input.target) body.target = input.target;
    if (input.kind === 'rating') {
      body.rating = input.rating;
      if (input.reasonCodes !== undefined) body.reasonCodes = input.reasonCodes;
    }
    if (input.kind === 'edit' || input.kind === 'correction') {
      body.correction =
        input.expectedVersion === undefined ? { content: input.content } : { content: input.content, expectedVersion: input.expectedVersion };
    }
    if (input.comment !== undefined) body.comment = input.comment;
    if (attachmentIds.length > 0) body.attachmentIds = attachmentIds;
    if (input.client !== undefined) body.client = input.client;

    return this.#transport.request<FeedbackResponse>({
      method: 'POST',
      path: this.#path('/feedback'),
      body,
      headers: { 'Idempotency-Key': input.idempotencyKey ?? generateUuidV7() },
      hasIdempotencyKey: true,
      signal: options.signal,
    });
  }

  /** The reason codes a `down` rating may carry for this tenant (its own list, else the platform's). */
  async feedbackReasonCodes(options: ConsultationHandleCallOptions = {}): Promise<FeedbackReasonCodesResponse> {
    return this.#transport.request<FeedbackReasonCodesResponse>({ path: 'consultations/feedback/reason-codes', signal: options.signal });
  }

  // ── history ───────────────────────────────────────────────────────────────────────────────

  /**
   * One page of the consultation's history: transcript segments, notes, attachments, feedback and
   * lifecycle moments, oldest first, grouped by encounter. Pass `nextCursor` back as `cursor` for
   * the next page, or use {@link historyAll}.
   */
  async history(query: HistoryQuery = {}): Promise<ConsultationActivityPage> {
    return this.#transport.request<ConsultationActivityPage>({
      path: this.#path('/history'),
      query: {
        cursor: query.cursor,
        limit: query.limit,
        kinds: query.kinds?.join(','),
        encounterSeq: query.encounterSeq,
        edited: query.edited,
        grouping: query.grouping,
        include: query.include,
      },
      signal: query.signal,
    });
  }

  /** Every history entry matching `query`, following the cursor page by page. */
  async *historyAll(query: Omit<HistoryQuery, 'cursor'> = {}): AsyncGenerator<ActivityEntry, void, void> {
    let cursor: string | undefined;
    for (;;) {
      const page = await this.history({ ...query, cursor });
      for (const entry of page.items) yield entry;
      if (!page.hasMore || !page.nextCursor) return;
      cursor = page.nextCursor;
    }
  }

  /** The recap of one encounter (display-only text built from its facts). */
  async recap(encounterSeq: number, options: ConsultationHandleCallOptions = {}): Promise<EncounterRecap> {
    return this.#transport.request<EncounterRecap>({
      path: this.#path(`/encounters/${encodePathSegment(String(encounterSeq))}/recap`),
      signal: options.signal,
    });
  }

  /** The JSON the gateway returned at open, for logging or persistence. */
  toJSON(): Record<string, unknown> {
    const { status, processing, version } = this;
    const own = { ...(this as unknown as Record<string, unknown>) };
    return { ...own, status, processing, version };
  }
}
