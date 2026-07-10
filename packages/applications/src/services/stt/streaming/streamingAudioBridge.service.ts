import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import Redis from 'ioredis';
import { Observable, Subject, finalize } from 'rxjs';
import { IConfigService } from '../../baseServices/_meta/config';
import { StreamingTranscriptMessage } from './dto';

/**
 * TASK-351 P1-3 (H5) — XREAD BLOCK window in milliseconds. 500 (down from
 * 2000) so a subscriber abort/unsubscribe is honored within ≤ 500 ms: the
 * abort flag is only observed between blocking reads.
 */
export const RESULT_STREAM_BLOCK_MS = 500;

/**
 * TASK-457 C3-06 — SINGLE source of truth for the audio-stream bound. This
 * bridge is the sole production writer of `stt:audio`, so this constant IS the
 * bound (the STT-v2 `streaming_audio_stream_maxlen` setting is kept equal to
 * it; that Python default only feeds the test-only `xadd_audio_frame`).
 */
export const AUDIO_STREAM_MAXLEN = 10000;

/**
 * TASK-457 C3-01/C3-02 — default consumer-group name for the `stt:result`
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
}

/**
 * TASK-457 — minimum idle (ms) before the result reader reclaims another
 * consumer's pending entry via XAUTOCLAIM (dead-reader hand-off). The first
 * reclaim on start uses idle 0 to recover this consumer's own unacked pending.
 */
const RESULT_CLAIM_MIN_IDLE_MS = 30_000;

/** ioredis XAUTOCLAIM reply: `[nextCursor, [[id, fields], ...], [deletedIds]]`. */
type XAutoClaimReply = [string, Array<[string, string[]]>, string[]?] | null;

/**
 * StreamingAudioBridgeService
 *
 * Bridges WebSocket audio from the API Gateway to STT-V2 via Redis Streams:
 * - Writes audio frames to `stt:audio:{sessionId}` via XADD
 * - Writes control commands to `stt:control:{sessionId}` via XADD
 * - Reads transcription results from `stt:result:{sessionId}` via XREAD
 *
 * Uses a dedicated ioredis connection (separate from RedisCacheService)
 * to avoid blocking the main Redis client with XREAD calls.
 *
 * This is a brand-new service for STT-V2 streaming.
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
   * get its own reader connection (TASK-351 P1-3 / H5).
   */
  private redisConfig: { host: string; port: number; password?: string } | null = null;

  /**
   * Live per-subscriber reader connections (TASK-351 P1-3 / H5). A blocking
   * XREAD monopolizes its ioredis connection, so sharing one reader across
   * sessions serialized every result stream behind whichever session blocked
   * first. One connection per subscriber lets reads proceed in parallel;
   * each is quit by its own read loop on teardown.
   */
  private readonly subscriberReaders = new Set<Redis>();

  private connected = false;

  /**
   * Active result subscriptions, keyed by `sessionId` → a **set** of per-reader
   * abort flags. The captions WS gateway and `LiveDocumentationService` both
   * subscribe to the same `stt:result:{sessionId}`, so a single sessionId can
   * have multiple independent readers; each gets its own controller so they
   * tear down independently (TASK-340 P1-B). A `Set` (not a single value) is
   * what prevents the 2nd subscriber from clobbering the 1st.
   */
  private readonly activeSubscriptions = new Map<string, Set<{ abort: boolean }>>();

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
      // TASK-457 C3-02 — do NOT drop audio after 3 retries. `null` lets a
      // transient Redis blip queue the XADD on ioredis's FIFO offline queue and
      // flush IN ORDER on reconnect (order-preserving at-least-once), instead
      // of rejecting clinical speech. A permanent outage fails the session via
      // the reader path; the audio stream stays MAXLEN-bounded regardless.
      maxRetriesPerRequest: null,
      lazyConnect: false,
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
    // Abort every active reader across all sessions.
    for (const controllers of this.activeSubscriptions.values()) {
      for (const ctrl of controllers) {
        ctrl.abort = true;
      }
    }
    this.activeSubscriptions.clear();

    // Proactively quit per-subscriber readers (TASK-351 P1-3). Their read
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
  // Audio frame forwarding (Gateway → STT-V2)
  // ------------------------------------------------------------------

  /**
   * Forward an audio frame to STT-V2 via Redis Streams.
   *
   * @param sessionId - Streaming session identifier
   * @param seq - Monotonic sequence number
   * @param data - Raw PCM audio bytes (Buffer)
   * @param sampleRate - Audio sample rate
   * @param encoding - Audio encoding (default pcm_s16le)
   * @param isFinal - Whether this is the last frame
   */
  async writeAudioFrame(
    sessionId: string,
    seq: number,
    data: Buffer,
    sampleRate: number = 16000,
    encoding: string = 'pcm_s16le',
    isFinal: boolean = false,
  ): Promise<void> {
    if (!this.writerRedis) {
      throw new Error('Audio bridge not connected');
    }

    const streamKey = `stt:audio:${sessionId}`;

    await this.writerRedis.xadd(
      streamKey,
      'MAXLEN',
      '~',
      String(AUDIO_STREAM_MAXLEN), // TASK-457 C3-06 — single source of truth
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
    );
  }

  // ------------------------------------------------------------------
  // Control commands (Gateway → STT-V2)
  // ------------------------------------------------------------------

  /**
   * Send a control command to STT-V2.
   *
   * @param sessionId - Streaming session identifier
   * @param action - Control action: finalize, pause, resume, cancel
   */
  async writeControlCommand(sessionId: string, action: 'finalize' | 'pause' | 'resume' | 'cancel'): Promise<void> {
    if (!this.writerRedis) {
      throw new Error('Audio bridge not connected');
    }

    const streamKey = `stt:control:${sessionId}`;

    await this.writerRedis.xadd(streamKey, '*', 'action', action);

    this.logger.log({
      message: 'Control command sent',
      sessionId,
      action,
    });
  }

  // ------------------------------------------------------------------
  // Result subscription (STT-V2 → Gateway)
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
  subscribeToResults(sessionId: string, options?: SubscribeResultOptions): Observable<StreamingTranscriptMessage> {
    const subject = new Subject<StreamingTranscriptMessage>();
    const ctrl = { abort: false };

    let controllers = this.activeSubscriptions.get(sessionId);
    if (!controllers) {
      controllers = new Set();
      this.activeSubscriptions.set(sessionId, controllers);
    }
    controllers.add(ctrl);

    const streamKey = `stt:result:${sessionId}`;

    // TASK-457 C3-01 — read through a Redis consumer group. A role-stable
    // group (passed by the captions gateway) resumes from the group's
    // Redis-owned cursor across a reconnect; an omitted group defaults to a
    // per-subscription unique name so every subscriber still gets EVERY result
    // (fan-out), reading from the start.
    const group = options?.consumerGroup ?? `${RESULT_CONSUMER_GROUP_PREFIX}-${this.nextSubscriptionId()}`;
    const consumer = options?.consumerName ?? `reader-${this.nextSubscriptionId()}`;

    // TASK-351 P1-3 (H5) — each subscriber reads on its OWN connection so
    // concurrent sessions never serialize behind one blocked read. When the
    // bridge is not connected, no reader starts (the observable simply never
    // emits — same posture as before).
    const reader = this.createSubscriberReader();
    if (reader) {
      // Start reading in background
      this.readResultStream(streamKey, subject, ctrl, reader, group, consumer).catch((error) => {
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
        ctrl.abort = true;
        const set = this.activeSubscriptions.get(sessionId);
        set?.delete(ctrl);
        if (set && set.size === 0) {
          this.activeSubscriptions.delete(sessionId);
        }
      }),
    );
  }

  /**
   * Unsubscribe from results for a session — aborts EVERY reader bound to it.
   * Used by the captions WS gateway on disconnect/close to fully end the STT
   * session. (LiveDocumentationService no longer calls this; it relies on its
   * own Observable unsubscribe so it never cross-aborts the captions reader.)
   */
  unsubscribeFromResults(sessionId: string): void {
    const controllers = this.activeSubscriptions.get(sessionId);
    if (controllers) {
      for (const ctrl of controllers) {
        ctrl.abort = true;
      }
      this.activeSubscriptions.delete(sessionId);
    }
  }

  // ------------------------------------------------------------------
  // Private: result stream reader
  // ------------------------------------------------------------------

  /**
   * TASK-351 P1-3 (H5) — dedicated reader connection for one subscriber.
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
    subject: Subject<StreamingTranscriptMessage>,
    ctrl: { abort: boolean },
    reader: Redis,
    group: string,
    consumer: string,
  ): Promise<void> {
    try {
      await this.ensureResultGroup(reader, streamKey, group);

      // TASK-457 C3-01 — drain our own pending (PEL, id '0') first so a
      // reconnect re-delivers unacked results at-least-once, THEN read new
      // (id '>'). The group's Redis-owned cursor is the persisted seed: a
      // re-subscription with the same group resumes here, never from '0-0'.
      let pelDrained = false;
      let reclaimedStale = false;

      while (!ctrl.abort) {
        try {
          // Hand off a dead reader's in-flight once on start (XAUTOCLAIM).
          if (!reclaimedStale) {
            await this.reclaimResultPending(reader, streamKey, group, consumer, subject);
            reclaimedStale = true;
            if (ctrl.abort) break;
          }

          const readId = pelDrained ? '>' : '0';
          // BLOCK is 500ms (TASK-351 P1-3) so the abort flag is honored ≤ 500ms.
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
              const terminal = this.parseAndEmitResult(subject, fields);
              if (terminal) {
                // Ack what we saw, then complete on closed/finalizing.
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
      // TASK-351 P1-3 — this subscriber's dedicated connection dies with it.
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
   * TASK-457 — reclaim + emit another (dead) reader's idle pending results via
   * XAUTOCLAIM, then ack them. Idle 0 also recovers this consumer's own pending
   * on start. Non-fatal.
   */
  private async reclaimResultPending(
    reader: Redis,
    streamKey: string,
    group: string,
    consumer: string,
    subject: Subject<StreamingTranscriptMessage>,
  ): Promise<void> {
    try {
      const res = (await reader.xautoclaim(streamKey, group, consumer, RESULT_CLAIM_MIN_IDLE_MS, '0-0', 'COUNT', 100)) as XAutoClaimReply;
      const claimed = Array.isArray(res) && res.length >= 2 ? res[1] : [];
      if (!claimed || claimed.length === 0) return;
      const ackIds: string[] = [];
      for (const [entryId, fields] of claimed) {
        ackIds.push(entryId);
        if (fields) this.parseAndEmitResult(subject, fields);
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
   * Parse one result-stream entry's flat field array and emit it on `subject`.
   * Returns `true` when the entry is a terminal status (closed/finalizing) so
   * the caller completes the stream. (Parsing unchanged from the XREAD path.)
   */
  private parseAndEmitResult(subject: Subject<StreamingTranscriptMessage>, fields: string[]): boolean {
    // Parse fields array into key-value pairs
    const data: Record<string, string> = {};
    for (let i = 0; i < fields.length; i += 2) {
      data[fields[i]] = fields[i + 1];
    }

    // Check if this is a status entry (session closed)
    if (data.type === 'status') {
      return data.status === 'closed' || data.status === 'finalizing';
    }

    // Emit transcript segment
    const speakerId = data.speaker_id || undefined;
    const speakerConfidence = data.speaker_confidence ? parseFloat(data.speaker_confidence) : undefined;
    const englishText = data.english_text || data.englishText || undefined;

    // TASK-351 P1-1 — additive committed-prefix length on partials.
    // Only relayed when present and a valid non-negative integer.
    let stableChars: number | undefined;
    if (data.stable_chars != null && data.stable_chars !== '') {
      const parsedStable = Number.parseInt(data.stable_chars, 10);
      if (Number.isFinite(parsedStable) && parsedStable >= 0) {
        stableChars = parsedStable;
      }
    }

    // TASK-351 P1-1 follow-up — utterance ordinal on every segment
    // result (gloss results reuse the translated final's index).
    let utteranceIndex: number | undefined;
    if (data.utterance_index != null && data.utterance_index !== '') {
      const parsedUtterance = Number.parseInt(data.utterance_index, 10);
      if (Number.isFinite(parsedUtterance) && parsedUtterance >= 0) {
        utteranceIndex = parsedUtterance;
      }
    }

    // TASK-351 P1-1 follow-up — wire `type` is 'segment' (default,
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

    subject.next({
      type: 'transcript',
      text: data.text || '',
      startTime: parseFloat(data.start_time || '0'),
      endTime: parseFloat(data.end_time || '0'),
      isFinal: data.is_final === '1',
      ...(stableChars != null ? { stableChars } : {}),
      ...(utteranceIndex != null ? { utteranceIndex } : {}),
      ...(resultType ? { resultType } : {}),
      ...(englishText ? { englishText } : {}),
      ...(speakerId ? { speakerId } : {}),
      ...(speakerConfidence != null && !isNaN(speakerConfidence) ? { speakerConfidence } : {}),
      ...(wordTimestamps ? { wordTimestamps } : {}),
    });
    return false;
  }
}
