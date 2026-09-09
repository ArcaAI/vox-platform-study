/**
 * `RealtimeSttSocket` — the Node client for HOPE's `/ws/stt/stream` protocol
 * (TASK-933, owner decision OD-2: the realtime socket lives in
 * `@arcaai/vox-node`).
 *
 * ## This is a socket client, not an audio pipeline
 *
 * `@arcaai/vox-node` has no audio PIPELINE and never will — no capture, no VAD,
 * no denoise, no model. That is the browser rule ("the browser never runs a
 * model") stated for the server: inference belongs to the tenant's published
 * ASR Agent, resolved by the gateway. What this class does is speak the wire
 * protocol: frame PCM16 up, decode transcripts down, and survive a drop.
 *
 * You bring PCM16 LE mono frames from wherever you already have them.
 *
 * ## Zero dependencies, which decides the runtime floor
 *
 * The socket is `globalThis.WebSocket` and nothing else — present in Node 22+,
 * Bun, Deno and edge runtimes. On a runtime without it this throws
 * {@link SocketUnavailableError} naming that floor rather than importing a
 * polyfill the integrator did not ask for. Same posture as `core/socket.ts`.
 *
 * ## Authentication: a ticket in the URL, never a credential
 *
 * The WS handshake carries `?sessionId=&ticket=`. The ticket is minted BY the
 * session routes (`createStreamSession` / `refreshTicket`), scoped
 * `stt_session:<sessionId>`, and SINGLE-USE — consumed at the first open. A
 * service-account token or a JWT never appears in this URL: a query string is
 * logged by every proxy on the path, which is the whole reason the ticket
 * exists.
 *
 * Because the ticket is single-use, EVERY reconnect needs a fresh one. This
 * class refreshes LAZILY — at the moment it needs a ticket, not on a background
 * timer — because a timer would mint tickets for a live socket that has already
 * consumed the only one it will ever use. Expiry is still honoured: a ticket
 * inside {@link RealtimeSttSocketOptions.refreshSkewMs} of `ticketExpiresAt` is
 * replaced before it is used.
 */

import { SocketUnavailableError } from './errors';
import type { SttErrorMessage, SttResumeFailedMessage, SttResumedMessage, SttStatusMessage, SttTranscriptResult } from '../types/stt';

/** The ticket-bearing subset of a stream session this class needs. */
export interface RealtimeSttSocketSession {
  sessionId: string;
  /** Single-use, consumed at the first WS open. */
  ticket: string;
  /** Epoch milliseconds. */
  ticketExpiresAt: number;
  /** Gateway-relative WS path. Defaults to `/ws/stt/stream`. */
  wsUrl?: string;
}

/** Why the socket closed. */
export interface RealtimeSttCloseEvent {
  /** WebSocket close code, when the runtime reported one. */
  code?: number;
  /** `true` when {@link RealtimeSttSocket.close} caused it. */
  requested: boolean;
  /** `true` when an automatic resume is about to be attempted. */
  resuming: boolean;
}

/** The event map. Every payload is the decoded server frame, verbatim. */
export interface RealtimeSttSocketEvents {
  transcript: SttTranscriptResult;
  status: SttStatusMessage;
  /**
   * A server `error` frame, a resume the server REFUSED
   * ({@link SttResumeFailedMessage} — a real transcript gap, not a retryable
   * hiccup), or a local failure that ended a reconnect attempt.
   */
  error: SttErrorMessage | SttResumeFailedMessage | Error;
  resumed: SttResumedMessage;
  close: RealtimeSttCloseEvent;
}

export type RealtimeSttEventName = keyof RealtimeSttSocketEvents;

/** Construction options. */
export interface RealtimeSttSocketOptions {
  /** The gateway origin, e.g. `http://localhost:8868`. A trailing `/api/v1` is stripped — the socket route is not under the API prefix. */
  baseUrl: string;
  session: RealtimeSttSocketSession;
  /**
   * Mint a fresh single-use ticket. Wired for you by
   * {@link SttResource.socket}; supply your own only when you are constructing
   * this class directly.
   *
   * WITHOUT it the socket can be opened exactly once and never resumed — the
   * ticket it was handed is consumed at that open, so there is nothing left to
   * reconnect with.
   */
  refreshTicket?: (sessionId: string) => Promise<{ ticket: string; ticketExpiresAt: number }>;
  /**
   * Sent as `?tenantId=` on the handshake. OPTIONAL and not an access control:
   * the gateway resolves tenancy from the TICKET. It exists for clients whose
   * own guard reads a tenant claim off the URL.
   */
  tenantId?: string;
  /**
   * Reconnect and re-handshake automatically after a close this client did not
   * ask for. Default `true` when {@link refreshTicket} is wired, and ignored
   * (there is nothing to reconnect with) when it is not.
   */
  autoResume?: boolean;
  /** Attempts made by one automatic resume before it gives up and emits `error`. Default `3`. */
  maxResumeAttempts?: number;
  /** Delay before each automatic resume attempt, in ms. Default `500`, multiplied by the attempt number. */
  resumeDelayMs?: number;
  /** A ticket within this many ms of expiry is replaced before use. Default `10_000`. */
  refreshSkewMs?: number;
  /** Injectable clock, for tests. */
  now?: () => number;
  /** Injectable sleep, for tests. */
  sleep?: (ms: number) => Promise<void>;
}

/** Minimal structural view of the platform `WebSocket` — only what this module uses. */
interface SocketLike {
  addEventListener(type: string, listener: (event: never) => void): void;
  send(data: string | ArrayBufferLike | ArrayBufferView): void;
  close(code?: number, reason?: string): void;
}

interface SocketConstructor {
  new (url: string): SocketLike;
}

const DEFAULT_WS_PATH = '/ws/stt/stream';
const DEFAULT_REFRESH_SKEW_MS = 10_000;
const DEFAULT_RESUME_ATTEMPTS = 3;
const DEFAULT_RESUME_DELAY_MS = 500;

/** Strip trailing slashes and a trailing `/api/v1`, then swap the scheme for its socket form. */
function socketOrigin(baseUrl: string): string {
  let base = baseUrl.trim().replace(/\/+$/, '');
  if (base.toLowerCase().endsWith('/api/v1')) base = base.slice(0, -'/api/v1'.length);
  const url = new URL(base);
  if (url.protocol === 'http:') url.protocol = 'ws:';
  else if (url.protocol === 'https:') url.protocol = 'wss:';
  return `${url.protocol}//${url.host}`;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * A live `/ws/stt/stream` connection for ONE streaming session.
 *
 * ```ts
 * const session = await hope.stt.createStreamSession({ consultationId });
 * const socket = hope.stt.socket(session);
 * socket.on('transcript', (t) => { if (t.isFinal) append(t.text); });
 * await socket.connect();
 * for await (const frame of pcm16Frames) socket.sendPcm16(frame);
 * socket.stop();   // finalize the utterance, session stays open
 * socket.close();  // end the session
 * ```
 */
export class RealtimeSttSocket {
  /** The session this socket streams for. */
  readonly sessionId: string;

  private readonly options: RealtimeSttSocketOptions;
  private readonly origin: string;
  private readonly path: string;
  private readonly listeners = new Map<RealtimeSttEventName, Set<(payload: never) => void>>();

  private socket: SocketLike | null = null;
  private ticket: string;
  private ticketExpiresAt: number;
  /** A ticket is consumed at the handshake — the next connect MUST mint another. */
  private ticketConsumed = false;
  private requestedClose = false;
  private resuming = false;
  private observedSeq = 0;

  constructor(options: RealtimeSttSocketOptions) {
    this.options = options;
    this.sessionId = options.session.sessionId;
    this.ticket = options.session.ticket;
    this.ticketExpiresAt = options.session.ticketExpiresAt;
    this.origin = socketOrigin(options.baseUrl);
    this.path = options.session.wsUrl?.trim() || DEFAULT_WS_PATH;
  }

  /** Highest transcript `seq` this socket has actually observed — what a resume asks to continue from. */
  get lastSeq(): number {
    return this.observedSeq;
  }

  /** `true` between a successful {@link connect} and the socket closing. */
  get connected(): boolean {
    return this.socket !== null;
  }

  /** Subscribe. Returns an unsubscribe function, so a caller need not keep the listener around to remove it. */
  on<E extends RealtimeSttEventName>(event: E, listener: (payload: RealtimeSttSocketEvents[E]) => void): () => void {
    const set = this.listeners.get(event) ?? new Set();
    set.add(listener as (payload: never) => void);
    this.listeners.set(event, set);
    return () => this.off(event, listener);
  }

  /** Unsubscribe a listener registered with {@link on}. */
  off<E extends RealtimeSttEventName>(event: E, listener: (payload: RealtimeSttSocketEvents[E]) => void): void {
    this.listeners.get(event)?.delete(listener as (payload: never) => void);
  }

  /**
   * Open the socket. Resolves once the handshake completes; rejects with
   * {@link SocketUnavailableError} on a runtime with no `WebSocket`, or with
   * whatever the ticket refresh threw.
   */
  async connect(): Promise<void> {
    this.requestedClose = false;
    await this.open();
  }

  /**
   * Send one PCM16 LE MONO frame, as a BINARY WebSocket frame.
   *
   * The gateway routes on the frame's binary flag — binary is audio, text is
   * control — so this needs no envelope and pays no base64 tax. Throws when the
   * socket is not open, rather than dropping audio into a closed connection,
   * which is unrecoverable and silent.
   */
  sendPcm16(frame: ArrayBuffer | ArrayBufferView): void {
    const socket = this.requireSocket();
    socket.send(frame);
  }

  /** Finalize the current utterance. The SESSION stays open — this is not a close. */
  stop(): void {
    this.requireSocket().send(JSON.stringify({ type: 'stop' }));
  }

  /**
   * End the session and close the socket.
   *
   * Sets the "the caller asked for this" flag first, so the close that follows
   * never triggers an automatic resume. The gateway finalizes upstream
   * immediately on `{type:'close'}` — there is no grace window.
   */
  close(): void {
    this.requestedClose = true;
    const socket = this.socket;
    if (!socket) return;
    try {
      socket.send(JSON.stringify({ type: 'close' }));
    } catch {
      // Already gone — closing is still the right next step.
    }
    socket.close(1000);
    this.socket = null;
  }

  /**
   * Reconnect on a FRESH ticket and send the resume handshake.
   *
   * `lastSeq` defaults to the highest transcript seq this socket observed. The
   * server replays everything above it and nothing at or below it; if the gap
   * has fallen out of its bounded buffer it answers `resume_failed`, which
   * arrives on the `error` event because a lost transcript span is a real
   * outcome, not a retryable hiccup.
   */
  async resume(lastSeq: number = this.observedSeq): Promise<void> {
    this.requestedClose = false;
    await this.open();
    this.requireSocket().send(JSON.stringify({ type: 'resume', sessionId: this.sessionId, lastSeq }));
  }

  // ---------------------------------------------------------------------------

  private requireSocket(): SocketLike {
    if (!this.socket) {
      throw new Error(`RealtimeSttSocket (session ${this.sessionId}) is not connected — call connect() (or resume()) before sending.`);
    }
    return this.socket;
  }

  private emit<E extends RealtimeSttEventName>(event: E, payload: RealtimeSttSocketEvents[E]): void {
    for (const listener of [...(this.listeners.get(event) ?? [])]) {
      (listener as (value: RealtimeSttSocketEvents[E]) => void)(payload);
    }
  }

  /** Replace the ticket when the one in hand is spent or about to expire. */
  private async ensureTicket(): Promise<void> {
    const now = (this.options.now ?? Date.now)();
    const skew = this.options.refreshSkewMs ?? DEFAULT_REFRESH_SKEW_MS;
    const stale = this.ticketConsumed || this.ticketExpiresAt - skew <= now;
    if (!stale) return;

    const refresh = this.options.refreshTicket;
    if (!refresh) {
      if (this.ticketConsumed) {
        throw new Error(
          `RealtimeSttSocket (session ${this.sessionId}) cannot reconnect: its stream ticket was consumed by the first handshake and no ` +
            '`refreshTicket` was wired. Construct it through `hope.stt.socket(session)`, which wires one.',
        );
      }
      return;
    }

    const next = await refresh(this.sessionId);
    this.ticket = next.ticket;
    this.ticketExpiresAt = next.ticketExpiresAt;
    this.ticketConsumed = false;
  }

  private buildUrl(): string {
    const url = new URL(this.path, `${this.origin}/`);
    url.searchParams.set('sessionId', this.sessionId);
    url.searchParams.set('ticket', this.ticket);
    if (this.options.tenantId) url.searchParams.set('tenantId', this.options.tenantId);
    return url.toString();
  }

  private async open(): Promise<void> {
    const Socket = (globalThis as { WebSocket?: SocketConstructor }).WebSocket;
    if (typeof Socket !== 'function') {
      throw new SocketUnavailableError(
        'The realtime STT socket (`hope.stt.socket`)',
        'Upgrade the runtime — `/ws/stt/stream` is a socket protocol and has no SSE alternative. For pre-recorded audio, submit a BATCH transcription instead (`hope.agents.transcribe`).',
      );
    }

    await this.ensureTicket();

    const socket = new Socket(this.buildUrl());
    this.ticketConsumed = true;

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      socket.addEventListener('open', (() => {
        if (settled) return;
        settled = true;
        this.socket = socket;
        this.attach(socket);
        resolve();
      }) as (event: never) => void);
      socket.addEventListener('error', (() => {
        if (settled) return;
        settled = true;
        reject(new Error(`RealtimeSttSocket (session ${this.sessionId}) failed to open. The stream ticket is single-use and short-lived.`));
      }) as (event: never) => void);
      socket.addEventListener('close', ((event: { code?: number }) => {
        if (settled) return;
        settled = true;
        reject(new Error(`RealtimeSttSocket (session ${this.sessionId}) was closed during the handshake (code ${event?.code ?? 'unknown'}).`));
      }) as (event: never) => void);
    });
  }

  private attach(socket: SocketLike): void {
    socket.addEventListener('message', ((event: { data: unknown }) => this.handleMessage(event.data)) as (event: never) => void);
    socket.addEventListener('error', (() => {
      // A transport-level error on a live socket. The `close` that follows is
      // what decides whether we resume, so this only reports.
      this.emit('error', new Error(`RealtimeSttSocket (session ${this.sessionId}) reported a transport error.`));
    }) as (event: never) => void);
    socket.addEventListener('close', ((event: { code?: number }) => {
      if (this.socket !== socket) return;
      this.socket = null;
      const resuming = this.shouldAutoResume();
      this.emit('close', { code: event?.code, requested: this.requestedClose, resuming });
      if (resuming) void this.autoResume();
    }) as (event: never) => void);
  }

  private shouldAutoResume(): boolean {
    if (this.requestedClose || this.resuming) return false;
    if (!this.options.refreshTicket) return false;
    return this.options.autoResume !== false;
  }

  private async autoResume(): Promise<void> {
    this.resuming = true;
    const attempts = this.options.maxResumeAttempts ?? DEFAULT_RESUME_ATTEMPTS;
    const delay = this.options.resumeDelayMs ?? DEFAULT_RESUME_DELAY_MS;
    const sleep = this.options.sleep ?? defaultSleep;

    try {
      for (let attempt = 1; attempt <= attempts; attempt++) {
        if (this.requestedClose) return;
        try {
          await sleep(delay * attempt);
          if (this.requestedClose) return;
          await this.resume();
          return;
        } catch (error) {
          if (attempt === attempts) {
            this.emit(
              'error',
              error instanceof Error
                ? error
                : new Error(`RealtimeSttSocket (session ${this.sessionId}) could not be resumed after ${attempts} attempts.`),
            );
          }
        }
      }
    } finally {
      this.resuming = false;
    }
  }

  private handleMessage(data: unknown): void {
    if (typeof data !== 'string') return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      // One unreadable frame must not kill a stream whose remaining frames are
      // fine — the same rule `core/socket.ts` and the SSE lane both follow.
      return;
    }
    if (typeof parsed !== 'object' || parsed === null) return;
    const message = parsed as { type?: unknown; seq?: unknown };

    switch (message.type) {
      case 'transcript':
      case 'segment':
      case 'gloss': {
        const transcript = parsed as SttTranscriptResult;
        if (typeof transcript.seq === 'number' && transcript.seq > this.observedSeq) this.observedSeq = transcript.seq;
        this.emit('transcript', transcript);
        return;
      }
      case 'status':
        this.emit('status', parsed as SttStatusMessage);
        return;
      case 'error':
        this.emit('error', parsed as SttErrorMessage);
        return;
      case 'resumed':
        this.emit('resumed', parsed as SttResumedMessage);
        return;
      case 'resume_failed':
        this.emit('error', parsed as SttResumeFailedMessage);
        return;
      default:
        // A not-yet-modelled server frame. Silently ignored rather than
        // surfaced as an error: the wire contract is additive by design.
        return;
    }
  }
}
