import {
  IAppSettingsService,
  IOriginRegistry,
  ISocketRegistryService,
  MAX_STREAM_METADATA_BYTES,
  STT_EGRESS_HIGH_WATERMARK_BYTES_KEY,
  STT_GATEWAY_DEFAULTS,
  STT_GATEWAY_UNKNOWN_AGENT,
  STT_RESUME_GRACE_MS_KEY,
  STT_RESUME_MAX_REPLAY_AGE_MS_KEY,
  STT_WS_PING_INTERVAL_MS_KEY,
  STT_WS_PING_MISSES_KEY,
  StreamingAudioBridgeService,
  StreamingSessionService,
  type ClippedMetadataSpan,
  type MetadataSpan,
  type TraceCarrier,
  clipSpansToWindow,
  extractTraceCarrier,
  injectTraceCarrier,
  isMetadataObject,
  jsonSchemaValueProblems,
  metadataByteLength,
  setMetadataAt,
  sttGatewayAudioEgressDroppedTotal,
  sttGatewayAudioIngestDroppedTotal,
  sttGatewayClientAudioDroppedTotal,
  sttGatewayCommitLatencySeconds,
  sttGatewayFirstPartialSeconds,
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
 * TASK-985 ST-5 — read a DEPRECATED positive-number env seed, or `undefined` when it is unset
 * or unusable.
 *
 * `undefined` is the load-bearing return. The two remaining env names are pre-resolution SEEDS
 * for one release: a stored registry row always beats them, and the code default beats them
 * only when they are absent. Folding the default in here (`?? 32768`) would make "unset" and
 * "set to the default" indistinguishable, and the resolver could no longer tell whether it was
 * honouring an operator's deprecated value or nobody's.
 */
function readPositiveEnv(name: string): number | undefined {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? raw : undefined;
}

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
 * TASK-985 M-03 — bound on {@link SessionInfo.audioClockSamples}. Same order as the resume
 * buffer, and evicted the same way (oldest first): a sample older than the whole buffer can no
 * longer be referenced by any final a client has not already seen.
 */
export const AUDIO_CLOCK_SAMPLE_CAP = 200;

/**
 * TASK-985 M-03 — one audio-clock sample per this many SECONDS OF AUDIO, not per frame.
 *
 * A frame is 8–100 ms, so sampling every frame would grow the ring 10–125×/s for a precision
 * nothing consumes: the histogram's finest bucket is 500 ms. 100 ms of audio bounds the
 * quantisation error of a commit-latency sample to 100 ms, two orders below that bucket.
 */
export const AUDIO_CLOCK_SAMPLE_INTERVAL_SEC = 0.1;

/**
 * Fallback when no session meta was bound (legacy clients / Redis blip at
 * handshake). Matches the historical hardcoded rate.
 */
export const DEFAULT_SAMPLE_RATE = 16000;

/**
 * WS egress backpressure threshold. When the client socket's `bufferedAmount` exceeds this many
 * bytes, partial transcripts are dropped and final transcripts are queued until it drains.
 *
 * @deprecated TASK-985 (ST-5, removed in R4) — governed by
 * `sttStreaming.egressHighWatermarkBytes` (`global-kv`, `globalOnly`, `open-to-default`).
 *
 * This const is now ONLY the deprecated `STT_WS_EGRESS_HIGH_WATERMARK_BYTES` env seed, and it is
 * a pre-resolution seed: a stored registry row always wins. Two things were wrong with it as a
 * governing value. It is read at MODULE SCOPE, so it is fixed for the process lifetime and a
 * change needs a pod restart — which disqualifies it from being an env var at all
 * (`09-infrastructure-devops.md` §Configuration Tiers, corollary L1); and it was declared in
 * `turbo.json#globalEnv` and `.env.sample`, so the declaration advertised a mutability the code
 * did not have (D8 §8 N-7). The 512 KiB default was also wrong on its own terms: it is roughly
 * 50 seconds of captions in flight to a client that is already behind. The governed default is
 * 32 KiB.
 *
 * Kept exported because existing tests import it and because the env name is honoured for one
 * release; it is the LAST resort, below both the registry row and the code default.
 */
const WS_EGRESS_HIGH_WATERMARK_BYTES_ENV = readPositiveEnv('STT_WS_EGRESS_HIGH_WATERMARK_BYTES');
/**
 * The CODE DEFAULT, and only that. It is NOT the effective watermark for any session —
 * {@link SttWsGateway.resolveBudget} owns that, and it consults the governed row and the
 * deprecated env seed first.
 *
 * It used to be `env ?? default`, which made an imported constant mean different things in
 * different environments: a test that compared against it was really comparing against whatever
 * `.env.test` happened to say. Reading the default is the only use an importer has for it.
 */
export const WS_EGRESS_HIGH_WATERMARK_BYTES = STT_GATEWAY_DEFAULTS[STT_EGRESS_HIGH_WATERMARK_BYTES_KEY];

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
 * Resume grace window. On a TRANSIENT socket drop the gateway keeps the session (its resume
 * buffer, seq counter, and upstream STT-v2 session) alive for this long so the SAME session can
 * reconnect and continue without a duplicate flood or a silent freeze. Only when the window
 * expires with no reconnect is the upstream finalized.
 *
 * @deprecated TASK-985 (ST-5, removed in R4) — governed by `sttStreaming.resumeGraceMs`. Same
 * reasoning, and the same pre-resolution-seed contract, as
 * {@link WS_EGRESS_HIGH_WATERMARK_BYTES} above.
 */
const WS_RESUME_GRACE_MS_ENV = readPositiveEnv('STT_WS_RESUME_GRACE_MS');
/** The CODE DEFAULT — see {@link WS_EGRESS_HIGH_WATERMARK_BYTES} for why it is not the env value. */
export const WS_RESUME_GRACE_MS = STT_GATEWAY_DEFAULTS[STT_RESUME_GRACE_MS_KEY];

/**
 * Stable consumer-group name the gateway uses when subscribing
 * to `stt:result:{sessionId}`. Being stable per session (the stream is already
 * per-session) means the bridge resumes from the group's Redis-owned cursor on
 * a re-subscription rather than re-reading from `0-0`. Distinct from the
 * LiveDocumentationService reader's (default, unique) group, so both still
 * receive every result (fan-out preserved).
 */
export const WS_RESULT_CONSUMER_GROUP = 'captions';

/**
 * The STABLE consumer NAME the gateway reads under, within {@link WS_RESULT_CONSUMER_GROUP}.
 *
 * TASK-985 M-48. The group was already stable; the consumer name was not — the bridge minted
 * `reader-<counter>` per subscription. A grace-window rebind therefore created a consumer whose
 * own pending-entries list was EMPTY, read it, found nothing and went live at `'>'`, while the
 * dead reader's read-but-unacked results stayed in ITS pending list, reclaimable only by an
 * XAUTOCLAIM at 30 s idle — longer than the 15 s grace window, by which point the session could
 * already be finalized. Those results were lost, and because client-side `seq`s are contiguous
 * (the gateway assigns them) the loss was SILENT.
 *
 * With one name per session the rebind inherits the same pending list and the reader's existing
 * initial `'0'` read recovers it deterministically. That makes redelivery ROUTINE rather than
 * exceptional — which is why {@link SttWsGateway.tagAndBuffer} now carries a re-emission guard:
 * `readResultStream` is explicitly at-least-once, so a redelivered entry must reuse the seq it
 * was first given instead of being handed a new one and reaching the client twice.
 */
export const wsResultConsumerName = (sessionId: string): string => `captions-${sessionId}`;

/** Buffered transcript ready for replay. */
interface BufferedTranscript {
  seq: number;
  msg: { type: string; seq?: number; [key: string]: unknown };
  /**
   * TASK-985 ST-5 — the STT-side utterance ordinal this entry belongs to, when the worker
   * stamped one. It is the key coalescing works on: every partial of utterance `k` is
   * SUPERSEDED by the next partial of utterance `k`, so the buffer keeps only the newest.
   * Absent on an older worker that does not stamp it — such an entry is never coalesced,
   * which degrades to exactly today's behaviour rather than to a guess.
   */
  utteranceIndex?: number;
  /** Finals are NEVER coalesced and never aged out — each is distinct clinical content. */
  isFinal: boolean;
  /** `Date.now()` at buffering, for the replay age bound. */
  atMs: number;
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
  /**
   * TASK-951 R2 (clarified) — the schema ONE `{type:'metadata'}` object must satisfy, from the
   * same one meta read. Undefined = the session's agent declares no stream-identity vocabulary,
   * and any object is accepted on the size bound alone.
   */
  metadataSchema?: Record<string, unknown>;
  /**
   * TASK-951 R2 (clarified) — the session's AUDIO CLOCK, in bytes forwarded upstream.
   *
   * Seconds are `bytes / (sampleRate * 2)` for PCM16 LE mono, which is the same quantity
   * `apps/stt` derives a segment's `start_time`/`end_time` from (`total_samples_fed /
   * target_sr` in `preprocessor.py`). Two counters over the same audio: no timestamp is ever
   * transmitted, and the two agree by construction.
   *
   * It NEVER rewinds. A grace-window rebind keeps this `SessionInfo`, so the count carries
   * across a reconnect exactly as the resume buffer and the seq do — a resume continues one
   * audio timeline rather than starting a second one.
   */
  audioBytesForwarded: number;
  /**
   * TASK-951 R2 (clarified) — the metadata spans declared so far, newest last, last one open.
   *
   * The HOT COPY: every transcript is served from here, so the per-utterance cost of the echo
   * is an array scan and no Redis round trip. `bindMetadataMarks` mirrors it to Redis on each
   * change purely so a cross-instance reconnect can rebuild it.
   */
  metadataSpans: MetadataSpan[];
  /**
   * TASK-985 ST-5 — this session's egress high watermark, resolved ONCE at the handshake from
   * `sttStreaming.egressHighWatermarkBytes`.
   *
   * Per session, not per relay: `relayResult` runs once per transcript on the latency path and
   * must stay synchronous, and a watermark that changed mid-session would make the drop
   * decision non-reproducible from the logs. A registry write therefore governs the next
   * session to OPEN, which the descriptor says in as many words.
   */
  egressHighWatermarkBytes: number;
  /**
   * TASK-985 QW-1 — the client asked for this session to stop (`{type:'stop'}`).
   *
   * It is what makes `interrupted` correct on the ledger row. The browser SDK never sends
   * `{type:'close'}` — it calls `disconnect()` — so the gateway only ever saw a socket drop and
   * finalized with `'grace window expired'`, stamping `interrupted = true` on a session the
   * clinician had stopped cleanly. With this latch, finalizing on the upstream's terminal
   * `closed` status can tell the two apart without waiting for an SDK change.
   */
  stopRequested?: boolean;
  /**
   * TASK-985 M-47 — consecutive keepalive pings this socket has not answered.
   *
   * Reset to 0 by every `pong` (and by a rebind). At
   * `sttStreaming.wsPingMissesBeforeTerminate` the socket is terminated, which routes through
   * the ordinary disconnect path, so a flaky client still gets its full grace window.
   */
  missedPongs: number;
  /**
   * TASK-985 M-03 — `Date.now()` when this session's FIRST audio frame was forwarded upstream,
   * and whether its first partial has already been observed. Together they are the
   * `stt_gateway_first_partial_seconds` sample, taken exactly once per session.
   */
  firstFrameForwardedAt?: number;
  firstPartialObserved?: boolean;
  /**
   * TASK-985 M-03 — the session's AUDIO CLOCK, sampled against the wall clock.
   *
   * Commit latency is "how long after the speaker finished a sentence did it go solid", and the
   * only honest way to measure it on this side is to remember WHEN the audio at a given offset
   * was forwarded. A final carries an `endTime` on the session's audio clock
   * ({@link SessionInfo.audioBytesForwarded} ÷ bytes-per-second), so the newest sample at or
   * before that offset gives the instant that audio left the gateway.
   *
   * Bounded at {@link AUDIO_CLOCK_SAMPLE_CAP} entries and throttled to one sample per
   * {@link AUDIO_CLOCK_SAMPLE_INTERVAL_SEC} of audio, so a 125 frame/s session adds one entry
   * every ~10 frames rather than one per frame, and a long consultation cannot grow it without
   * bound. The cap loses the OLDEST samples, which are the ones no future final can reference.
   */
  audioClockSamples: Array<{ audioSec: number; atMs: number }>;
  /** Audio-clock offset (seconds) of the newest entry in {@link audioClockSamples}. */
  lastAudioClockSampleSec: number;
  /**
   * TASK-985 M-03 — the ASR agent slug, for the metric label.
   *
   * Currently always undefined: the slug is resolved at `POST .../stream/session` and is NOT
   * carried on the session meta record the gateway reads at handshake, so there is nowhere to
   * read it from without a cross-lane change to `StreamSessionMeta`. It degrades to
   * `STT_GATEWAY_UNKNOWN_AGENT`, which is honest and has cardinality 1. See that constant for
   * why the label must NOT be widened to a tenant id or an agent UUID instead.
   */
  agentSlug?: string;
  /**
   * TASK-985 M-67 — audio frames the CLIENT reports it discarded before sending, read off its
   * end-of-session `{type:'client_stats'}` frame. A CLAIM, recorded separately from the
   * gateway's own observed drop count and never summed with it.
   */
  clientReportedDroppedFrames?: number;
  /**
   * TASK-985 ST-5 — the highest seq DROPPED FROM THE FRONT of {@link resumeBuffer} by the
   * `RESUME_BUFFER_SIZE` bound. 0 while nothing has been evicted.
   *
   * It exists because coalescing broke the assumption `handleResume` used to make. That guard
   * read `resumeBuffer[0].seq` as "the oldest seq still available", which was true only while
   * the buffer was append-and-trim: entries left exactly one way, off the front, in seq order.
   * Coalescing removes SUPERSEDED partials from the MIDDLE and the FRONT, so `resumeBuffer[0]`
   * is now routinely a high seq with perfectly serviceable gaps below it — and a client
   * resuming from a seq inside one of those gaps was told `resume_failed / buffer_overflow`
   * and had to abandon the session. Eviction and coalescing had to become separable, and this
   * is the half that means "genuinely gone".
   */
  evictedThroughSeq: number;
  /**
   * TASK-985 M-48 — the re-emission guard the stable consumer name makes necessary.
   *
   * Maps an STT-side transcript IDENTITY to the seq it was first given. `readResultStream` is
   * explicitly at-least-once, and with a stable consumer name a rebind now deliberately
   * re-reads the dead reader's pending entries — so without this a redelivered result would be
   * tagged with a SECOND seq and reach the client twice as two different transcripts. Bounded
   * in lockstep with {@link resumeBuffer}.
   */
  emittedSeqByIdentity: Map<string, number>;
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
  private socketHeartbeat?: ReturnType<typeof setTimeout>;
  /** Keys already warned about for using their deprecated env seed (one line per process). */
  private readonly deprecatedEnvWarned = new Set<string>();

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
    // TASK-985 ST-5 — the governed WS transport budgets (egress watermark, resume grace, replay
    // age, ping cadence). Optional and TRAILING so every existing positional construction keeps
    // compiling; absent ⇒ each key falls to its deprecated env seed and then to the code
    // default, which is what an unwritten `GlobalSetting` row resolves to anyway.
    @Optional()
    @Inject(IAppSettingsService)
    private readonly appSettings?: IAppSettingsService,
  ) {}

  /**
   * Resolve one governed WS-transport budget: **stored row → deprecated env seed → code
   * default**.
   *
   * The order is the deprecation contract (`docs/operations/deprecation-register.md`): the env
   * name is honoured for one release so an operator who set it in a deployment does not lose
   * their value the moment this lands, but it can never overrule a control-plane write — the
   * whole point of the move is that the control plane is now the authority.
   *
   * `hasSetting` is what makes the three tiers separable: `getValueWithDefault` alone cannot
   * tell "row says 32768" from "no row, here is your fallback", so an env seed would silently
   * lose to the default. Reading the row is a synchronous cache hit; this is called on the
   * handshake and on a disconnect, never per frame or per transcript.
   */
  private resolveBudget(key: string, envSeed: number | undefined): number {
    const codeDefault = STT_GATEWAY_DEFAULTS[key as keyof typeof STT_GATEWAY_DEFAULTS];
    if (this.appSettings?.hasSetting(key)) {
      const stored = this.appSettings.getValueWithDefault<number>(key, codeDefault);
      if (typeof stored === 'number' && Number.isFinite(stored) && stored > 0) return stored;
    }
    if (envSeed !== undefined) {
      this.warnDeprecatedEnvOnce(key);
      return envSeed;
    }
    return codeDefault;
  }

  /** One WARN per key per process — a per-session line would be one per consultation. */
  private warnDeprecatedEnvOnce(key: string): void {
    if (this.deprecatedEnvWarned.has(key)) return;
    this.deprecatedEnvWarned.add(key);
    this.logger.warn({
      message: 'Using a DEPRECATED environment variable for an STT WS transport budget — set the governed setting instead (removed in R4)',
      settingKey: key,
    });
  }

  onModuleInit(): void {
    // Publish an initial 0 immediately, then refresh on a cadence well under the
    // 45s key TTL so a live instance never expires between socket events.
    this.publishSocketCount();
    this.scheduleHeartbeat();
  }

  /**
   * TASK-985 M-47 — the heartbeat, re-scheduled after each tick instead of a fixed
   * `setInterval`.
   *
   * It was a 20 s interval that only refreshed the Redis socket count. It now ALSO carries the
   * WebSocket keepalive, and the keepalive's cadence is governed
   * (`sttStreaming.wsPingIntervalMs`) — a `setInterval` fixed at construction could not honour
   * a control-plane write without a pod restart, which is the same tier violation ST-5 exists
   * to remove. Re-reading the budget per tick costs one synchronous cache hit every ~20 s.
   */
  private scheduleHeartbeat(): void {
    const intervalMs = this.resolveBudget(STT_WS_PING_INTERVAL_MS_KEY, undefined);
    const timer = setTimeout(() => {
      this.publishSocketCount();
      this.sweepSocketLiveness();
      this.scheduleHeartbeat();
    }, intervalMs);
    // Don't keep the event loop alive for the heartbeat alone.
    (timer as unknown as { unref?: () => void }).unref?.();
    this.socketHeartbeat = timer;
  }

  /**
   * TASK-985 M-47 — ping every live socket; terminate the ones that stopped answering.
   *
   * ## What was broken
   *
   * There was no keepalive at all (`ping`/`pong`/`isAlive` appeared nowhere in this file). A
   * HALF-OPEN client — one whose egress a firewall or a sleeping laptop silently dropped, so
   * TCP never closes and `handleDisconnect` never runs — kept its `SessionInfo`, its upstream
   * STT session, its model pin and a GPU SLOT until STT's own 300 s idle reaper noticed, up to
   * ten minutes counting the reaper interval. On a cluster with six allocatable GPU units in
   * total, that is a materially expensive way to learn a laptop closed its lid.
   *
   * ## Why terminate rather than close
   *
   * `terminate()` routes through the ordinary disconnect path, so a genuinely flaky client
   * still gets its full resume grace window and can reconnect onto the same session. This
   * shortens DETECTION from ~300 s to one-to-two ping intervals; it does not remove
   * resumability. A polite `close()` would wait for a close handshake the peer is, by
   * hypothesis, no longer able to complete.
   *
   * Sockets in the grace window are not pinged: they have no live client by definition, and
   * their timer already owns their fate.
   */
  private sweepSocketLiveness(): void {
    const maxMisses = this.resolveBudget(STT_WS_PING_MISSES_KEY, undefined);
    for (const [client, session] of [...this.sessions.entries()]) {
      if (session.finalizing) continue;
      if (client.readyState !== client.OPEN) continue;
      if (session.missedPongs >= maxMisses) {
        this.logger.warn({
          message: 'Terminating a WS socket that stopped answering keepalive pings (half-open client)',
          sessionId: session.sessionId,
          missedPongs: session.missedPongs,
          maxMisses,
        });
        // `terminate` is a `ws` method; a unit-test double may not have it. Falling back to
        // `close` keeps the sweep honest in tests rather than throwing on the hot path.
        const socket = client as unknown as { terminate?: () => void; close?: (code?: number, reason?: string) => void };
        if (typeof socket.terminate === 'function') socket.terminate();
        else socket.close?.(1001, 'Keepalive timeout');
        continue;
      }
      // Count the ping as missed OPTIMISTICALLY, and let the `pong` handler clear it. The
      // alternative — mark on the NEXT tick if no pong arrived — needs a second piece of state
      // to remember that a ping was outstanding, and gets the same answer.
      session.missedPongs += 1;
      const socket = client as unknown as { ping?: () => void };
      if (typeof socket.ping === 'function') {
        try {
          socket.ping();
        } catch {
          // A socket that cannot even be pinged is already gone; the next tick terminates it.
        }
      }
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.socketHeartbeat) {
      clearTimeout(this.socketHeartbeat);
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
    // TASK-985 M-68 — iterate `sessionsById`, NOT `sessions`.
    //
    // `sessions` is keyed by SOCKET and `handleDisconnect` deletes from it immediately, while
    // the session itself survives in `sessionsById` for the whole resume grace window still
    // holding its upstream STT session, its model pin and a GPU slot. So a tenant that dropped
    // and reconnected five sockets in fifteen seconds showed a count of 1 while holding 5
    // upstream sessions — and this map is what `SocketRegistryService.getTenantAggregateCount`
    // publishes and what `EntitlementsService` compares against `maxConcurrentSessions`. The
    // cap was therefore enforced against the wrong set, in the permissive direction, exactly
    // during the churn that makes a cap matter.
    //
    // `finalizing` sessions are excluded: they have already released (or are releasing) their
    // upstream, so counting them would swing the error to the restrictive side instead.
    for (const session of this.sessionsById.values()) {
      if (session.finalizing) continue;
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
    // TASK-951 R2 (clarified) — the metadata gate's schema and, for a session reconnecting onto
    // a gateway that never saw its earlier frames, its persisted timeline. Both come off the
    // SAME await as the sampleRate (one `Promise.all`, two keys), so the handshake still pays
    // for one round trip's latency, and both degrade to "nothing" on any failure.
    let metadataSchema: Record<string, unknown> | undefined;
    let metadataSpans: MetadataSpan[] = [];
    let audioBytesForwarded = 0;
    try {
      const [meta, marks] = await Promise.all([this.sessionBinding.lookupSessionMeta(sessionId), this.sessionBinding.lookupMetadataMarks(sessionId)]);
      if (meta) {
        sampleRate = meta.sampleRate;
        streamContext = meta.context;
        sessionEpochMs = meta.sessionEpochMs;
        metadataSchema = meta.metadataSchema;
      }
      if (marks.spans.length > 0) {
        metadataSpans = marks.spans;
        // Restore the CLOCK with the spans, not just the spans: a rebuilt timeline whose clock
        // restarted at zero would place every later span before the ones it already holds.
        // `audioSec` is the offset as of the last recorded mark, so this can lag by whatever
        // audio flowed after it — understating the gap, never inventing coverage.
        audioBytesForwarded = Math.max(0, Math.round(marks.audioSec * sampleRate * 2));
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
      ...(metadataSchema ? { metadataSchema } : {}),
      audioBytesForwarded,
      metadataSpans,
      // TASK-985 ST-5 — resolved ONCE, here, so the per-transcript relay path stays synchronous.
      egressHighWatermarkBytes: this.resolveBudget(STT_EGRESS_HIGH_WATERMARK_BYTES_KEY, WS_EGRESS_HIGH_WATERMARK_BYTES_ENV),
      missedPongs: 0,
      audioClockSamples: [],
      lastAudioClockSampleSec: -Infinity,
      evictedThroughSeq: 0,
      emittedSeqByIdentity: new Map<string, number>(),
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
  private subscribeSessionResults(session: SessionInfo, options?: { reclaimMinIdleMs?: number }): void {
    session.resultSubscription?.unsubscribe();
    session.resultSubscription = this.bridgeService
      .subscribeToResults(session.sessionId, {
        consumerGroup: WS_RESULT_CONSUMER_GROUP,
        // TASK-985 M-48 — a STABLE consumer name, so a rebind inherits the dead reader's
        // pending entries instead of starting with an empty PEL and abandoning them for
        // 30 s (longer than the grace window). See {@link wsResultConsumerName}.
        consumerName: wsResultConsumerName(session.sessionId),
        // TASK-985 M-48 — and, on the REBIND path only, reclaim at min-idle 0. The gateway
        // disconnected the previous reader itself, so there is no live consumer whose
        // in-flight could be stolen; on a FIRST subscribe the option is omitted and the
        // bridge's conservative 30 s default applies.
        ...(options?.reclaimMinIdleMs !== undefined ? { reclaimMinIdleMs: options.reclaimMinIdleMs } : {}),
        // TASK-951 R2 — read ONCE at handshake and handed to the reader, so the echo costs
        // nothing per transcript. A grace-window rebind re-subscribes through this same method
        // with the SessionInfo it kept, so a resumed session keeps echoing without a second read.
        //
        // TASK-951 R2 (clarified) — the timeline accessor rides in the same object but is a
        // CLOSURE OVER THE SESSION, not a value: it is called per transcript and must see the
        // spans as they are THEN. `sessionEcho` is now installed for every session, because a
        // session that declared no `context` may still send `metadata` frames — the two are
        // independent client choices. A session that uses NEITHER still emits exactly the
        // fields it emitted before this ticket: the bridge spreads `context` only when there is
        // one, and `metadata` only when the clipped span list is non-empty.
        sessionEcho: {
          ...(session.streamContext ? { context: session.streamContext, sessionEpochMs: session.sessionEpochMs } : {}),
          metadataSpans: (startTime: number, endTime: number): ClippedMetadataSpan[] =>
            clipSpansToWindow(session.metadataSpans, startTime, endTime, this.audioSecForwarded(session)),
        },
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
          // The synthesized closing frame goes out FIRST: the client learns the stream is over
          // while its session still exists, so a `{type:'close'}` it sends in response is not
          // answered with NO_SESSION.
          if (session.client.readyState === session.client.OPEN) {
            session.client.send(
              JSON.stringify({
                type: 'status',
                status: 'closed',
                message: 'Transcription stream completed',
              }),
            );
          }
          // TASK-985 QW-1 (D8 §1.5 item 5) — FINALIZE ON THE TERMINAL `closed` STATUS.
          //
          // This subscription completes only on a terminal upstream status: an unsubscribe
          // (disconnect, rebind, finalize) detaches this observer first, so `complete` is not
          // delivered on those paths. So reaching here means STT is genuinely done with the
          // session, and the gateway should tear down NOW rather than wait for a grace window
          // that will then stamp the ledger row `interrupted = true`.
          //
          // Why that flag was wrong: the browser SDK never sends `{type:'close'}` — it calls
          // `disconnect()` — so an ordinary clean stop reached `finalizeSession(session,
          // 'grace window expired')` 15 s later and billed a consultation the clinician ended
          // normally as an abort. `stopRequested` is the gateway's own record of the client's
          // intent, and the gateway is the ONLY party that has it: `_build_teardown_summary`
          // says in its own docstring that STT has no notion of "interrupted".
          //
          // SEQUENCING (D8 §6.2 edge 3): this brings the DELETE forward into the window that
          // used to answer 204, so it REQUIRES L-STT's teardown-summary stash to be in place —
          // without it, ledger coverage gets worse before it gets better. The stash lands
          // first in the merge order, and `StreamingSessionService.removeSession` now counts
          // (and WARNs about) every teardown that still yields no summary, so if the two ever
          // separate the loss is visible instead of silent.
          if (session.finalizing) return;
          this.finalizeSession(session, session.stopRequested ? 'session closed by client' : 'upstream closed');
        },
      });
  }

  /**
   * Explicit readiness ack the client gates its first send on.
   *
   * ## The contract (TASK-985 M-22), stated here because it is the server half of a two-sided
   * promise
   *
   * ```ts
   * { type: 'ready', sessionId: string, fromSeq: number, sessionEpochMs?: number }
   * ```
   *
   * `ready` is emitted EXACTLY ONCE per socket, and only after BOTH of:
   *   1. the session is registered in `sessions` / `sessionsById` (so a `resume` or an audio
   *      frame can find it), and
   *   2. the result subscription is live (so nothing published upstream between the handshake
   *      and now is missed).
   *
   * `fromSeq` is the next seq the client should expect — `resultSeq + 1` — so a client that
   * reconnects can tell immediately whether it is behind.
   *
   * **Why the ordering is load-bearing.** `handleConnection` awaits the ticket consume and the
   * session-meta lookup. A client that sends `{type:'resume'}` the instant its socket opens
   * therefore races registration and is answered `NO_SESSION`; its resume is dropped, it
   * believes it resumed, and the transcript silently freezes while the microphone keeps
   * capturing. `ready` is the deterministic gate that closes that race — a timing guess (a
   * `setTimeout` before the first send) narrows it and cannot close it.
   *
   * **The client half is not done yet.** `SttWebSocketClient.connect()` resolves on `ws.onopen`
   * and sends its resume handshake from that same handler, and `ready` falls through its
   * message switch to `default:` and is logged as an unknown type. So the gate exists and
   * nobody stands at it. Making `connect()` resolve on `ready` (bounded by a timeout, resolving
   * with a WARN rather than rejecting so a pre-`ready` gateway still works) is L-SDK's half, in
   * both `@arcaai/vox` and `packages/vox-node`, along with documenting the frame in
   * `stt-socket-protocol.ts`.
   */
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
    // TASK-985 M-47 — the pong handler is registered HERE, beside the message handler, so the
    // grace-window rebind (which re-attaches message handling onto the new socket) re-registers
    // it too. A pong clears the miss count outright rather than decrementing it: the question
    // the counter answers is "how many consecutive pings went unanswered", and any pong makes
    // that zero.
    client.on('pong', () => {
      const session = this.sessions.get(client);
      if (session) session.missedPongs = 0;
    });
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
    // TASK-985 M-47 — a socket that just completed a handshake has, by construction, answered.
    // Carrying the dead socket's miss count onto it would terminate a healthy reconnect.
    session.missedPongs = 0;
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
    // TASK-985 M-48 — min-idle 0: the previous reader was disconnected by THIS gateway on the
    // transient drop, so its read-but-unacked results are recoverable immediately instead of
    // sitting unreclaimable for 30 s inside a 15 s grace window.
    this.subscribeSessionResults(session, { reclaimMinIdleMs: 0 });

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
    const backpressured = this.isEgressOverThreshold(session) || session.pendingFinalResults.length > 0;

    // TASK-985 M-43 — clear the once-per-episode partial-drop latch the moment the socket is
    // healthy again.
    //
    // It was cleared ONLY inside `flushPendingFinals`, which runs only while finals are queued.
    // A back-pressure episode that dropped partials but queued no final therefore left
    // `partialDropSignalled = true` FOREVER, and every later episode for the life of that
    // session was silent — the exact opposite of the comment on the field, which promises "a
    // later episode signals again". This is the one line that makes that promise true.
    if (!backpressured && session.partialDropSignalled) session.partialDropSignalled = false;

    // TASK-985 M-03 — the two latency histograms, observed on ARRIVAL at the gateway, ahead of
    // the back-pressure branch below. That placement is deliberate: both measure how long the
    // ASR took to produce a hypothesis, not whether this particular socket could receive it. A
    // partial dropped under back-pressure still proves the pipeline answered in that time, and
    // an egress problem is already counted, separately and unambiguously, by
    // `stt_gateway_audio_egress_dropped_total`. Folding egress health into a pipeline-latency
    // histogram would make a congested client look like a slow model.
    if (isTranscript) this.observeTranscriptLatency(session, msg);

    if (isTranscript && backpressured && msg.isFinal !== true) {
      session.droppedPartialResults++;
      sttGatewayAudioEgressDroppedTotal.inc({ kind: 'partial' });
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

  /**
   * TASK-985 ST-5 — the watermark is now the SESSION's, resolved once at handshake, instead of
   * a module-scope env constant fixed for the process lifetime.
   */
  private isEgressOverThreshold(session: SessionInfo): boolean {
    return this.getBufferedAmount(session.client) > session.egressHighWatermarkBytes;
  }

  /**
   * TASK-985 M-03 — observe `first_partial_seconds` and `commit_latency_seconds`.
   *
   * ## first partial
   *
   * One sample per session: the interval from the first audio frame forwarded upstream to the
   * first partial relayed back. That is the number a clinician experiences as "did it hear me",
   * and it is measured across the whole round trip the gateway is responsible for.
   *
   * ## commit latency, against the AUDIO clock
   *
   * A final carries `endTime` in seconds on the session's own audio clock. The ring buffer
   * remembers when the audio at each offset was forwarded, so the newest sample at or before
   * `endTime` is the instant the last audio of that utterance left the gateway; the delta is
   * how long the speaker waited for their sentence to go solid. Deriving it from wall clocks
   * instead would fold in client-side buffering and be unusable across a resume.
   *
   * A sample is SKIPPED, never faked, when the ring holds nothing at or before `endTime` —
   * which happens for a session resumed onto a gateway that never saw the earlier audio. An
   * invented number in a latency histogram is worse than a missing one.
   *
   * Never throws: metrics must not be able to break a caption relay.
   */
  private observeTranscriptLatency(session: SessionInfo, msg: { isFinal?: boolean; [key: string]: unknown }): void {
    const agentSlug = session.agentSlug ?? STT_GATEWAY_UNKNOWN_AGENT;

    if (msg.isFinal !== true) {
      if (!session.firstPartialObserved && session.firstFrameForwardedAt != null) {
        session.firstPartialObserved = true;
        sttGatewayFirstPartialSeconds.observe({ agentSlug }, (Date.now() - session.firstFrameForwardedAt) / 1000);
      }
      return;
    }

    const endTime = typeof msg.endTime === 'number' && Number.isFinite(msg.endTime) ? msg.endTime : undefined;
    if (endTime === undefined) return;
    const sample = this.findAudioClockSample(session, endTime);
    if (!sample) return;
    sttGatewayCommitLatencySeconds.observe({ agentSlug }, Math.max(0, Date.now() - sample.atMs) / 1000);
  }

  /**
   * Newest audio-clock sample at or before `audioSec`, by binary search.
   *
   * The ring is append-only and strictly increasing in `audioSec` (the clock never rewinds —
   * see {@link SessionInfo.audioBytesForwarded}), which is what makes a binary search valid
   * over it. Linear scanning 200 entries per FINAL would also be fine; the search is here
   * because the invariant that permits it is worth stating.
   */
  private findAudioClockSample(session: SessionInfo, audioSec: number): { audioSec: number; atMs: number } | undefined {
    const samples = session.audioClockSamples;
    let lo = 0;
    let hi = samples.length - 1;
    let found: { audioSec: number; atMs: number } | undefined;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const candidate = samples[mid]!;
      if (candidate.audioSec <= audioSec) {
        found = candidate;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return found;
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
      sttGatewayAudioEgressDroppedTotal.inc({ kind: 'final' });
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
  /**
   * TASK-985 M-43 — the `gap` contract, both reasons, documented at the one place they are
   * produced.
   *
   * ```ts
   * { type: 'gap', reason: 'egress_partial_dropped', sessionId: string, droppedPartials: number }
   * { type: 'gap', reason: 'egress_overflow',       sessionId: string, droppedSeq?: number }
   * ```
   *
   * `egress_partial_dropped` is ADVISORY: partials are drafts, and the next one supersedes
   * whatever was lost, so a client should surface it as a transient "captions are behind"
   * state and nothing more. `egress_overflow` is NOT advisory — a FINAL was dropped, so a
   * `seq` the client will never receive exists, and the content survives only in the durable
   * transcript. A client that ignores it renders a consultation with a hole in it and no
   * indication there is one.
   *
   * Neither frame is seq-tagged and neither is buffered for resume: both describe the
   * TRANSPORT's state right now, not a point in the transcript.
   *
   * Both frames are currently IGNORED by both SDKs — they fall through
   * `SttWebSocketClient.handleMessage`'s switch to `default:` and are logged as an unknown
   * message type, and `packages/vox-node`'s `RealtimeSttSocket` has no `gap` in its event map.
   * That is L-SDK's half; the server side is correct and is pinned by tests here.
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
    // (TASK-985 M-43: `relayResult` now clears this too, which is what covers an episode that
    // dropped partials without ever queueing a final — the case this poll never runs for.)
    if (!this.isEgressOverThreshold(session)) session.partialDropSignalled = false;
    while (session.pendingFinalResults.length > 0 && !this.isEgressOverThreshold(session)) {
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

    // TASK-985 M-48 — the re-emission guard the stable consumer name makes MANDATORY.
    //
    // `readResultStream` is explicitly at-least-once, and the stable consumer name now makes a
    // rebind deliberately re-read the dead reader's pending entries. Without this, a
    // redelivered result would be assigned a SECOND seq and arrive as a second, distinct
    // transcript: the client would render the same sentence twice with no way to tell they were
    // one utterance. Reusing the original seq makes redelivery exactly what the contract says
    // it is — the same message, again — and the client's own `seq` de-duplication handles it.
    const identity = this.transcriptIdentity(msg);
    if (identity !== undefined) {
      const seenSeq = session.emittedSeqByIdentity.get(identity);
      if (seenSeq !== undefined) {
        return { ...msg, seq: seenSeq };
      }
    }

    session.resultSeq += 1;
    const tagged = { ...msg, seq: session.resultSeq };
    if (identity !== undefined) session.emittedSeqByIdentity.set(identity, session.resultSeq);

    const isFinal = msg.isFinal === true;
    const utteranceIndex = typeof msg.utteranceIndex === 'number' && Number.isFinite(msg.utteranceIndex) ? msg.utteranceIndex : undefined;

    // TASK-985 ST-5 / M-38 — COALESCE superseded partials in the resume buffer.
    //
    // A partial of utterance `k` is superseded, in full, by the next partial of utterance `k`:
    // the ASR is restating the same utterance, not adding a new one. The buffer used to keep
    // every one of them and replay every one on resume, so a client that dropped for ten
    // seconds was handed ~30 stale repaints of text it would immediately overwrite. Under ST-1
    // — where a partial carries the WHOLE utterance rather than a 3 s tail — those 30 entries
    // become 30 stale WHOLE UTTERANCES, which is why D4 §3.4 calls this a PREREQUISITE of the
    // commit-geometry change rather than a parallel nicety.
    //
    // FINALS ARE NEVER COALESCED. A final is distinct clinical content; two finals are two
    // things the clinician said, even when they share an utterance index with a partial. The
    // coalescing key is therefore (utteranceIndex AND not final), never utteranceIndex alone.
    //
    // A worker that stamps no `utteranceIndex` (older STT) gets today's behaviour exactly:
    // nothing is coalesced, because nothing can be proven superseded.
    if (!isFinal && utteranceIndex !== undefined) {
      const superseded = session.resumeBuffer.findIndex((entry) => !entry.isFinal && entry.utteranceIndex === utteranceIndex);
      if (superseded >= 0) session.resumeBuffer.splice(superseded, 1);
    }

    session.resumeBuffer.push({
      seq: session.resultSeq,
      msg: tagged,
      isFinal,
      atMs: Date.now(),
      ...(utteranceIndex !== undefined ? { utteranceIndex } : {}),
    });
    if (session.resumeBuffer.length > RESUME_BUFFER_SIZE) {
      const overflow = session.resumeBuffer.length - RESUME_BUFFER_SIZE;
      const evicted = session.resumeBuffer.splice(0, overflow);
      // Only a SIZE eviction makes a seq unrecoverable. A coalesced partial is superseded, not
      // lost — its content is in the newer partial or the final that replaced it — so the two
      // removals must never share a counter. See {@link SessionInfo.evictedThroughSeq}.
      const highestEvicted = evicted[evicted.length - 1]?.seq ?? 0;
      if (highestEvicted > session.evictedThroughSeq) session.evictedThroughSeq = highestEvicted;
    }
    // The identity map is bounded in lockstep with the buffer it guards: an entry the buffer
    // can no longer replay is one no redelivery needs to be matched against either. Oldest
    // first, which for an insertion-ordered Map is iteration order.
    while (session.emittedSeqByIdentity.size > RESUME_BUFFER_SIZE) {
      const oldest = session.emittedSeqByIdentity.keys().next();
      if (oldest.done) break;
      session.emittedSeqByIdentity.delete(oldest.value);
    }
    return tagged;
  }

  /**
   * The STT-side identity of a transcript, or `undefined` when it cannot be established.
   *
   * A REDELIVERY is byte-identical to its first delivery — same Redis entry, re-read from the
   * pending list — so identity is the tuple that distinguishes two genuinely different results:
   * utterance ordinal, finality, both audio-clock bounds, and the text itself. Two consecutive
   * partials of one utterance differ in at least the text; the same entry read twice differs in
   * nothing.
   *
   * `undefined` when the worker stamps no `utteranceIndex`, which disables the guard rather
   * than guessing — degrading to exactly the pre-TASK-985 behaviour for an older STT.
   */
  private transcriptIdentity(msg: { [key: string]: unknown }): string | undefined {
    const utteranceIndex = msg.utteranceIndex;
    if (typeof utteranceIndex !== 'number' || !Number.isFinite(utteranceIndex)) return undefined;
    const isFinal = msg.isFinal === true ? '1' : '0';
    const startTime = typeof msg.startTime === 'number' ? msg.startTime : '';
    const endTime = typeof msg.endTime === 'number' ? msg.endTime : '';
    const text = typeof msg.text === 'string' ? msg.text : '';
    const resultType = typeof msg.resultType === 'string' ? msg.resultType : '';
    return `${utteranceIndex}|${isFinal}|${resultType}|${startTime}|${endTime}|${text}`;
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
      // TASK-985 M-67 — the CLIENT's own count, reported on its `client_stats` frame. Logged
      // beside the server-observed counts and never summed with them: one is measured, the
      // other is asserted by the party with the incentive to under-report.
      ...(session.clientReportedDroppedFrames != null ? { clientReportedDroppedFrames: session.clientReportedDroppedFrames } : {}),
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
    // TASK-985 ST-5 — resolved HERE rather than at import, so a control-plane write reaches the
    // next drop instead of the next pod restart. It is deliberately not resolved at handshake
    // like the watermark: the window is a property of the DISCONNECT, and a session that opened
    // an hour ago should be governed by the operator's current answer, not the one in force
    // when it started.
    const graceMs = this.resolveBudget(STT_RESUME_GRACE_MS_KEY, WS_RESUME_GRACE_MS_ENV);
    const timer = setTimeout(() => this.finalizeSession(session, 'grace window expired'), graceMs);
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
      // TASK-985 M-67 — carried onto the finalize line too, so the one log an operator greps
      // for a lost consultation holds both sides of the transport accounting.
      ...(session.clientReportedDroppedFrames != null ? { clientReportedDroppedFrames: session.clientReportedDroppedFrames } : {}),
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
      // TASK-985 QW-1 — a `close` arriving after the session is already gone is NORMAL now, not
      // an error. Finalizing on the upstream's terminal `closed` status means the gateway can
      // legitimately finish with a session while its socket is still open, so the SDK's polite
      // `close` after its drain would otherwise be answered with NO_SESSION — a scary error for
      // a client that did exactly the right thing. Every other frame still gets the error: it
      // means the client is streaming into nothing and needs to know.
      if (!isBinary && this.isCloseFrame(rawData)) {
        this.sendJson(client, { type: 'status', status: 'closed', message: 'Session already finalized' });
        client.close(1000, 'Session closed by client');
        return;
      }
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
          // TASK-951 R2 (clarified) — a JSON audio frame may carry its metadata inline. SET
          // FIRST, then forward: the value describes the audio in THIS frame, so it has to take
          // effect at the offset BEFORE these bytes advance the clock. A refusal (too large,
          // schema violation) rejects the metadata alone and the audio still flows — losing a
          // second of a consultation because a label was malformed would be the wrong trade.
          if (msg.metadata !== undefined) this.applyMetadataFrame(session, msg.metadata);
          this.forwardAudioFrame(session, seq, data);
          break;
        }

        case 'metadata': {
          // The control frame. From the session's CURRENT audio offset onward, this object is
          // the metadata in force, until the next one.
          this.applyMetadataFrame(session, msg.metadata);
          break;
        }

        case 'stop': {
          // TASK-985 QW-1 — record the client's INTENT before asking STT to finalize.
          //
          // This latch is the whole of the `interrupted` fix on the gateway side: it survives a
          // transient drop (it lives on the `SessionInfo`, which a rebind keeps), and it is
          // what lets the terminal-`closed` finalize below distinguish "the clinician ended the
          // consultation" from "the socket died". STT cannot make that distinction and does not
          // try to — `_build_teardown_summary` says so in its own docstring.
          session.stopRequested = true;
          await this.bridgeService.writeControlCommand(session.sessionId, 'finalize');
          break;
        }

        case 'client_stats': {
          // TASK-985 M-67 — the SERVER-side half of client-drop accounting.
          //
          // `droppedAudioFrames` counts failed XADDs only, so a client that discarded frames
          // before they ever reached the gateway — a saturated uplink, a full send buffer, a
          // worker that fell behind — was invisible to every server-side signal, and a
          // consultation with a hole in it looked, from here, like one the speaker was quiet
          // during. This frame carries the client's own count so the loss is at least
          // ATTRIBUTABLE. It is a claim, recorded and metered as such.
          this.recordClientStats(session, msg);
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
    // TASK-985 M-03 — the start of the `first_partial_seconds` interval. Set on SUBMISSION of
    // the first frame, for the same reason the audio clock below is: the Redis ack is
    // deliberately not awaited, and a start time that only existed after a successful write
    // would move under a transient failure.
    session.firstFrameForwardedAt ??= Date.now();
    // TASK-951 R2 (clarified) — the session's audio clock, advanced on BOTH frame kinds (this
    // is the one place binary and JSON audio converge, which is exactly why the counter lives
    // here and not at the two call sites). One addition per frame: the binary fast path keeps
    // its cost profile.
    //
    // It is counted on SUBMISSION, not on the Redis ack — the ack is deliberately not awaited
    // here, and a clock that only advanced on success would drift backwards from the ASR's
    // sample count on every transient write failure, which is the one thing it must never do.
    session.audioBytesForwarded += data.length;

    // TASK-985 M-03 — sample the audio clock against the wall clock, throttled to one entry per
    // AUDIO_CLOCK_SAMPLE_INTERVAL_SEC of audio. This is what makes commit latency measurable:
    // a final's `endTime` is an offset on this clock, and the sample at or before it says when
    // that audio left the gateway. See `observeTranscriptLatency`.
    const audioSec = this.audioSecForwarded(session);
    if (audioSec - session.lastAudioClockSampleSec >= AUDIO_CLOCK_SAMPLE_INTERVAL_SEC) {
      session.lastAudioClockSampleSec = audioSec;
      session.audioClockSamples.push({ audioSec, atMs: Date.now() });
      if (session.audioClockSamples.length > AUDIO_CLOCK_SAMPLE_CAP) {
        session.audioClockSamples.splice(0, session.audioClockSamples.length - AUDIO_CLOCK_SAMPLE_CAP);
      }
    }

    // The carrier was derived ONCE at handshake — passing it
    // here is a reference copy, not propagator work, so the 10–125 frames/s/session
    // path keeps its cost profile.
    this.bridgeService.writeAudioFrame(session.sessionId, seq, data, session.sampleRate, 'pcm_s16le', false, session.traceCarrier).catch((err) => {
      session.droppedAudioFrames++;
      // TASK-985 M-03 / M-67 (server half) — until now this count lived only in a per-session
      // log line, so a Redis blip that silently discarded a minute of a consultation's audio
      // was invisible to every dashboard.
      sttGatewayAudioIngestDroppedTotal.inc();
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

  /**
   * TASK-985 QW-1 — is this text frame a `{type:'close'}`?
   *
   * Parsed defensively and in isolation, because it runs on the path where there is NO session
   * to report an error against: anything unparseable is simply "not a close", and falls through
   * to the ordinary NO_SESSION answer.
   */
  private isCloseFrame(rawData: string | Buffer): boolean {
    try {
      const parsed = JSON.parse(Buffer.isBuffer(rawData) ? rawData.toString('utf8') : String(rawData)) as { type?: unknown };
      return parsed?.type === 'close';
    } catch {
      return false;
    }
  }

  /**
   * TASK-985 M-67 — record the client's end-of-session transport self-report.
   *
   * ## The frame
   *
   * `{ type: 'client_stats', droppedFrames?: number, sentFrames?: number }`, sent by the SDK
   * immediately before `stop`/`close`. Both fields are optional and independently validated:
   * a client that can only count one of them still gets the other recorded, and a malformed
   * value is IGNORED rather than answered with an error — a stats frame must never be able to
   * fail a consultation, and this arrives at the exact moment the client is trying to leave.
   *
   * ## Why the counter is separate from the ingest one
   *
   * `stt_gateway_audio_ingest_dropped_total` is what the gateway OBSERVED. This is what the
   * client CLAIMS. Summing them into one series would make an unverifiable number look
   * measured, and the two have genuinely different trust: a client with a bug that
   * under-reports is exactly the client whose audio is missing.
   */
  private recordClientStats(session: SessionInfo, msg: { [key: string]: unknown }): void {
    const dropped = msg.droppedFrames;
    if (typeof dropped === 'number' && Number.isFinite(dropped) && dropped >= 0) {
      session.clientReportedDroppedFrames = dropped;
      if (dropped > 0) sttGatewayClientAudioDroppedTotal.inc(dropped);
    }
    this.logger.log({
      message: 'Client reported end-of-session transport stats',
      sessionId: session.sessionId,
      ...(typeof dropped === 'number' ? { clientDroppedFrames: dropped } : {}),
      ...(typeof msg.sentFrames === 'number' ? { clientSentFrames: msg.sentFrames } : {}),
      serverDroppedAudioFrames: session.droppedAudioFrames,
    });
  }

  /**
   * The session's audio clock in SECONDS: bytes forwarded ÷ (sampleRate × 2), PCM16 LE mono.
   *
   * The same quantity `apps/stt` measures on its own side as
   * `total_samples_fed / target_sr` (`streaming/preprocessor.py`), which is what a segment's
   * `start_time`/`end_time` are derived from. Neither side transmits a timestamp; they agree
   * because they are two counters over the same audio.
   */
  private audioSecForwarded(session: SessionInfo): number {
    const bytesPerSecond = session.sampleRate * 2;
    return bytesPerSecond > 0 ? session.audioBytesForwarded / bytesPerSecond : 0;
  }

  /**
   * TASK-951 R2 (clarified) — apply one client metadata declaration to the session's timeline.
   *
   * > *"the ALaaS can send 1 or 2 or more than 2 mic ids when recordings […] hope platform must
   * > return exactly the metadata contains mic ids time-synced with the generated transcript."*
   *
   * The frame says WHAT is true, and the gateway decides WHEN: from the session's current audio
   * offset onward, until the next frame. That is why the client never sends a timestamp — it
   * cannot know how much of its audio has been forwarded, and a wall clock would not survive
   * buffering or a resume.
   *
   * Both refusals leave the SESSION UP and answer on the error channel. A metadata frame is a
   * labelling concern; closing a live consultation's socket over one would turn an attribution
   * problem into a clinical one.
   */
  private applyMetadataFrame(session: SessionInfo, raw: unknown): void {
    if (!isMetadataObject(raw)) {
      this.sendError(session.client, 'METADATA_INVALID', 'metadata must be a JSON object');
      return;
    }

    const bytes = metadataByteLength(raw);
    if (bytes > MAX_STREAM_METADATA_BYTES) {
      this.sendError(session.client, 'METADATA_TOO_LARGE', `metadata is ${bytes} bytes; the maximum is ${MAX_STREAM_METADATA_BYTES}.`);
      return;
    }

    // The schema was frozen onto the session meta at create, from the ASR agent's pinned
    // context schema. No agent resolution and no database read on the audio path — and an
    // agent that binds no stream-identity kind has no opinion, so anything within the size
    // bound is accepted (the same reading the sibling HTTP gate gives an unbound agent).
    if (session.metadataSchema) {
      const problems = jsonSchemaValueProblems(session.metadataSchema, raw, '');
      if (problems.length > 0) {
        this.sendMetadataSchemaViolation(session, problems);
        return;
      }
    }

    const next = setMetadataAt(session.metadataSpans, this.audioSecForwarded(session), raw);
    // `setMetadataAt` COALESCES a repeat of the value already in force and signals that by
    // handing back the SAME array, so a broker that re-states its mic set every few seconds
    // (a reasonable thing to do over a lossy link) neither grows the list nor rewrites Redis.
    if (next === session.metadataSpans) return;
    session.metadataSpans = next;

    // Mirrored for a reconnect onto another instance. Not awaited and never fatal: the hot copy
    // above is what serves every transcript, so a Redis blip costs resumability, not labelling.
    this.sessionBinding.bindMetadataMarks(session.sessionId, { spans: next, audioSec: this.audioSecForwarded(session) }).catch((err) =>
      this.logger.warn({
        message: 'Failed to persist stream metadata marks (in-memory timeline is unaffected)',
        sessionId: session.sessionId,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
  }

  /** The schema refusal carries `problems` — a client cannot fix a shape it is not shown. */
  private sendMetadataSchemaViolation(session: SessionInfo, problems: string[]): void {
    if (session.client.readyState !== session.client.OPEN) return;
    session.client.send(
      JSON.stringify({
        type: 'error',
        code: 'METADATA_SCHEMA_VIOLATION',
        message: 'The supplied metadata does not satisfy the schema this session’s ASR agent binds.',
        problems,
      }),
    );
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
    // TASK-985 ST-5 — the overflow guard asks "was anything the client still needs EVICTED?",
    // which is `session.evictedThroughSeq`, not `buffer[0].seq`.
    //
    // Those two were the same number until coalescing landed, and reading the second for the
    // first was a live defect: a coalesced partial leaves a hole at the FRONT of the buffer, so
    // `buffer[0].seq` jumps ahead of everything the client actually missed and an ordinary
    // reconnect got `resume_failed / buffer_overflow`. The client's only recourse is to abandon
    // the session and open a fresh one — strictly worse than the stale-partial replay the
    // coalescing removed, and it would have hit every reconnect on a session whose first
    // utterance was still in progress.
    if (lastSeq < session.evictedThroughSeq) {
      const minAvailableSeq = session.evictedThroughSeq + 1;
      this.sendJson(client, { type: 'resume_failed', sessionId: session.sessionId, reason: 'buffer_overflow', minAvailableSeq });
      return;
    }

    // Success — continuation from the NEXT unseen seq, then replay the unseen
    // buffered transcripts in order. An empty buffer (or a caught-up client)
    // still gets `resumed fromSeq: lastSeq + 1` and continues with live results.
    const unseen = buffer.filter((b) => b.seq > lastSeq);
    const toReplay = this.selectReplay(unseen);
    this.sendJson(client, { type: 'resumed', sessionId: session.sessionId, fromSeq: lastSeq + 1 });
    for (const entry of toReplay) {
      this.sendJson(client, entry.msg);
    }
    if (toReplay.length !== unseen.length) {
      this.logger.debug({
        message: 'Resume replay coalesced superseded partials (ST-5)',
        sessionId: session.sessionId,
        unseen: unseen.length,
        replayed: toReplay.length,
      });
    }
  }

  /**
   * TASK-985 ST-5 / M-38 — which unseen buffered entries are still worth replaying.
   *
   * `tagAndBuffer` already keeps at most one partial per utterance; this is the second half,
   * applied at REPLAY time because it depends on what the client missed rather than on what was
   * buffered.
   *
   * Three rules, in the order they are cheap to state:
   *
   * 1. **Every final is replayed.** A final is distinct clinical content. It is never
   *    coalesced, never aged out, and never superseded — this method must not be able to lose
   *    one.
   * 2. **A partial superseded by a final is dropped.** If the replay set contains a final for
   *    utterance `k`, every partial with `utteranceIndex <= k` is a draft of something the
   *    client is about to receive in its finished form. Replaying it makes the live region
   *    repaint backwards through text that has already been committed.
   * 3. **A partial older than `sttStreaming.resumeMaxReplayAgeMs` is dropped.** The speaker
   *    kept talking while the socket was down; a ten-second-old draft of an utterance is not
   *    what the ASR believes any more, and painting it is worse than painting nothing.
   *
   * Dropped entries leave GAPS in the replayed `seq` sequence. That is intended and safe: the
   * client's contract is "everything after `lastSeq` that still matters", it already handles
   * discontinuity (it is told about drops with `gap` frames), and a partial's seq carries no
   * clinical content of its own.
   */
  private selectReplay(unseen: BufferedTranscript[]): BufferedTranscript[] {
    const maxAgeMs = this.resolveBudget(STT_RESUME_MAX_REPLAY_AGE_MS_KEY, undefined);
    const now = Date.now();
    let highestFinalUtterance = -Infinity;
    for (const entry of unseen) {
      if (entry.isFinal && entry.utteranceIndex !== undefined && entry.utteranceIndex > highestFinalUtterance) {
        highestFinalUtterance = entry.utteranceIndex;
      }
    }
    return unseen.filter((entry) => {
      if (entry.isFinal) return true;
      if (now - entry.atMs > maxAgeMs) return false;
      if (entry.utteranceIndex !== undefined && entry.utteranceIndex <= highestFinalUtterance) return false;
      return true;
    });
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
