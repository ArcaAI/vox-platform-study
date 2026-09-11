import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import Redis from 'ioredis';
import { Observable, Subject, finalize } from 'rxjs';
import { IConfigService } from '../../baseServices/_meta/config';
import {
  TraceCarrier,
  injectTraceCarrier,
  traceCarrierFromFields,
  traceCarrierToArgs,
  withTraceContext,
} from '../../baseServices/observability/trace-propagation';
import { StreamSessionEcho, StreamingTranscriptMessage, StreamingServerMessage, StreamingStatusMessage } from './dto';
import { deriveSpeakerLabel } from './speaker-label';

/**
 * XREAD BLOCK window in milliseconds. 500 (down from
 * 2000) so a subscriber abort/unsubscribe is honored within ≤ 500 ms: the
 * abort flag is only observed between blocking reads.
 */
export const RESULT_STREAM_BLOCK_MS = 500;

/**
 * SINGLE source of truth for the audio-stream bound. This
 * bridge is the sole production writer of `stt:audio`, so this constant IS the
 * bound (the STT-v2 `streaming_audio_stream_maxlen` setting is kept equal to
 * it; that Python default only feeds the test-only `xadd_audio_frame`).
 */
export const AUDIO_STREAM_MAXLEN = 10000;

/**
 * Default consumer-group name for the `stt:result`
 * reader. The result stream is per-session, so the group name only has to
 * distinguish subscriber ROLES on it. The captions WS gateway passes a stable
 * role name (so a reconnect resumes from the group's Redis-owned cursor rather
 * than re-reading from `0-0`); other subscribers (e.g. LiveDocumentationService)
 * default to a per-subscription unique group so every subscriber still receives
 * EVERY result (fan-out preserved — a shared group would make them compete).
 */
export const RESULT_CONSUMER_GROUP_PREFIX = 'stt-bridge';

/** Options for {@link StreamingAudioBridgeService.subscribeToResults}. */
export interface SubscribeResultOptions {
  /**
   * Stable consumer-group name on `stt:result:{sessionId}`. Pass a role-stable
   * value (e.g. `'captions'`) to resume from the persisted group cursor across
   * a reconnect. Omit for a per-subscription unique group (read-all, fan-out).
   */
  consumerGroup?: string;
  /** Consumer name within the group (default: generated per subscription). */
  consumerName?: string;
  /**
   * TASK-951 R2 (D-8) — the session's client-declared context + creation epoch,
   * attached VERBATIM to every transcript this subscription emits.
   *
   * Supplied by the caller that already holds the session binding (the WS
   * gateway reads it ONCE at attach), never re-read per message: the echo is a
   * property of the SESSION, so a Redis read per transcript would buy nothing
   * and cost one round trip per utterance. Omit it — as every non-caption
   * subscriber does — and transcripts are byte-identical to today.
   *
   * TASK-951 R2 (clarified) — its third member, `metadataSpans`, is the exception to
   * "read once": it is an ACCESSOR the gateway installs, called per transcript, because the
   * client's metadata changes DURING the session. It still costs no Redis round trip — the
   * gateway serves it from the in-memory timeline it maintains on the audio path.
   */
  sessionEcho?: StreamSessionEcho;
}

/**
 * Minimum idle (ms) before the result reader reclaims another
 * consumer's pending entry via XAUTOCLAIM (dead-reader hand-off). The first
 * reclaim on start uses idle 0 to recover this consumer's own unacked pending.
 */
const RESULT_CLAIM_MIN_IDLE_MS = 30_000;

/** ioredis XAUTOCLAIM reply: `[nextCursor, [[id, fields], ...], [deletedIds]]`. */
type XAutoClaimReply = [string, Array<[string, string[]]>, string[]?] | null;

/**
 * Per-subscriber controller. `reader` is the subscriber's dedicated ioredis
 * connection — on unsubscribe we abort the loop AND immediately `disconnect()`
 * that reader so a dead client's reader stops consuming/ACKing
 * the shared consumer group at once, instead of draining it for the whole
 * grace window (which cross-instance would split the live captions).
 */
interface ResultSubscriberCtrl {
  abort: boolean;
  reader?: Redis;
}

/**
 * StreamingAudioBridgeService
 *
 * Bridges WebSocket audio from the API Gateway to STT via Redis Streams:
 * - Writes audio frames to `stt:audio:{sessionId}` via XADD
 * - Writes control commands to `stt:control:{sessionId}` via XADD
 * - Reads transcription results from `stt:result:{sessionId}` via XREAD
 *
 * Uses a dedicated ioredis connection (separate from RedisCacheService)
 * to avoid blocking the main Redis client with XREAD calls.
 *
 * This is a brand-new service for STT streaming.
 */
@Injectable()
export class StreamingAudioBridgeService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(StreamingAudioBridgeService.name);

  /** Dedicated ioredis for stream writes (XADD) */
  private writerRedis: Redis | null = null;

  /** Dedicated ioredis for stream reads (XREAD) — blocking calls */
  private readerRedis: Redis | null = null;

  /**
   * Redis connection options captured at `connect()` so each subscriber can
   * get its own reader connection.
   */
  private redisConfig: { host: string; port: number; password?: string } | null = null;

  /**
   * Live per-subscriber reader connections. A blocking
   * XREAD monopolizes its ioredis connection, so sharing one reader across
   * sessions serialized every result stream behind whichever session blocked
   * first. One connection per subscriber lets reads proceed in parallel;
   * each is quit by its own read loop on teardown.
   */
  private readonly subscriberReaders = new Set<Redis>();

  private connected = false;

  /** Timestamp the writer first went unhealthy (null when healthy). */
  private writerDegradedSince: number | null = null;
  /** Throttle writer-health logs to at most one per this window. */
  private lastWriterHealthLogAt = 0;

  /**
   * Active result subscriptions, keyed by `sessionId` → a **set** of per-reader
   * abort flags. The captions WS gateway and `LiveDocumentationService` both
   * subscribe to the same `stt:result:{sessionId}`, so a single sessionId can
   * have multiple independent readers; each gets its own controller so they
   * tear down independently. A `Set` (not a single value) is
   * what prevents the 2nd subscriber from clobbering the 1st.
   */
  private readonly activeSubscriptions = new Map<string, Set<ResultSubscriberCtrl>>();

  constructor(@Optional() @Inject(IConfigService) private readonly configService?: IConfigService) {}

  async onModuleInit(): Promise<void> {
    await this.connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.disconnect();
  }

  // ------------------------------------------------------------------
  // Connection management
  // ------------------------------------------------------------------

  async connect(): Promise<void> {
    if (this.connected) return;

    if (!this.configService?.isRedisConfigured()) {
      this.logger.warn({ message: 'Redis not configured — audio bridge disabled' });
      return;
    }

    const config = this.configService.getRedisConfig();

    this.writerRedis = new Redis({
      host: config.host,
      port: config.port,
      password: config.password,
      // Do NOT drop audio after 3 retries. `null` lets a
      // transient Redis blip queue the XADD on ioredis's FIFO offline queue and
      // flush IN ORDER on reconnect (order-preserving at-least-once), instead
      // of rejecting clinical speech. A permanent outage fails the session via
      // the reader path; the audio stream stays MAXLEN-bounded regardless.
      maxRetriesPerRequest: null,
      lazyConnect: false,
    });

    // With `maxRetriesPerRequest: null` a Redis outage queues
    // audio writes silently (offline queue grows). Surface it: log reconnect
    // attempts + errors (throttled) so an outage is visible instead of a
    // droppedAudioFrames-stays-0 blind spot. Never throws (a listener error
    // must not affect the data path).
    this.writerRedis.on('error', (err: Error) => this.logWriterHealth('error', err.message));
    this.writerRedis.on('reconnecting', () => this.logWriterHealth('reconnecting'));
    this.writerRedis.on('ready', () => {
      if (this.writerDegradedSince != null) {
        this.logger.warn({
          message: 'Audio bridge writer recovered — offline-queued audio flushing in order',
          degradedForMs: Date.now() - this.writerDegradedSince,
        });
        this.writerDegradedSince = null;
      }
    });

    this.readerRedis = new Redis({
      host: config.host,
      port: config.port,
      password: config.password,
      maxRetriesPerRequest: null, // XREAD can block
      lazyConnect: false,
    });

    this.redisConfig = { host: config.host, port: config.port, password: config.password };
    this.connected = true;
    this.logger.log({ message: 'Audio bridge Redis connections established' });
  }

  async disconnect(): Promise<void> {
    // Abort every active reader across all sessions (and drop their sockets).
    for (const controllers of this.activeSubscriptions.values()) {
      for (const ctrl of controllers) {
        this.abortSubscriber(ctrl);
      }
    }
    this.activeSubscriptions.clear();

    // Proactively quit per-subscriber readers. Their read
    // loops also self-quit after the ≤500ms BLOCK window; the double quit
    // is harmless and caught.
    for (const reader of this.subscriberReaders) {
      void reader.quit().catch(() => {});
    }
    this.subscriberReaders.clear();

    if (this.writerRedis) {
      await this.writerRedis.quit().catch(() => {});
      this.writerRedis = null;
    }
    if (this.readerRedis) {
      await this.readerRedis.quit().catch(() => {});
      this.readerRedis = null;
    }
    this.redisConfig = null;
    this.connected = false;
  }

  // ------------------------------------------------------------------
  // Audio frame forwarding (Gateway → STT)
  // ------------------------------------------------------------------

  /**
   * Forward an audio frame to STT via Redis Streams.
   *
   * @param sessionId - Streaming session identifier
   * @param seq - Monotonic sequence number
   * @param data - Raw PCM audio bytes (Buffer)
   * @param sampleRate - Audio sample rate
   * @param encoding - Audio encoding (default pcm_s16le)
   * @param isFinal - Whether this is the last frame
   * @param traceCarrier - Pre-computed W3C trace carrier for the SESSION
   *   (W3C trace context). Deliberately a parameter rather than something this
   *   method derives: audio is the latency-sensitive hop (tens of frames a
   *   second per session) and a streaming session's trace parent does not
   *   change mid-stream, so the WS gateway computes it ONCE at connect and the
   *   hot path only spreads two extra XADD arguments. Omitted / empty ⇒ the
   *   frame is byte-identical to the previous wire.
   */
  async writeAudioFrame(
    sessionId: string,
    seq: number,
    data: Buffer,
    sampleRate: number = 16000,
    encoding: string = 'pcm_s16le',
    isFinal: boolean = false,
    traceCarrier?: TraceCarrier,
  ): Promise<void> {
    if (!this.writerRedis) {
      throw new Error('Audio bridge not connected');
    }

    const streamKey = `stt:audio:${sessionId}`;

    await this.writerRedis.xadd(
      streamKey,
      'MAXLEN',
      '~',
      String(AUDIO_STREAM_MAXLEN), // Single source of truth
      '*', // Auto-generate entry ID
      'seq',
      String(seq),
      'sr',
      String(sampleRate),
      'enc',
      encoding,
      'ch',
      '1', // Mono
      'data',
      data,
      'final',
      isFinal ? '1' : '0',
      'ts',
      String(Date.now() / 1000),
      // Empty list when tracing is off — `apps/stt`'s IngestionConsumer latches
      // the first traceparent it sees and ignores the field thereafter.
      ...(traceCarrier ? traceCarrierToArgs(traceCarrier) : []),
    );
  }

  // ------------------------------------------------------------------
  // Control commands (Gateway → STT)
  // ------------------------------------------------------------------

  /**
   * Send a control command to STT.
   *
   * @param sessionId - Streaming session identifier
   * @param action - Control action: finalize, pause, resume, cancel
   */
  async writeControlCommand(sessionId: string, action: 'finalize' | 'pause' | 'resume' | 'cancel'): Promise<void> {
    if (!this.writerRedis) {
      throw new Error('Audio bridge not connected');
    }

    const streamKey = `stt:control:${sessionId}`;

    // Control is low volume (a handful of entries per session) and each command
    // is a DISTINCT caller action, so — unlike audio — the carrier is derived
    // from the ACTIVE context here. `apps/stt`'s ControlListener runs the
    // command handler under it, so a user-triggered finalize/engine-switch
    // joins the trace of the request that asked for it.
    await this.writerRedis.xadd(streamKey, '*', 'action', action, ...traceCarrierToArgs(injectTraceCarrier()));

    this.logger.log({
      message: 'Control command sent',
      sessionId,
      action,
    });
  }

  // ------------------------------------------------------------------
  // Result subscription (STT → Gateway)
  // ------------------------------------------------------------------

  /**
   * Subscribe to transcription results for a streaming session.
   *
   * Returns an Observable that emits transcription results as they
   * arrive on `stt:result:{sessionId}`. The subscription uses XREAD
   * with blocking to efficiently wait for new entries.
   *
   * @param sessionId - Streaming session identifier
   */
  subscribeToResults(sessionId: string, options?: SubscribeResultOptions): Observable<StreamingServerMessage> {
    const subject = new Subject<StreamingServerMessage>();
    const ctrl: ResultSubscriberCtrl = { abort: false };

    let controllers = this.activeSubscriptions.get(sessionId);
    if (!controllers) {
      controllers = new Set();
      this.activeSubscriptions.set(sessionId, controllers);
    }
    controllers.add(ctrl);

    const streamKey = `stt:result:${sessionId}`;

    // Read through a Redis consumer group. A role-stable
    // group (passed by the captions gateway) resumes from the group's
    // Redis-owned cursor across a reconnect; an omitted group defaults to a
    // per-subscription unique name so every subscriber still gets EVERY result
    // (fan-out), reading from the start.
    const group = options?.consumerGroup ?? `${RESULT_CONSUMER_GROUP_PREFIX}-${this.nextSubscriptionId()}`;
    const consumer = options?.consumerName ?? `reader-${this.nextSubscriptionId()}`;

    // Each subscriber reads on its OWN connection so
    // concurrent sessions never serialize behind one blocked read. When the
    // bridge is not connected, no reader starts (the observable simply never
    // emits — same posture as before).
    const reader = this.createSubscriberReader();
    if (reader) {
      ctrl.reader = reader;
      // Start reading in background
      this.readResultStream(streamKey, subject, ctrl, reader, group, consumer, options?.sessionEcho).catch((error) => {
        this.logger.error({
          message: 'Result stream reader error',
          sessionId,
          error: error instanceof Error ? error.message : String(error),
        });
        subject.error(error);
      });
    }

    return subject.asObservable().pipe(
      finalize(() => {
        // Tear down ONLY this subscriber's reader; siblings on the same
        // sessionId keep running until their own unsubscribe / teardown.
        // Disconnect the reader NOW so it stops consuming/ACKing
        // the shared group immediately (not after the ≤500ms BLOCK window).
        this.abortSubscriber(ctrl);
        const set = this.activeSubscriptions.get(sessionId);
        set?.delete(ctrl);
        if (set && set.size === 0) {
          this.activeSubscriptions.delete(sessionId);
        }
      }),
    );
  }

  /**
   * Abort a subscriber's read loop AND immediately drop its
   * dedicated connection, interrupting any in-flight blocking XREADGROUP so a
   * dead client's reader stops consuming/ACKing the shared consumer group at
   * once. Best-effort; the read loop's own `finally` still quits the reader.
   */
  private abortSubscriber(ctrl: ResultSubscriberCtrl): void {
    ctrl.abort = true;
    try {
      ctrl.reader?.disconnect();
    } catch {
      // best-effort — the read loop's finally quits it too
    }
  }

  /**
   * Unsubscribe from results for a session — aborts EVERY reader bound to it.
   * Used by the captions WS gateway on FINALIZE/close to fully end the STT
   * session. (LiveDocumentationService no longer calls this; it relies on its
   * own Observable unsubscribe so it never cross-aborts the captions reader.
   * The gateway's grace-window path likewise unsubscribes only its OWN
   * subscription on a transient disconnect, never this session-wide teardown.)
   */
  unsubscribeFromResults(sessionId: string): void {
    const controllers = this.activeSubscriptions.get(sessionId);
    if (controllers) {
      for (const ctrl of controllers) {
        this.abortSubscriber(ctrl);
      }
      this.activeSubscriptions.delete(sessionId);
    }
  }

  // ------------------------------------------------------------------
  // Private: result stream reader
  // ------------------------------------------------------------------

  /**
   * Dedicated reader connection for one subscriber.
   * Returns null when the bridge is not connected (Redis unconfigured).
   */
  private createSubscriberReader(): Redis | null {
    if (!this.connected || !this.redisConfig) {
      return null;
    }
    const reader = new Redis({
      host: this.redisConfig.host,
      port: this.redisConfig.port,
      password: this.redisConfig.password,
      maxRetriesPerRequest: null, // XREAD blocks
      lazyConnect: false,
    });
    this.subscriberReaders.add(reader);
    return reader;
  }

  /** Monotonic per-process id for default (unique) consumer group/name. */
  private subscriptionCounter = 0;

  private nextSubscriptionId(): string {
    return `${Date.now().toString(36)}-${(this.subscriptionCounter++).toString(36)}`;
  }

  private async readResultStream(
    streamKey: string,
    subject: Subject<StreamingServerMessage>,
    ctrl: ResultSubscriberCtrl,
    reader: Redis,
    group: string,
    consumer: string,
    /** TASK-951 R2 — per-session echo attached to every transcript (undefined ⇒ today's wire). */
    sessionEcho?: StreamSessionEcho,
  ): Promise<void> {
    try {
      await this.ensureResultGroup(reader, streamKey, group);

      // Drain our own pending (PEL, id '0') first so a
      // reconnect re-delivers unacked results at-least-once, THEN read new
      // (id '>'). The group's Redis-owned cursor is the persisted seed: a
      // re-subscription with the same group resumes here, never from '0-0'.
      let pelDrained = false;
      let reclaimedStale = false;

      while (!ctrl.abort) {
        try {
          // Hand off a dead reader's in-flight once on start (XAUTOCLAIM).
          if (!reclaimedStale) {
            await this.reclaimResultPending(reader, streamKey, group, consumer, subject, sessionEcho);
            reclaimedStale = true;
            if (ctrl.abort) break;
          }

          const readId = pelDrained ? '>' : '0';
          // BLOCK is 500ms so the abort flag is honored ≤ 500ms.
          const result = (await reader.xreadgroup(
            'GROUP',
            group,
            consumer,
            'COUNT',
            100,
            'BLOCK',
            RESULT_STREAM_BLOCK_MS,
            'STREAMS',
            streamKey,
            readId,
          )) as Array<[string, Array<[string, string[]]>]> | null;

          if (ctrl.abort) break;
          if (!result) {
            // With id '0' an empty reply means the PEL is drained → go live.
            if (!pelDrained) pelDrained = true;
            // Yield a macrotask so an instantly-returning read (a mocked or
            // BLOCK-0 read) can never busy-loop and starve the event loop.
            await this.yieldEventLoop();
            continue;
          }

          const ackIds: string[] = [];
          let delivered = 0;
          for (const [, entries] of result) {
            for (const [entryId, fields] of entries) {
              ackIds.push(entryId);
              delivered++;
              const terminal = this.parseAndEmitResult(subject, fields, sessionEcho);
              if (terminal) {
                // Ack what we saw, then complete on the terminal status (closed/cancelled).
                if (ackIds.length > 0) {
                  await reader.xack(streamKey, group, ...ackIds).catch(() => {});
                }
                subject.complete();
                return;
              }
            }
          }
          // At-least-once: ack only AFTER the results were emitted.
          if (ackIds.length > 0) {
            await reader.xack(streamKey, group, ...ackIds).catch(() => {});
          }
          // id '0' returned an empty batch for this stream → PEL drained.
          if (delivered === 0) {
            if (!pelDrained) pelDrained = true;
            await this.yieldEventLoop();
          }
        } catch (error) {
          if (ctrl.abort) return;
          if (this.isNoGroupError(error)) {
            // Stream/group trimmed away — recreate and retry.
            await this.ensureResultGroup(reader, streamKey, group);
            continue;
          }
          this.logger.warn({
            message: 'XREADGROUP error, retrying',
            streamKey,
            error: error instanceof Error ? error.message : String(error),
          });
          // Brief pause before retry
          await new Promise((r) => setTimeout(r, 500));
        }
      }

      subject.complete();
    } finally {
      // This subscriber's dedicated connection dies with it.
      this.subscriberReaders.delete(reader);
      await reader.quit().catch(() => {});
    }
  }

  /** Create the result consumer group (idempotent; swallows BUSYGROUP). */
  private async ensureResultGroup(reader: Redis, streamKey: string, group: string): Promise<void> {
    try {
      // Create at '0' (MKSTREAM) so the first reader sees every buffered
      // result; an existing group keeps its Redis-owned cursor (BUSYGROUP).
      await reader.xgroup('CREATE', streamKey, group, '0', 'MKSTREAM');
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (!msg.toUpperCase().includes('BUSYGROUP')) {
        this.logger.warn({ message: 'XGROUP CREATE failed (continuing)', streamKey, group, error: msg });
      }
    }
  }

  /**
   * Reclaim + emit a DEAD reader's idle pending results via
   * XAUTOCLAIM (min-idle {@link RESULT_CLAIM_MIN_IDLE_MS}), then ack them. This
   * consumer's OWN pending is recovered separately by the initial `0` (PEL)
   * read in {@link readResultStream}, so this one-shot claim targets only
   * another consumer's abandoned in-flight. Non-fatal.
   */
  private async reclaimResultPending(
    reader: Redis,
    streamKey: string,
    group: string,
    consumer: string,
    subject: Subject<StreamingServerMessage>,
    /** TASK-951 R2 — a RECLAIMED result is a result: it carries the same session echo. */
    sessionEcho?: StreamSessionEcho,
  ): Promise<void> {
    try {
      const res = (await reader.xautoclaim(streamKey, group, consumer, RESULT_CLAIM_MIN_IDLE_MS, '0-0', 'COUNT', 100)) as XAutoClaimReply;
      const claimed = Array.isArray(res) && res.length >= 2 ? res[1] : [];
      if (!claimed || claimed.length === 0) return;
      const ackIds: string[] = [];
      for (const [entryId, fields] of claimed) {
        ackIds.push(entryId);
        if (fields) this.parseAndEmitResult(subject, fields, sessionEcho);
      }
      if (ackIds.length > 0) await reader.xack(streamKey, group, ...ackIds).catch(() => {});
    } catch (error) {
      if (this.isNoGroupError(error)) {
        await this.ensureResultGroup(reader, streamKey, group);
      } else {
        this.logger.debug({
          message: 'XAUTOCLAIM failed (non-fatal)',
          streamKey,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  private isNoGroupError(error: unknown): boolean {
    const msg = error instanceof Error ? error.message : String(error);
    return msg.toUpperCase().includes('NOGROUP');
  }

  /** Yield a macrotask so an idle (empty-read) loop never starves the event loop. */
  private yieldEventLoop(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 0));
  }

  /**
   * Surface writer-connection health (throttled) so a Redis
   * outage, which silently grows the offline write queue under
   * `maxRetriesPerRequest: null`, is observable rather than a
   * droppedAudioFrames-stays-0 blind spot.
   */
  private logWriterHealth(kind: 'error' | 'reconnecting', detail?: string): void {
    const now = Date.now();
    if (this.writerDegradedSince == null) this.writerDegradedSince = now;
    if (now - this.lastWriterHealthLogAt < 5_000) return; // throttle
    this.lastWriterHealthLogAt = now;
    this.logger.warn({
      message: 'Audio bridge writer Redis degraded — audio writes are being offline-queued (M3)',
      kind,
      degradedForMs: now - this.writerDegradedSince,
      ...(detail ? { detail } : {}),
    });
  }

  /**
   * Project a `type: status` result entry onto the client-facing status frame.
   *
   * The STATUS is default-forwarded (any non-terminal value reaches the
   * client); the FIELDS are projected explicitly, because the result stream is
   * a PHI-bearing channel and a blind `{...data}` spread would put whatever a
   * future publisher adds straight onto the browser wire. The projection covers
   * everything `apps/stt` publishes on a status entry today:
   * `publish_status` emits `{type, status}` only, and
   * `publish_provider_switched` adds `from_pipeline` / `to_pipeline` /
   * `reason` / `active` / `is_fallback` / `utterance_index`
   * (`apps/stt/src/stt/streaming/redis_streams.py`). None of them carry text.
   *
   * `active` / `is_fallback` ARE relayed (closing the gap
   * this comment used to describe). Without them the v1-compat gateway's
   * `isFallback` branch was unreachable and the SDK fell back to "absent ⇒
   * fallback" — correct for primary→fallback, wrong for every switch back, so a
   * session that returned to its selected pipeline read as "on the tenant
   * default" for the rest of its life.
   *
   * `is_fallback` is COERCED to a real boolean here. The wire carries '1'/'0'
   * strings and every consumer types the field `boolean`; relaying the raw
   * string would be worse than dropping it, since '0' is truthy in JS.
   */
  private buildStatusMessage(data: Record<string, string>): StreamingStatusMessage {
    const utterance = data.utterance_index != null && data.utterance_index !== '' ? Number.parseInt(data.utterance_index, 10) : undefined;
    const isFallback =
      data.is_fallback != null && data.is_fallback !== '' ? data.is_fallback === '1' || data.is_fallback.toLowerCase() === 'true' : undefined;
    return {
      type: 'status',
      status: data.status,
      ...(data.message ? { message: data.message } : {}),
      ...(data.from_pipeline ? { from_pipeline: data.from_pipeline } : {}),
      ...(data.to_pipeline ? { to_pipeline: data.to_pipeline } : {}),
      ...(data.reason ? { reason: data.reason } : {}),
      ...(data.active === 'primary' || data.active === 'fallback' ? { active: data.active } : {}),
      ...(isFallback !== undefined ? { is_fallback: isFallback } : {}),
      ...(utterance != null && Number.isFinite(utterance) && utterance >= 0 ? { utterance_index: utterance } : {}),
    };
  }

  /**
   * Parse one result-stream entry's flat field array and emit it on `subject`.
   * Returns `true` when the entry is a TERMINAL status (`closed`/`cancelled`)
   * so the caller completes the stream. (Parsing unchanged from the XREAD path.)
   *
   * `finalizing` is NOT terminal: stt publishes it as a progress marker
   * BEFORE it flushes the tail utterance, so the result-stream order is
   * `finalizing → FINAL → closed` (session_manager `publish_status("finalizing")`
   * precedes `_flush_final_utterance`). Completing on `finalizing` would tear the
   * reader down one entry too early and orphan the closing final in Redis — the
   * session's last spoken utterance would never reach the client.
   *
   * Every NON-terminal status is RELAYED, then the
   * reader keeps reading. This is deliberately a default-forward, not an
   * allow-list: the previous `provider_switched`-only list silently swallowed
   * `finalizing`, which is exactly what the SDK's stop-drain quiet window
   * ({@link SttWebSocketClient.stopAndDrain}) listens for — the
   * Phase-F bug class the v1-compat gateway already guards against ("forward
   * every status frame"). Terminal statuses stay UNEMITTED: the WS gateway
   * synthesizes its own closing frame in `complete:`, so relaying them would
   * double-send `closed`.
   */
  private parseAndEmitResult(subject: Subject<StreamingServerMessage>, fields: string[], sessionEcho?: StreamSessionEcho): boolean {
    // The STT worker stamps its producing trace context on every result entry
    // (W3C trace context). Lift it out of the RAW field array — never out of the
    // parsed `data` object below, which holds transcript text — and emit under
    // it, so whatever a subscriber does synchronously with this transcript
    // (LiveDocumentationService persistence, the WS relay) hangs off the STT
    // span that produced it instead of starting an orphan trace.
    //
    // Propagation deliberately STOPS here: the traceparent is NOT copied onto
    // the client-facing message. Server-side trace ids are internal, and the
    // browser wire has its own drop trap — `packages/stt`'s transport hop
    // (`StreamingTranscriptEvent` mapping) projects a fixed field set, so an
    // added field would be silently discarded there anyway.
    const traceCarrier = traceCarrierFromFields(fields);
    return withTraceContext(traceCarrier, () => this.projectAndEmitResult(subject, fields, sessionEcho));
  }

  /** Field-array → client message projection (runs inside the producer's trace context). */
  private projectAndEmitResult(subject: Subject<StreamingServerMessage>, fields: string[], sessionEcho?: StreamSessionEcho): boolean {
    // Parse fields array into key-value pairs
    const data: Record<string, string> = {};
    for (let i = 0; i < fields.length; i += 2) {
      data[fields[i]] = fields[i + 1];
    }

    // Terminal only on a true end-of-session status. `finalizing` is a progress
    // marker that PRECEDES the tail final — treating it as terminal drops it.
    if (data.type === 'status') {
      const terminal = data.status === 'closed' || data.status === 'cancelled';
      // Relay every non-terminal status. `status` itself is required (the SDK's
      // `isValidStatus` guard drops a frame without one, so never send it).
      if (!terminal && data.status) {
        subject.next(this.buildStatusMessage(data));
      }
      return terminal;
    }

    // Emit transcript segment
    const speakerId = data.speaker_id || undefined;
    // Derive the human-readable label ONCE here (the single canonical
    // id→label seam) so vox/admin consumers read it off the wire, not re-derive.
    const speakerLabel = deriveSpeakerLabel(speakerId);
    const speakerConfidence = data.speaker_confidence ? parseFloat(data.speaker_confidence) : undefined;
    const englishText = data.english_text || data.englishText || undefined;
    // Per-utterance detected language (e.g. `ml-IN`) when the ASR engine reports
    // one (Sarvam/OpenAI). Surfaced as camelCase `detectedLanguage` so both the
    // v2 client and the v1-compat gateway read a REAL detection instead of an
    // echo of the requested language/mode.
    const detectedLanguage = data.language || data.detected_language || undefined;
    // The pipeline that actually produced THIS utterance;
    // absent when the upstream stt worker doesn't stamp it.
    const pipelineId = data.pipeline_id || undefined;

    // Additive committed-prefix length on partials.
    // Only relayed when present and a valid non-negative integer.
    let stableChars: number | undefined;
    if (data.stable_chars != null && data.stable_chars !== '') {
      const parsedStable = Number.parseInt(data.stable_chars, 10);
      if (Number.isFinite(parsedStable) && parsedStable >= 0) {
        stableChars = parsedStable;
      }
    }

    // Utterance ordinal on every segment
    // result (gloss results reuse the translated final's index).
    let utteranceIndex: number | undefined;
    if (data.utterance_index != null && data.utterance_index !== '') {
      const parsedUtterance = Number.parseInt(data.utterance_index, 10);
      if (Number.isFinite(parsedUtterance) && parsedUtterance >= 0) {
        utteranceIndex = parsedUtterance;
      }
    }

    // Wire `type` is 'segment' (default,
    // may be absent on old workers) or 'gloss'; anything else is
    // ignored so unknown future kinds stay additive.
    const resultType = data.type === 'segment' || data.type === 'gloss' ? data.type : undefined;

    // Parse word-level timestamps from Redis JSON field
    let wordTimestamps: StreamingTranscriptMessage['wordTimestamps'] | undefined;
    if (data.word_timestamps_json) {
      try {
        const parsed = JSON.parse(data.word_timestamps_json);
        if (Array.isArray(parsed) && parsed.length > 0) {
          wordTimestamps = parsed;
        }
      } catch {
        // Malformed JSON -- skip wordTimestamps
      }
    }

    const startTime = parseFloat(data.start_time || '0');
    const endTime = parseFloat(data.end_time || '0');

    // TASK-951 R2 (clarified) — the metadata in force over THIS segment's audio, asked for at
    // EMIT time so a mid-utterance microphone change is reported on the utterance it happened
    // during. `undefined` when the session declared an accessor but nothing was ever set (and
    // when it declared none at all), which is the difference between "no spans" and `[]`.
    const metadataSpans = sessionEcho?.metadataSpans?.(startTime, endTime);

    subject.next({
      type: 'transcript',
      text: data.text || '',
      startTime,
      endTime,
      isFinal: data.is_final === '1',
      ...(stableChars != null ? { stableChars } : {}),
      ...(utteranceIndex != null ? { utteranceIndex } : {}),
      ...(resultType ? { resultType } : {}),
      ...(englishText ? { englishText } : {}),
      ...(detectedLanguage ? { detectedLanguage } : {}),
      ...(pipelineId ? { pipelineId } : {}),
      ...(speakerId ? { speakerId } : {}),
      ...(speakerLabel ? { speakerLabel } : {}),
      ...(speakerConfidence != null && !isNaN(speakerConfidence) ? { speakerConfidence } : {}),
      ...(wordTimestamps ? { wordTimestamps } : {}),
      // TASK-951 R2 (D-8) — the session's client-declared context, VERBATIM, and the
      // gateway's session epoch. Spread LAST but they cannot collide: `context` and
      // `sessionEpochMs` are gateway-owned names that `apps/stt` never publishes on
      // `stt:result` (no Python change was needed for this ticket, by design).
      //
      // Both ride only on a session that declared a context, so a session without one
      // emits exactly the fields it emitted before this ticket.
      ...(sessionEcho?.context ? { context: sessionEcho.context } : {}),
      ...(sessionEcho?.context && sessionEcho.sessionEpochMs != null ? { sessionEpochMs: sessionEcho.sessionEpochMs } : {}),
      // TASK-951 R2 (clarified) — the time-synced half. Spread on a non-empty array only: a
      // session that never sent a `metadata` frame must not start shipping an empty array to
      // every consumer that has been parsing this wire for a year. Independent of `context`
      // above — a client may use either, both or neither.
      ...(metadataSpans && metadataSpans.length > 0 ? { metadata: metadataSpans } : {}),
    });
    return false;
  }
}
