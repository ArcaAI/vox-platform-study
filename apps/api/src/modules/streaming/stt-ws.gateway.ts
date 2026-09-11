import {
  IOriginRegistry,
  ISocketRegistryService,
  StreamingAudioBridgeService,
  StreamingSessionService,
  type TraceCarrier,
  extractTraceCarrier,
  injectTraceCarrier,
} from '@arcaai/applications';
import { Inject, Logger, Optional, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { OnGatewayConnection, OnGatewayDisconnect, WebSocketGateway, WebSocketServer } from '@nestjs/websockets';
import { type Span, SpanKind, context, trace } from '@opentelemetry/api';
import type { IncomingMessage } from 'http';
import type { Subscription } from 'rxjs';
import type WebSocket from 'ws';
import type { Server } from 'ws';
import { type StreamSessionBinding, StreamSessionTenantBindingService } from '../../common';
import { isOriginEnforcementEnabled } from '../../cors.config';
import { StreamTicketService } from '../auth/stream-ticket.service';
import { SessionRemovalRetryService } from './session-removal-retry.service';

/**
 * STT WebSocket handshake-rejection close codes.
 *
 * A per-cause code (e.g. `4001 missing param` for sessionId / ticket vs.
 * `4401 invalid ticket`) would give a probing client an enumeration
 * signal: it could tell apart a valid sessionId from an invalid one
 * based on which 4xxx code came back.
 *
 * All handshake-failure paths therefore collapse to a single generic
 * `4401 Authentication failed` over the wire. The real reason for the
 * failure still flows into the server-side warn log so SRE dashboards
 * remain useful.
 *
 * 4401 — handshake failure (any cause)
 * 4409 — the session's OWNER resumed it on another socket (this socket is
 *        superseded). NOT a handshake-failure signal: it is only ever sent to
 *        a socket that already proved ownership, so it leaks nothing an
 *        attacker could probe — and it exists precisely so a takeover is never
 *        silent.
 * 1011 — internal error (resume buffer corruption etc.)
 */
export const WS_CLOSE_CODES = {
  AUTH_FAILED: 4401,
  SESSION_SUPERSEDED: 4409,
} as const;

/**
 * The literal that goes onto the wire when we close a handshake.
 * Identical for every failure cause so it cannot be used to enumerate
 * sessions, tickets, or scope mismatches.
 */
export const WS_GENERIC_AUTH_REASON = 'Authentication failed';

/**
 * Reason sent to a socket displaced by its OWN user resuming the session
 * elsewhere. Unlike {@link WS_GENERIC_AUTH_REASON} this may be specific: the
 * recipient already proved it owns the session.
 */
export const WS_SESSION_SUPERSEDED_REASON = 'Session resumed elsewhere';

/**
 * Bounded per-session transcript replay buffer.
 *
 * The gateway keeps the last `RESUME_BUFFER_SIZE` transcript messages for
 * every active session so that a brief disconnect (≤ buffer window) can be
 * resumed without dropping transcripts. Bound is per-session to cap total
 * memory at ~`activeSessions × RESUME_BUFFER_SIZE × avg msg size`.
 */
export const RESUME_BUFFER_SIZE = 200;

/**
 * Fallback when no session meta was bound (legacy clients / Redis blip at
 * handshake). Matches the historical hardcoded rate.
 */
export const DEFAULT_SAMPLE_RATE = 16000;

/**
 * WS egress backpressure threshold. When the client
 * socket's `bufferedAmount` exceeds this many bytes, partial transcripts are
 * dropped and final transcripts are queued until the socket drains.
 * Default 512 KiB; overridable via `STT_WS_EGRESS_HIGH_WATERMARK_BYTES`.
 */
export const WS_EGRESS_HIGH_WATERMARK_BYTES = (() => {
  const raw = Number(process.env.STT_WS_EGRESS_HIGH_WATERMARK_BYTES);
  return Number.isFinite(raw) && raw > 0 ? raw : 512 * 1024;
})();

/**
 * Bound on the per-session queue of finals awaiting a
 * socket drain. On overflow the OLDEST queued final is dropped with an error
 * log (never silently); the resume buffer still holds it for
 * the reconnect-replay path.
 */
export const WS_EGRESS_FINAL_QUEUE_LIMIT = 200;

/**
 * Drain-poll cadence for flushing queued finals. The
 * `ws` library exposes no drain event on its WebSocket wrapper, so we poll
 * `bufferedAmount` while (and only while) finals are queued.
 */
export const WS_EGRESS_FLUSH_POLL_MS = 50;

/**
 * Resume grace window. On a TRANSIENT socket drop the gateway
 * keeps the session (its resume buffer, seq counter, and upstream STT-v2
 * session) alive for this long so the SAME session can reconnect and continue
 * without a duplicate flood or a silent freeze. Only when the window expires
 * with no reconnect is the upstream finalized. Overridable via
 * `STT_WS_RESUME_GRACE_MS`; default 15s.
 */
export const WS_RESUME_GRACE_MS = (() => {
  const raw = Number(process.env.STT_WS_RESUME_GRACE_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 15_000;
})();

/**
 * Stable consumer-group name the gateway uses when subscribing
 * to `stt:result:{sessionId}`. Being stable per session (the stream is already
 * per-session) means the bridge resumes from the group's Redis-owned cursor on
 * a re-subscription rather than re-reading from `0-0`. Distinct from the
 * LiveDocumentationService reader's (default, unique) group, so both still
 * receive every result (fan-out preserved).
 */
export const WS_RESULT_CONSUMER_GROUP = 'captions';

/** Buffered transcript ready for replay. */
interface BufferedTranscript {
  seq: number;
  msg: { type: string; seq?: number; [key: string]: unknown };
}

interface SessionInfo {
  sessionId: string;
  /**
   * The CURRENT client socket. Mutable: on a reconnect within the grace window
   * the session is rebound to the new socket, so every send
   * path reads `session.client` rather than a captured socket.
   */
  client: WebSocket;
  connectedAt: Date;
  binarySeq: number;
  /** Server-assigned monotonic transcript seq. */
  resultSeq: number;
  /** Last N transcripts retained for replay. */
  resumeBuffer: BufferedTranscript[];
  /** User id from the consumed stream ticket. */
  userId: string;
  /** Tenant id from the consumed stream ticket. */
  tenantId: string | null;
  /**
   * Session-negotiated audio sample rate, read from the session meta bound
   * by `createStreamSession`. Defaults to 16000.
   */
  sampleRate: number;
  /**
   * TASK-951 R2 (D-8) — the client-declared session context, read from the SAME meta record as
   * `sampleRate` at handshake and never re-read. Attached to every transcript this session
   * relays. Undefined for a session that declared none, which is what keeps that session's wire
   * byte-identical to the pre-TASK-951 contract.
   */
  streamContext?: Record<string, unknown>;
  /** TASK-951 R2 — the session's creation epoch (ms), from the same meta record. */
  sessionEpochMs?: number;
  /** Frames whose async Redis write failed. */
  droppedAudioFrames: number;
  /** Partials dropped because the WS egress buffer was over the threshold. */
  droppedPartialResults: number;
  /**
   * Has the client been TOLD about the current partial-drop episode?
   *
   * Coalesces the signal to one frame per episode: partials drop at speech
   * cadence, so a frame per drop would add to the very congestion the drop is
   * relieving. Cleared when the socket drains, so a later episode signals again.
   */
  partialDropSignalled: boolean;
  /** Finals dropped because the bounded egress queue overflowed. */
  droppedFinalResults: number;
  /** Finals awaiting delivery while the socket drains. */
  pendingFinalResults: Array<{ type: string; [key: string]: unknown }>;
  /** Poll timer that flushes `pendingFinalResults` once the socket drains. */
  egressFlushTimer?: ReturnType<typeof setInterval>;
  resultSubscription?: Subscription;
  /**
   * Grace-window timer armed on a transient disconnect. If the
   * same session reconnects before it fires the timer is cleared and the
   * session continues; otherwise the upstream is finalized. Undefined while the
   * socket is connected.
   */
  graceTimer?: ReturnType<typeof setTimeout>;
  /**
   * True once the session is being torn down for real (explicit `close`, or a
   * grace window that expired). Guards against a late disconnect re-arming the
   * grace window after finalize.
   */
  finalizing?: boolean;
  /**
   * True for a session built by the fresh-connect path (no prior `SessionInfo`
   * existed at handshake), false once a grace-window `rebindSession` genuinely
   * CONTINUES a prior session. A `resume` handshake on a freshly-created session
   * cannot be honored — the prior session (and its upstream STT-v2 session) is
   * gone (grace expired) or was never here (cross-instance). Answering such a
   * resume with a vacuous `resumed` (empty buffer passes the length guard) let
   * the client believe it resumed while the mic captured into a dead session
   * with no error anywhere. See `handleResume`.
   */
  freshlyCreated?: boolean;
  /**
   * The session-scoped trace span. A streaming session is
   * ONE logical operation lasting the length of a consultation, so it gets one
   * span, ended in `finalizeSession`. `undefined` when tracing is disabled —
   * `trace.getTracer()` then hands back a no-op tracer whose spans have an
   * invalid span context, which is exactly what makes {@link traceCarrier}
   * empty and the whole path free.
   */
  traceSpan?: Span;
  /**
   * The session's W3C carrier, derived ONCE from {@link traceSpan}. Handed to
   * every audio frame so the hot path never runs a propagator. `{}` when
   * tracing is off.
   */
  traceCarrier: TraceCarrier;
}

@WebSocketGateway({ path: '/ws/stt/stream' })
export class SttWsGateway implements OnGatewayConnection, OnGatewayDisconnect, OnModuleInit, OnModuleDestroy {
  @WebSocketServer()
  server!: Server;

  private readonly logger = new Logger(SttWsGateway.name);
  private readonly sessions = new Map<WebSocket, SessionInfo>();
  /**
   * Resume state keyed by `sessionId` (not per-socket), so a
   * reconnect within the grace window finds the SAME `SessionInfo` (its resume
   * buffer + seq + live result subscription) and rebinds to the new socket
   * instead of building a fresh, empty one that re-reads from `0-0`.
   */
  private readonly sessionsById = new Map<string, SessionInfo>();
  /**
   * Republishes this instance's live-socket count so the
   * per-instance Redis key never expires between connect/disconnect bursts (key
   * TTL is 45s in `SocketRegistryService`). Cleared on module destroy.
   */
  private socketHeartbeat?: ReturnType<typeof setInterval>;

  constructor(
    private readonly sessionService: StreamingSessionService,
    private readonly bridgeService: StreamingAudioBridgeService,
    private readonly streamTicketService: StreamTicketService,
    // Reads the session meta (negotiated sampleRate)
    // bound by `createStreamSession`.
    private readonly sessionBinding: StreamSessionTenantBindingService,
    // Retries failed upstream session removals
    // with backoff so STT-v2 sessions are not leaked on disconnect.
    private readonly removalRetry: SessionRemovalRetryService,
    // Publishes this instance's open-socket count to Redis
    // for the platform-metrics aggregate. Optional so the gateway still boots
    // in stacks that don't wire the platform-metrics module (best-effort).
    @Optional()
    @Inject(ISocketRegistryService)
    private readonly socketRegistry?: ISocketRegistryService,
    // CSWSH guard: registry-backed allow-list for the
    // `Origin` header, the same reverse index `cors.config.ts` consults.
    // Optional so the gateway still boots in stacks that don't wire
    // `OriginRegistryServiceModule` — see `isOriginAllowed` for the
    // bootstrap-fallback posture when it's absent or fails.
    @Optional()
    @Inject(IOriginRegistry)
    private readonly originRegistry?: IOriginRegistry,
  ) {}

  onModuleInit(): void {
    // Publish an initial 0 immediately, then refresh on a cadence well under the
    // 45s key TTL so a live instance never expires between socket events.
    this.publishSocketCount();
    this.socketHeartbeat = setInterval(() => this.publishSocketCount(), 20_000);
    // Don't keep the event loop alive for the heartbeat alone.
    this.socketHeartbeat.unref?.();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.socketHeartbeat) {
      clearInterval(this.socketHeartbeat);
      this.socketHeartbeat = undefined;
    }
    // On SIGTERM / rolling deploy, best-effort FINALIZE every
    // live + in-grace session so the upstream STT-v2 sessions (and their
    // capacity slots) are not orphaned until the STT-v2 reaper. Clear timers,
    // unsubscribe, and DELETE the upstream session; bounded-await the removals
    // so a deploy tidies up without hanging shutdown.
    const removals: Array<Promise<unknown>> = [];
    for (const session of [...this.sessionsById.values()]) {
      if (session.graceTimer) {
        clearTimeout(session.graceTimer);
        session.graceTimer = undefined;
      }
      if (session.egressFlushTimer) {
        clearInterval(session.egressFlushTimer);
        session.egressFlushTimer = undefined;
      }
      if (session.finalizing) continue;
      session.finalizing = true;
      session.resultSubscription?.unsubscribe();
      this.bridgeService.unsubscribeFromResults(session.sessionId);
      // Match finalizeSession: drop the tenant binding so no ticket can be
      // minted against the session we're finalizing on shutdown (F-36).
      void this.sessionBinding.clear(session.sessionId);
      // A SIGTERM/rolling-deploy teardown is always an
      // abort: no client-driven close was ever received for these sessions.
      removals.push(this.sessionService.removeSession(session.sessionId, true, session.tenantId).catch(() => {}));
    }
    this.sessions.clear();
    this.sessionsById.clear();
    if (removals.length > 0) {
      // Bounded so shutdown never hangs on a slow/unreachable STT-v2.
      await Promise.race([Promise.allSettled(removals), new Promise((resolve) => setTimeout(resolve, 5_000))]);
    }
  }

  /**
   * Best-effort publish of THIS instance's live-socket count
   * to the Redis registry. Never throws: a Redis blip must not affect the WS
   * data path.
   *
   * Also publishes the per-tenant breakdown so the
   * entitlements concurrency gate can compare a tenant's live active sessions
   * against `maxConcurrentSessions` across a horizontally-scaled deployment.
   */
  private publishSocketCount(): void {
    void this.socketRegistry?.publishLocalCount(this.getActiveSessionCount()).catch((err) => {
      this.logger.debug({
        message: 'Failed to publish open-socket count',
        error: err instanceof Error ? err.message : String(err),
      });
    });
    void this.socketRegistry?.publishLocalTenantCounts(this.getPerTenantSessionCounts()).catch((err) => {
      this.logger.debug({
        message: 'Failed to publish per-tenant open-socket counts',
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }

  /**
   * THIS instance's live open-socket count grouped by
   * tenant. Null-tenant sessions (legacy/system) are excluded: they are ungated
   * and must not consume any tenant's concurrency budget.
   */
  private getPerTenantSessionCounts(): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const session of this.sessions.values()) {
      const tenantId = session.tenantId;
      if (!tenantId) continue;
      counts[tenantId] = (counts[tenantId] ?? 0) + 1;
    }
    return counts;
  }

  /**
   * Registry lookup backing the CSWSH guard. Fails
   * CLOSED on an unavailable registry (absent / empty / throwing) — DENY,
   * with the same distinct, greppable `origin_registry_unavailable` reason
   * `cors.config.ts` uses, kept separate from the ordinary
   * `origin_registry_miss` a populated registry's "no" produces.
   * `IOriginRegistry.has()` is documented to never throw on malformed input;
   * the try/catch is defense-in-depth against an unexpected registry failure
   * rather than the expected path.
   *
   * A registry that is PRESENT but EMPTY (`size() === 0` — unseeded table, or
   * every row deleted) is treated the SAME as an absent one: it "has nothing
   * to say", so this DENIES exactly like `has()` would for every origin —
   * the two paths just log under the systemic reason rather than an ordinary
   * per-origin miss (see `PlatformKnobsBinder.installOriginRegistryResolver`
   * for why that distinction is kept on the HTTP side).
   *
   * THIS IS DELIBERATELY ALIGNED WITH THE HTTP CORS PATH (`cors.config.ts`),
   * not merely mirrored. An earlier revision of this method kept fail-OPEN
   * here on the theory that severing a live transcription session
   * mid-consultation is worse than a page failing to load. That reasoning
   * does not survive contact with how a WS connection is actually obtained:
   * `handleConnection` requires a single-use `ticket` (below), and the ONLY
   * way a browser client ever gets one is a prior HTTP round trip to THIS
   * gateway — `POST .../stream/session` or `POST .../stream/session/:id/
   * refresh-ticket` (`transcription-job.controller.ts`), both ordinary Nest
   * HTTP routes sitting behind the SAME CORS gate that now denies during a
   * registry outage. So during exactly the outage this method used to stay
   * open for, no legitimate browser client can reach this handshake at all —
   * it never obtained a ticket. Fail-open bought nothing operationally while
   * leaving open the one surface CORS cannot cover at all (browsers exempt
   * WS from CORS entirely, D-6) — the actual cross-site WebSocket hijacking
   * vector. Aligning the two paths closes that gap and gives an operator ONE
   * consistent pair of log reasons across both.
   *
   * (Established sockets are unaffected either way — this check runs only in
   * `handleConnection`, on the initial handshake, never against a live
   * session.)
   */
  private isOriginAllowed(origin: string): boolean {
    // , default reversed by — origin enforcement is
    // now ON BY DEFAULT (`origin.enforcementEnabled` defaults `true`), so this
    // CSWSH check is LIVE unless an operator turned the switch off (or the
    // process has not yet installed the resolver — the pre-boot window; see
    // `cors.config.ts`). While it IS off the handshake accepts every origin and
    // the registry is never consulted. The switch is READ from `cors.config.ts`
    // rather than resolved here, so the WS gate can never disagree with the HTTP
    // gate about whether enforcement is on (: the rule lives in ONE place).
    //
    // calls this out as the surface that would concern us most if
    // `credentials` were ever set back to `true` — browsers exempt WebSockets
    // from CORS entirely, so nothing upstream checks `Origin` here. That is
    // precisely why `credentials: false` ships in the same change
    // (`buildCorsOptions`): with no ambient cookies attached cross-origin,
    // a hostile page's socket carries no credentials to hijack.
    if (!isOriginEnforcementEnabled()) {
      return true;
    }

    if (!this.originRegistry) {
      this.logger.warn({
        message: 'WS handshake — origin registry unavailable, denying (§4A.1: no bootstrap fallback, aligned with the HTTP CORS path)',
        origin,
        reason: 'origin_registry_unavailable',
      });
      return false;
    }
    try {
      if (this.originRegistry.size() === 0) {
        this.logger.warn({
          message: 'WS handshake — origin registry empty, denying (§4A.1: no bootstrap fallback, aligned with the HTTP CORS path)',
          origin,
          reason: 'origin_registry_unavailable',
        });
        return false;
      }
      const registered = this.originRegistry.has(origin);
      if (!registered) {
        this.logger.warn({
          message: 'WS handshake — origin not registered',
          origin,
          reason: 'origin_registry_miss',
        });
      }
      return registered;
    } catch (err) {
      this.logger.warn({
        message: 'WS handshake — origin registry lookup failed, denying (§4A.1: no bootstrap fallback, aligned with the HTTP CORS path)',
        origin,
        reason: 'origin_registry_unavailable',
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }

  async handleConnection(client: WebSocket, req: IncomingMessage): Promise<void> {
    // CSWSH guard. Browsers do not apply CORS to the
    // WebSocket handshake, so — unlike every other route behind this
    // gateway — nothing upstream has already checked `Origin`. Checked
    // FIRST, before sessionId/ticket parsing, mirroring the CORS callback's
    // pre-auth position in the architecture: it is a
    // browser-facing, advisory check, not the tenant-isolation control.
    //
    // No `Origin` header → ALLOW. A missing header means a non-browser
    // caller (server-to-server, CLI, the resume/reconnect path from a
    // trusted internal tool) — CSWSH is specifically an attack that rides a
    // VICTIM BROWSER's ambient credentials via an auto-attached `Origin`
    // header, so a request with no `Origin` cannot be that attack. This
    // mirrors the HTTP CORS posture, which also allows no-Origin through.
    const origin = req.headers?.origin;
    if (typeof origin === 'string' && origin.length > 0 && !this.isOriginAllowed(origin)) {
      this.logger.warn({
        message: 'WS handshake rejected — unregistered origin (D-6, cross-site WebSocket hijacking guard)',
        origin,
      });
      client.close(WS_CLOSE_CODES.AUTH_FAILED, WS_GENERIC_AUTH_REASON);
      return;
    }

    const url = new URL(req.url || '', 'http://localhost');
    const sessionId = url.searchParams.get('sessionId');
    const ticket = url.searchParams.get('ticket');

    // Auth gate runs BEFORE we register
    // the session or subscribe to the result stream, and every
    // rejection path closes with the SAME generic (code, reason) so
    // the client cannot enumerate sessions / tickets / scopes by
    // probing. The real cause goes to the warn log.
    if (!sessionId) {
      this.logger.warn({
        message: 'WS handshake rejected — missing sessionId',
      });
      client.close(WS_CLOSE_CODES.AUTH_FAILED, WS_GENERIC_AUTH_REASON);
      return;
    }

    if (!ticket) {
      this.logger.warn({
        message: 'WS handshake rejected — missing ticket',
        sessionId,
      });
      client.close(WS_CLOSE_CODES.AUTH_FAILED, WS_GENERIC_AUTH_REASON);
      return;
    }

    const stored = await this.streamTicketService.consumeTicket(ticket);
    if (!stored) {
      this.logger.warn({
        message: 'WS handshake rejected — invalid stream ticket',
        sessionId,
      });
      client.close(WS_CLOSE_CODES.AUTH_FAILED, WS_GENERIC_AUTH_REASON);
      return;
    }

    const expectedScope = `stt_session:${sessionId}`;
    if (stored.scope !== expectedScope) {
      this.logger.warn({
        message: 'WS handshake rejected — ticket scope mismatch',
        sessionId,
        expectedScope,
        actualScope: stored.scope,
      });
      client.close(WS_CLOSE_CODES.AUTH_FAILED, WS_GENERIC_AUTH_REASON);
      return;
    }

    // The scope string above only proves the ticket was
    // minted FOR this sessionId, not that the minting caller OWNS the
    // session. Verify the ticket against the session's owning tenant AND
    // owning user (the gateway-side binding written at session create),
    // mirroring the `StreamSession` interceptor branch. Missing binding,
    // tenant mismatch, owner mismatch, an ownerless (legacy) binding, and a
    // lookup failure all reject fail-closed with the same generic close — no
    // enumeration signal, and no tenant/user ids in the log.
    //
    // The OWNER half is what closes the same-tenant hijack: the tenant check
    // alone let any colleague who learned a sessionId connect and have the
    // live audio-ingest + transcript stream transplanted onto their socket.
    let binding: StreamSessionBinding | null = null;
    try {
      binding = await this.sessionBinding.lookupBinding(sessionId);
    } catch (err) {
      this.logger.warn({
        message: 'WS handshake — session binding lookup failed (fail-closed)',
        sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    if (binding === null || binding.tenantId !== stored.tenantId) {
      this.logger.warn({
        message: 'WS handshake rejected — session tenant binding missing or mismatched',
        sessionId,
      });
      client.close(WS_CLOSE_CODES.AUTH_FAILED, WS_GENERIC_AUTH_REASON);
      return;
    }
    if (!binding.userId || binding.userId !== stored.userId) {
      this.logger.warn({
        message: 'WS handshake rejected — ticket user is not the session owner (same-tenant hijack attempt or legacy ownerless binding)',
        sessionId,
      });
      client.close(WS_CLOSE_CODES.AUTH_FAILED, WS_GENERIC_AUTH_REASON);
      return;
    }

    // Read the negotiated sampleRate bound at session
    // creation. Best-effort: a missing/corrupt record or a Redis blip falls
    // back to the historical 16000 and never rejects the handshake.
    let sampleRate: number = DEFAULT_SAMPLE_RATE;
    // TASK-951 R2 — the per-session echo comes off the same one read. A failed/absent meta read
    // leaves both undefined: the session still transcribes, it just echoes nothing, which is the
    // same graceful posture the sampleRate fallback already takes.
    let streamContext: Record<string, unknown> | undefined;
    let sessionEpochMs: number | undefined;
    try {
      const meta = await this.sessionBinding.lookupSessionMeta(sessionId);
      if (meta) {
        sampleRate = meta.sampleRate;
        streamContext = meta.context;
        sessionEpochMs = meta.sessionEpochMs;
      }
    } catch (err) {
      this.logger.warn({
        message: 'Session meta lookup failed — defaulting sampleRate',
        sessionId,
        sampleRate,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // RECONNECT within the grace window: a prior transient
    // drop kept this session (its resume buffer, seq, and live result
    // subscription) alive. Rebind it to the NEW socket instead of building a
    // fresh, empty one that re-reads from 0-0. The client then sends the
    // resume handshake to replay anything it missed.
    const existing = this.sessionsById.get(sessionId);
    if (existing) {
      this.rebindSession(existing, client, stored);
      return;
    }

    // Root (or continue) this session's trace. Started only AFTER every
    // handshake gate has passed, so a rejected/probing connection can never
    // create telemetry — and never a span this code would then have to
    // remember to end.
    const { span: traceSpan, carrier: traceCarrier } = this.startSessionTrace(sessionId, req);

    const session: SessionInfo = {
      sessionId,
      client,
      traceSpan,
      traceCarrier,
      connectedAt: new Date(),
      binarySeq: 0,
      resultSeq: 0,
      resumeBuffer: [],
      userId: stored.userId,
      tenantId: stored.tenantId,
      sampleRate,
      ...(streamContext ? { streamContext } : {}),
      ...(sessionEpochMs != null ? { sessionEpochMs } : {}),
      droppedAudioFrames: 0,
      droppedPartialResults: 0,
      partialDropSignalled: false,
      droppedFinalResults: 0,
      pendingFinalResults: [],
      // No prior SessionInfo existed → this is NOT a continuation; a later
      // resume handshake on it must be rejected (F-06).
      freshlyCreated: true,
    };

    this.sessions.set(client, session);
    this.sessionsById.set(sessionId, session);
    // Refresh the multi-instance open-socket aggregate.
    this.publishSocketCount();

    this.logger.log({
      message: 'WebSocket client connected',
      sessionId,
      userId: stored.userId,
      tenantId: stored.tenantId,
      activeSessions: this.sessions.size,
    });

    this.attachMessageHandler(client, sessionId);

    // Subscribe to results ONLY after the ticket gate passes.
    this.subscribeSessionResults(session);

    // The async auth/lookup awaits above mean a client that
    // sends resume/audio the instant its socket opens would race registration
    // (NO_SESSION → dropped resume → silent freeze). Emit an explicit readiness
    // ack AFTER registration + subscription so the client gates its first
    // resume/audio on it (a deterministic gate, not a timing guess).
    this.sendReady(session);
  }

  /**
   * Root the trace for one streaming session.
   *
   * WHY THE GATEWAY AND NOT AUTO-INSTRUMENTATION
   * `@opentelemetry/instrumentation-http` patches the HTTP server's `request`
   * event; a WebSocket handshake arrives on `upgrade` and is never seen by it.
   * So a streaming session begins with NO active span, and every span it
   * subsequently caused (Redis writes, the STT worker's per-utterance work, the
   * result relay) was an orphan. This is the seam that fixes that.
   *
   * PARENTING
   * A `traceparent` on the upgrade request is honoured — non-browser callers
   * (server-to-server, the Node SDK, an ingress that injects one) can hand us
   * their trace. Browsers cannot set headers on a WebSocket handshake, so the
   * common case is a NEW root span. Either way the session gets a real span,
   * which is what makes the rest of the chain joinable.
   *
   * PHI
   * One attribute, the session id. No tenant/user/ticket/patient data: the
   * session id is the internal identifier an operator correlates on (the same
   * class of value the backend log redactor deliberately preserves), and
   * anything else would be payload riding on telemetry.
   *
   * COST WHEN DISABLED
   * `trace.getTracer()` returns the no-op tracer, `startSpan` a non-recording
   * span with an INVALID span context, and `injectTraceCarrier` therefore `{}`.
   * No allocation that matters, no propagator work, and the audio wire is
   * byte-identical to the previous implementation.
   */
  private startSessionTrace(sessionId: string, req: IncomingMessage): { span: Span; carrier: TraceCarrier } {
    const parentContext = extractTraceCarrier(req.headers as Record<string, string>) ?? context.active();
    const span = trace
      .getTracer('hope.stt.stream')
      .startSpan('stt.stream.session', { kind: SpanKind.SERVER, attributes: { 'hope.stt.session_id': sessionId } }, parentContext);
    return { span, carrier: injectTraceCarrier(trace.setSpan(parentContext, span)) };
  }

  /** End a session's trace span exactly once. Safe to call on an untraced session. */
  private endSessionTrace(session: SessionInfo): void {
    if (!session.traceSpan) return;
    session.traceSpan.end();
    // Cleared so a double finalize (explicit close racing grace expiry) cannot
    // end the same span twice.
    session.traceSpan = undefined;
  }

  /**
   * (re)establish the result subscription for a session.
   * Uses the STABLE `captions` consumer group so the bridge resumes from the
   * group's persisted cursor (never a 0-0 re-read); every send path reads
   * `session.client`, so a rebind redirects output to the reconnected socket.
   * Any prior subscription is torn down first (exactly one live reader).
   */
  private subscribeSessionResults(session: SessionInfo): void {
    session.resultSubscription?.unsubscribe();
    session.resultSubscription = this.bridgeService
      .subscribeToResults(session.sessionId, {
        consumerGroup: WS_RESULT_CONSUMER_GROUP,
        // TASK-951 R2 — read ONCE at handshake and handed to the reader, so the echo costs
        // nothing per transcript. A grace-window rebind re-subscribes through this same method
        // with the SessionInfo it kept, so a resumed session keeps echoing without a second read.
        ...(session.streamContext ? { sessionEcho: { context: session.streamContext, sessionEpochMs: session.sessionEpochMs } } : {}),
      })
      .subscribe({
        next: (msg) => {
          this.relayResult(session.client, session, msg as unknown as { type: string; isFinal?: boolean; [key: string]: unknown });
        },
        error: (err) => {
          this.logger.warn({
            message: 'Result stream error',
            sessionId: session.sessionId,
            error: err instanceof Error ? err.message : String(err),
          });
          this.sendError(session.client, 'STREAM_ERROR', 'Result stream encountered an error');
        },
        complete: () => {
          if (session.client.readyState === session.client.OPEN) {
            session.client.send(
              JSON.stringify({
                type: 'status',
                status: 'closed',
                message: 'Transcription stream completed',
              }),
            );
          }
        },
      });
  }

  /** Explicit readiness ack the client gates its first send on. */
  private sendReady(session: SessionInfo): void {
    this.sendJson(session.client, {
      type: 'ready',
      sessionId: session.sessionId,
      fromSeq: session.resultSeq + 1,
      // TASK-951 R2 — the session clock, on the FIRST frame the client receives. A caller aligning
      // several per-microphone sessions needs it before any transcript arrives, and `ready` is a
      // control frame, so an additive field here costs nothing per utterance. Absent only for a
      // session whose meta record predates this ticket or could not be read.
      ...(session.sessionEpochMs != null ? { sessionEpochMs: session.sessionEpochMs } : {}),
    });
  }

  /**
   * Register the per-socket message handler. Honors the ws
   * `isBinary` frame flag: binary frames are audio, text frames (delivered by
   * ws@8 as a Buffer with `isBinary === false`) are JSON control. Without this
   * the `{type:'resume'|'stop'|'close'}` control channel was misclassified as
   * audio and the resume handshake was unanswerable.
   */
  private attachMessageHandler(client: WebSocket, sessionId: string): void {
    client.on('message', (data: Buffer, isBinary: boolean) => {
      this.handleMessage(client, data, isBinary).catch((err) => {
        this.logger.error({
          message: 'Unhandled error in message handler',
          sessionId,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    });
  }

  /**
   * Rebind a grace-window session to a reconnecting socket.
   * The upstream STT-v2 session and the result subscription stayed alive, so
   * the resume buffer + seq are intact; we swap the socket, cancel the grace
   * timer, and RE-ESTABLISH the result subscription (the transient disconnect
   * tore down the old reader so a cross-instance reconnect wouldn't split the
   * shared caption group). The re-established reader resumes from
   * the group's persisted cursor; the client drives replay via the
   * resume handshake.
   */
  private rebindSession(session: SessionInfo, client: WebSocket, stored: { userId: string; tenantId: string | null }): void {
    // OWNER INVARIANT: a live session is never adopted by a different user.
    // This line used to be an unconditional `session.userId = stored.userId`,
    // which is what actually performed the transplant — the incumbent socket
    // was silently orphaned (its next frame got a generic NO_SESSION) and
    // `handleDisconnect` later cleaned it up as an ordinary drop, so nothing
    // was ever logged as anomalous. The handshake gate above already compares
    // the ticket against the binding; this is the second, independent check
    // against the LIVE session object, so a rewritten or expired binding still
    // cannot hand a session to someone else.
    if (session.userId !== stored.userId) {
      this.logger.warn({
        message: 'WS rebind REFUSED — ticket user is not the incumbent session owner; incumbent left connected',
        sessionId: session.sessionId,
      });
      client.close(WS_CLOSE_CODES.AUTH_FAILED, WS_GENERIC_AUTH_REASON);
      return;
    }

    if (session.graceTimer) {
      clearTimeout(session.graceTimer);
      session.graceTimer = undefined;
    }
    session.finalizing = false;
    // A genuine grace-window continuation: the upstream STT-v2 session, resume
    // buffer, and seq are all intact, so a subsequent resume handshake IS
    // honorable (F-06).
    session.freshlyCreated = false;

    // Drop the stale socket mapping (defensive — normally already removed on
    // disconnect) and bind the new one. When the previous socket is somehow
    // STILL OPEN, close it explicitly rather than orphaning it: the owner is
    // resuming from somewhere else, and a takeover that leaves a live socket
    // silently detached is indistinguishable (to the displaced client, and in
    // the logs) from the hijack this whole path exists to prevent.
    const previous = session.client;
    if (previous && previous !== client) {
      this.sessions.delete(previous);
      if (previous.readyState === previous.OPEN) {
        this.logger.warn({
          message: 'WS session taken over by its owner on a new socket — closing the superseded socket',
          sessionId: session.sessionId,
        });
        try {
          previous.close(WS_CLOSE_CODES.SESSION_SUPERSEDED, WS_SESSION_SUPERSEDED_REASON);
        } catch {
          // Already gone — nothing to do.
        }
      }
    }
    session.client = client;
    // `session.userId` is NEVER reassigned — see the owner invariant above.
    session.tenantId = stored.tenantId;
    session.connectedAt = new Date();
    this.sessions.set(client, session);
    this.publishSocketCount();

    this.attachMessageHandler(client, session.sessionId);
    // Re-establish the captions reader (stable group → resumes from the
    // persisted cursor, no 0-0 flood). Redirects to the new socket.
    this.subscribeSessionResults(session);

    this.logger.log({
      message: 'WebSocket client reconnected within grace window (C3-01)',
      sessionId: session.sessionId,
      resultSeq: session.resultSeq,
      bufferedForReplay: session.resumeBuffer.length,
      activeSessions: this.sessions.size,
    });

    // Readiness ack so the client gates its resume on it.
    this.sendReady(session);
  }

  /**
   * Relay a bridge result to the WS client with egress
   * backpressure. When `client.bufferedAmount` exceeds the high-watermark
   * (or finals are already queued — preserves delivery order across the
   * drain window):
   *   - PARTIAL transcripts are DROPPED (counted, debug-logged). They are
   *     dropped BEFORE seq-tagging so a stale partial never consumes a seq
   *     or occupies the resume buffer.
   *   - FINAL transcripts are queued (bounded) and flushed in order once
   *     the socket drains below the threshold — finals are never dropped
   *     silently.
   * Non-transcript messages (status etc.) are tiny and rare — they bypass
   * the backpressure policy.
   */
  private relayResult(client: WebSocket, session: SessionInfo, msg: { type: string; isFinal?: boolean; [key: string]: unknown }): void {
    const isTranscript = msg?.type === 'transcript';
    const backpressured = this.isEgressOverThreshold(client) || session.pendingFinalResults.length > 0;

    if (isTranscript && backpressured && msg.isFinal !== true) {
      session.droppedPartialResults++;
      this.logger.debug({
        message: 'Dropped partial transcript — WS egress backpressure (P1-4)',
        sessionId: session.sessionId,
        droppedPartialResults: session.droppedPartialResults,
        bufferedAmount: this.getBufferedAmount(client),
      });
      // TASK-869 — tell the CLIENT, once per episode. Until this existed the
      // drop was observable only in a server-side debug log, so a client could
      // not distinguish "the speaker paused" from "your partials are being
      // discarded", and the contract could not be asserted from outside the
      // process at all. Finals already had `emitGapMarker`; this is the partial
      // half of the same promise: nothing is dropped silently.
      this.emitPartialDropMarker(session);
      return;
    }

    const tagged = this.tagAndBuffer(session, msg);

    if (isTranscript && backpressured && msg.isFinal === true) {
      this.enqueueFinalResult(session, tagged);
      return;
    }

    if (client.readyState === client.OPEN) {
      client.send(JSON.stringify(tagged));
    }
  }

  /** `bufferedAmount` of the client socket (0 when absent). */
  private getBufferedAmount(client: WebSocket): number {
    return (client as { bufferedAmount?: number }).bufferedAmount ?? 0;
  }

  private isEgressOverThreshold(client: WebSocket): boolean {
    return this.getBufferedAmount(client) > WS_EGRESS_HIGH_WATERMARK_BYTES;
  }

  /**
   * Queue a final for delivery after the socket drains. The
   * queue is bounded: on overflow the oldest entry is dropped with an error log.
   *
   * Note: the resume buffer does NOT also hold the dropped one:
   * `tagAndBuffer` (bound `RESUME_BUFFER_SIZE`) runs
   * microseconds before this enqueue and the resume buffer evicts the same final
   * in lockstep, so an overflowed final is in NEITHER the live queue NOR the
   * resume buffer. It survives only in the durable STT-v2 transcript (the
   * clinical system of record). We therefore emit an EXPLICIT gap marker so the
   * loss is never silent — the client sees the seq discontinuity and reconciles
   * against the persisted transcript rather than freezing.
   */
  private enqueueFinalResult(session: SessionInfo, tagged: { type: string; [key: string]: unknown }): void {
    session.pendingFinalResults.push(tagged);
    if (session.pendingFinalResults.length > WS_EGRESS_FINAL_QUEUE_LIMIT) {
      const dropped = session.pendingFinalResults.shift();
      session.droppedFinalResults++;
      const droppedSeq = (dropped as { seq?: number } | undefined)?.seq;
      this.logger.error({
        message: 'Final transcript dropped — bounded WS egress queue overflow (C3-03 / P1-4)',
        sessionId: session.sessionId,
        droppedFinalResults: session.droppedFinalResults,
        queueLimit: WS_EGRESS_FINAL_QUEUE_LIMIT,
        droppedSeq,
      });
      this.emitGapMarker(session, droppedSeq);
    }
    if (!session.egressFlushTimer) {
      const timer = setInterval(() => this.flushPendingFinals(session), WS_EGRESS_FLUSH_POLL_MS);
      (timer as unknown as { unref?: () => void }).unref?.();
      session.egressFlushTimer = timer;
    }
  }

  /**
   * Explicit gap marker so a dropped final is never a SILENT
   * loss. Tiny control frame; sent even while the transcript stream is
   * backpressured (its congestion is what forced the drop). Recoverable from
   * the durable transcript on the client side.
   */
  private emitPartialDropMarker(session: SessionInfo): void {
    if (session.partialDropSignalled) return;
    const client = session.client;
    if (client.readyState !== client.OPEN) return;
    session.partialDropSignalled = true;
    // Deliberately NOT seq-tagged and NOT buffered for resume: it describes the
    // transport's state right now, not a point in the transcript, and a resumed
    // client re-learns it from the next drop if the congestion persists.
    client.send(
      JSON.stringify({
        type: 'gap',
        reason: 'egress_partial_dropped',
        sessionId: session.sessionId,
        droppedPartials: session.droppedPartialResults,
      }),
    );
  }

  private emitGapMarker(session: SessionInfo, droppedSeq?: number): void {
    const client = session.client;
    if (client.readyState === client.OPEN) {
      client.send(
        JSON.stringify({
          type: 'gap',
          reason: 'egress_overflow',
          sessionId: session.sessionId,
          ...(droppedSeq != null ? { droppedSeq } : {}),
        }),
      );
    }
  }

  /**
   * Drain poll: deliver queued finals in order while the
   * socket stays below the threshold; self-clears once the queue empties
   * (normal delivery resumes) or the socket is gone. Targets `session.client`
   * so a grace-window rebind flushes to the reconnected socket.
   */
  private flushPendingFinals(session: SessionInfo): void {
    const client = session.client;
    if (client.readyState !== client.OPEN) {
      // Socket gone mid-drain. If the session is being finalized, drop the
      // queue; otherwise (a transient drop pending its grace window) keep the
      // queued finals so a reconnect can still receive them.
      if (session.finalizing) {
        this.clearEgressState(session, 'socket closed');
      }
      return;
    }
    // Drained ⇒ the episode is over; a NEW one must be able to signal again.
    if (!this.isEgressOverThreshold(client)) session.partialDropSignalled = false;
    while (session.pendingFinalResults.length > 0 && !this.isEgressOverThreshold(client)) {
      const next = session.pendingFinalResults.shift()!;
      client.send(JSON.stringify(next));
    }
    if (session.pendingFinalResults.length === 0 && session.egressFlushTimer) {
      clearInterval(session.egressFlushTimer);
      session.egressFlushTimer = undefined;
    }
  }

  /** Teardown of the egress queue + poll timer. */
  private clearEgressState(session: SessionInfo, reason: string): void {
    if (session.egressFlushTimer) {
      clearInterval(session.egressFlushTimer);
      session.egressFlushTimer = undefined;
    }
    if (session.pendingFinalResults.length > 0) {
      this.logger.warn({
        message: 'Discarding queued finals — WS egress teardown (P1-4)',
        sessionId: session.sessionId,
        reason,
        discarded: session.pendingFinalResults.length,
      });
      session.pendingFinalResults = [];
    }
  }

  /**
   * Tag transcript messages with a server-assigned monotonic `seq` and push
   * onto the bounded resume buffer. Non-transcript messages
   * pass through unchanged.
   */
  private tagAndBuffer(session: SessionInfo, msg: { type: string; [key: string]: unknown }): { type: string; [key: string]: unknown } {
    if (msg?.type !== 'transcript') {
      return msg;
    }
    session.resultSeq += 1;
    const tagged = { ...msg, seq: session.resultSeq };
    session.resumeBuffer.push({ seq: session.resultSeq, msg: tagged });
    if (session.resumeBuffer.length > RESUME_BUFFER_SIZE) {
      session.resumeBuffer.splice(0, session.resumeBuffer.length - RESUME_BUFFER_SIZE);
    }
    return tagged;
  }

  handleDisconnect(client: WebSocket): void {
    const session = this.sessions.get(client);
    // A grace-window rebind may already have moved this session to a NEW socket;
    // a late close of the OLD socket must not tear the live session down.
    if (!session || session.client !== client) {
      this.sessions.delete(client);
      return;
    }

    this.sessions.delete(client);
    // Refresh the multi-instance open-socket aggregate.
    this.publishSocketCount();

    this.logger.log({
      message: 'WebSocket client disconnected',
      sessionId: session.sessionId,
      droppedAudioFrames: session.droppedAudioFrames,
      // Egress backpressure accounting, mirroring
      // the droppedAudioFrames pattern above.
      droppedPartialResults: session.droppedPartialResults,
      droppedFinalResults: session.droppedFinalResults,
      activeSessions: this.sessions.size,
    });

    // Already being torn down for real (explicit close / prior grace expiry).
    if (session.finalizing) {
      return;
    }

    // STOP this session's captions reader immediately so a dead
    // client's reader does NOT keep consuming/ACKing the shared `captions`
    // group for the whole grace window. Cross-instance that would split the
    // live captions (Redis load-balances new results between the dead reader
    // and the reconnected client's reader on the same group); on ANY instance
    // it wastes the group's cursor. Only THIS gateway subscription is dropped
    // (via the bridge Observable's finalize, which disconnects the reader) —
    // NOT `unsubscribeFromResults`, which is the session-wide teardown that
    // would also abort LiveDocumentationService. The upstream STT-v2 session
    // stays alive; a reconnect re-establishes the reader from the persisted
    // group cursor.
    session.resultSubscription?.unsubscribe();
    session.resultSubscription = undefined;

    // A TRANSIENT disconnect must NOT finalize the upstream.
    // Keep the session (resume buffer + seq + upstream STT-v2 session) alive for
    // the grace window so the SAME session can reconnect anywhere and continue.
    // Only when the window expires with no reconnect do we finalize.
    if (session.graceTimer) {
      clearTimeout(session.graceTimer);
    }
    const timer = setTimeout(() => this.finalizeSession(session, 'grace window expired'), WS_RESUME_GRACE_MS);
    (timer as unknown as { unref?: () => void }).unref?.();
    session.graceTimer = timer;
  }

  /**
   * Finalize a session for real: unsubscribe from results,
   * tell STT-v2 to finalize (with the removal-retry fallback), drop all
   * state. Idempotent. Called on an explicit `close` or when the resume grace
   * window expires with no reconnect.
   *
   * `reason` also decides the ledger's `interrupted` flag
   * `'session closed by client'` is the only non-abort reason; anything else
   * (today just `'grace window expired'`, permissively any future reason
   * too) is an abort. STT itself has no notion of this; it is purely a
   * gateway-side decision made here, at the one place both reasons meet.
   */
  private finalizeSession(session: SessionInfo, reason: string): void {
    if (session.finalizing && reason === 'grace window expired') {
      // A concurrent close already finalized it.
      return;
    }
    session.finalizing = true;
    // The session span covers the whole logical operation, so it ends here —
    // the one place a session is genuinely over (explicit close OR an expired
    // grace window), never on a transient disconnect that may still reconnect.
    this.endSessionTrace(session);
    if (session.graceTimer) {
      clearTimeout(session.graceTimer);
      session.graceTimer = undefined;
    }
    session.resultSubscription?.unsubscribe();
    this.bridgeService.unsubscribeFromResults(session.sessionId);
    this.clearEgressState(session, reason);
    this.sessions.delete(session.client);
    this.sessionsById.delete(session.sessionId);
    this.publishSocketCount();

    this.logger.log({
      message: 'Streaming session finalized',
      sessionId: session.sessionId,
      reason,
    });

    // Clear the sessionId→tenant binding so a stream ticket can NO longer be
    // minted against this now-dead session (F-36). The binding's own 24h TTL
    // would otherwise keep it mintable long after finalize, and a ticket minted
    // against a finalized session is precisely what feeds the false-resume path
    // (F-06). `clear()` is best-effort (swallows Redis errors internally); the
    // TTL remains the backstop. The sibling meta key expires on its own TTL.
    void this.sessionBinding.clear(session.sessionId);

    const interrupted = reason !== 'session closed by client';
    this.sessionService.removeSession(session.sessionId, interrupted, session.tenantId).catch((err) => {
      this.logger.warn({
        message: 'Session cleanup failed on finalize',
        sessionId: session.sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
      // Park the session for bounded retries
      // instead of leaking it until the STT-v2 inactivity reaper.
      this.removalRetry.enqueue(session.sessionId, interrupted, session.tenantId);
    });
  }

  async handleMessage(client: WebSocket, rawData: string | Buffer, isBinary?: boolean): Promise<void> {
    const session = this.sessions.get(client);
    if (!session) {
      this.sendError(client, 'NO_SESSION', 'No active session for this connection');
      return;
    }

    // Route on the ws `isBinary` frame flag, NOT `Buffer.isBuffer`:
    // ws@8 delivers TEXT frames as a Buffer too, so a Buffer with
    // `isBinary === false` is a JSON control frame ({resume|stop|close}), not
    // audio. Misrouting it as audio was why the resume handshake was dead.
    // (`isBinary` is undefined only on direct unit-test calls; a bare string is
    // then treated as JSON, a Buffer must set the flag explicitly.)
    if (isBinary === true) {
      session.binarySeq++;
      const audio = Buffer.isBuffer(rawData) ? rawData : Buffer.from(String(rawData));
      this.forwardAudioFrame(session, session.binarySeq, audio);
      return;
    }

    let msg: { type: string; [key: string]: unknown };
    try {
      const str = Buffer.isBuffer(rawData) ? rawData.toString('utf8') : String(rawData);
      msg = JSON.parse(str);
    } catch {
      this.sendError(client, 'INVALID_JSON', 'Message must be valid JSON');
      return;
    }

    const { type } = msg;

    try {
      switch (type) {
        case 'audio': {
          const seq = typeof msg.seq === 'number' ? msg.seq : ++session.binarySeq;
          const data = Buffer.from(String(msg.data), 'base64');
          this.forwardAudioFrame(session, seq, data);
          break;
        }

        case 'stop': {
          await this.bridgeService.writeControlCommand(session.sessionId, 'finalize');
          break;
        }

        case 'resume': {
          // Resumability handshake.
          this.handleResume(session, msg);
          break;
        }

        case 'close': {
          // An explicit close is a REAL end (no grace window):
          // finalize the upstream immediately.
          this.finalizeSession(session, 'session closed by client');
          client.close(1000, 'Session closed by client');
          break;
        }

        default:
          this.sendError(client, 'UNKNOWN_TYPE', `Unknown message type: ${type}`);
      }
    } catch (err) {
      this.logger.error({
        message: 'Error handling WebSocket message',
        sessionId: session.sessionId,
        type,
        error: err instanceof Error ? err.message : String(err),
      });
      this.sendError(client, 'INTERNAL_ERROR', 'Failed to process message');
    }
  }

  /**
   * Forward an audio frame WITHOUT awaiting the Redis
   * ack. ioredis preserves per-connection command order, so XADD ordering
   * (and the audio-before-finalize ordering relied on by `stop`) is
   * unaffected; awaiting each ack only added per-frame promise/microtask
   * overhead at 10–125 frames/s/session. Failures are counted on the
   * session and surfaced to the client as BRIDGE_ERROR — the SDK's
   * `lastSeq` resume protocol handles recovery.
   */
  private forwardAudioFrame(session: SessionInfo, seq: number, data: Buffer): void {
    // The carrier was derived ONCE at handshake — passing it
    // here is a reference copy, not propagator work, so the 10–125 frames/s/session
    // path keeps its cost profile.
    this.bridgeService.writeAudioFrame(session.sessionId, seq, data, session.sampleRate, 'pcm_s16le', false, session.traceCarrier).catch((err) => {
      session.droppedAudioFrames++;
      this.logger.error({
        message: 'Error forwarding audio frame',
        sessionId: session.sessionId,
        seq,
        droppedAudioFrames: session.droppedAudioFrames,
        error: err instanceof Error ? err.message : String(err),
      });
      this.sendError(session.client, 'BRIDGE_ERROR', 'Failed to forward audio frame');
    });
  }

  getActiveSessionCount(): number {
    return this.sessions.size;
  }

  /**
   * Handle the `{type:'resume', sessionId, lastSeq}` handshake from the SDK.
   * A successful resume ALWAYS acknowledges
   * continuation from the next unseen seq (`fromSeq = lastSeq + 1`) and replays
   * every buffered transcript with `seq > lastSeq` — never re-sending anything
   * with `seq <= lastSeq` (no duplicate flood). When the requested `lastSeq` is
   * behind the oldest still-buffered seq the gap exceeds the window: respond
   * with `resume_failed` + the lowest still-available seq (the loss is in the
   * durable transcript).
   */
  private handleResume(session: SessionInfo, msg: { type: string; [key: string]: unknown }): void {
    const client = session.client;
    const reqSessionId = typeof msg.sessionId === 'string' ? msg.sessionId : null;
    const lastSeq = typeof msg.lastSeq === 'number' && Number.isFinite(msg.lastSeq) ? msg.lastSeq : null;

    if (!reqSessionId || reqSessionId !== session.sessionId || lastSeq === null) {
      this.sendJson(client, { type: 'resume_failed', sessionId: session.sessionId, reason: 'unknown_session' });
      return;
    }

    // A resume that references seqs this session never emitted, on a
    // freshly-created (never-continued) session, is a FALSE resume: the prior
    // session (and its upstream STT-v2 session) is gone — the grace window
    // expired and finalize deleted it, or this is a cross-instance reconnect
    // that never held the prior state. Such a session has an empty resume
    // buffer, which would vacuously pass the length guard below and reply
    // `resumed`, leaving the client streaming audio into a dead session with no
    // error anywhere. `lastSeq > session.resultSeq` is the precise signal
    // (the client claims to have seen more than this session ever produced) — it
    // spares the legitimate cases: a genuine grace-window continuation is not
    // freshly created (rebindSession clears the flag), and a first-ever resume
    // with nothing seen (`lastSeq <= resultSeq`, e.g. both 0) still continues.
    // Rejecting lets the SDK surface a terminal failure and establish a fresh
    // session (F-06) instead of silently freezing.
    if (session.freshlyCreated && lastSeq > session.resultSeq) {
      this.logger.warn({
        message: 'Resume rejected — session not resumable (freshly created after grace/cross-instance)',
        sessionId: session.sessionId,
        lastSeq,
        resultSeq: session.resultSeq,
      });
      this.sendJson(client, { type: 'resume_failed', sessionId: session.sessionId, reason: 'unknown_session' });
      return;
    }

    const buffer = session.resumeBuffer;
    if (buffer.length > 0) {
      const minAvailableSeq = buffer[0]!.seq;
      if (lastSeq < minAvailableSeq - 1) {
        this.sendJson(client, { type: 'resume_failed', sessionId: session.sessionId, reason: 'buffer_overflow', minAvailableSeq });
        return;
      }
    }

    // Success — continuation from the NEXT unseen seq, then replay the unseen
    // buffered transcripts in order. An empty buffer (or a caught-up client)
    // still gets `resumed fromSeq: lastSeq + 1` and continues with live results.
    const toReplay = buffer.filter((b) => b.seq > lastSeq);
    this.sendJson(client, { type: 'resumed', sessionId: session.sessionId, fromSeq: lastSeq + 1 });
    for (const entry of toReplay) {
      this.sendJson(client, entry.msg);
    }
  }

  private sendJson(client: WebSocket, payload: unknown): void {
    if (client.readyState === client.OPEN) {
      client.send(JSON.stringify(payload));
    }
  }

  private sendError(client: WebSocket, code: string, message: string): void {
    if (client.readyState === client.OPEN) {
      client.send(JSON.stringify({ type: 'error', code, message }));
    }
  }
}
