import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import Redis from 'ioredis';
import { Observable, Subject, finalize } from 'rxjs';
import { IConfigService } from '../../baseServices/_meta/config';
import { StreamingTranscriptMessage } from './dto';

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

  private connected = false;

  /** Active result subscriptions (sessionId → abort controller) */
  private readonly activeSubscriptions = new Map<string, { abort: boolean }>();

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
      maxRetriesPerRequest: 3,
      lazyConnect: false,
    });

    this.readerRedis = new Redis({
      host: config.host,
      port: config.port,
      password: config.password,
      maxRetriesPerRequest: null, // XREAD can block
      lazyConnect: false,
    });

    this.connected = true;
    this.logger.log({ message: 'Audio bridge Redis connections established' });
  }

  async disconnect(): Promise<void> {
    // Abort all active subscriptions
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    for (const [sessionId, ctrl] of this.activeSubscriptions) {
      ctrl.abort = true;
    }
    this.activeSubscriptions.clear();

    if (this.writerRedis) {
      await this.writerRedis.quit().catch(() => {});
      this.writerRedis = null;
    }
    if (this.readerRedis) {
      await this.readerRedis.quit().catch(() => {});
      this.readerRedis = null;
    }
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
      '10000', // Cap stream at ~10K entries
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
  subscribeToResults(sessionId: string): Observable<StreamingTranscriptMessage> {
    const subject = new Subject<StreamingTranscriptMessage>();
    const ctrl = { abort: false };
    this.activeSubscriptions.set(sessionId, ctrl);

    const streamKey = `stt:result:${sessionId}`;

    // Start reading in background
    this.readResultStream(streamKey, subject, ctrl).catch((error) => {
      this.logger.error({
        message: 'Result stream reader error',
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
      subject.error(error);
    });

    return subject.asObservable().pipe(
      finalize(() => {
        ctrl.abort = true;
        this.activeSubscriptions.delete(sessionId);
      }),
    );
  }

  /**
   * Unsubscribe from results for a session.
   */
  unsubscribeFromResults(sessionId: string): void {
    const ctrl = this.activeSubscriptions.get(sessionId);
    if (ctrl) {
      ctrl.abort = true;
      this.activeSubscriptions.delete(sessionId);
    }
  }

  // ------------------------------------------------------------------
  // Private: result stream reader
  // ------------------------------------------------------------------

  private async readResultStream(streamKey: string, subject: Subject<StreamingTranscriptMessage>, ctrl: { abort: boolean }): Promise<void> {
    if (!this.readerRedis) return;

    let lastId = '0-0';

    while (!ctrl.abort) {
      try {
        // XREAD with 2-second blocking timeout
        const result = await this.readerRedis.xread('COUNT', 100, 'BLOCK', 2000, 'STREAMS', streamKey, lastId);

        if (!result || ctrl.abort) continue;

        for (const [, entries] of result) {
          for (const [entryId, fields] of entries) {
            lastId = entryId;

            // Parse fields array into key-value pairs
            const data: Record<string, string> = {};
            for (let i = 0; i < fields.length; i += 2) {
              data[fields[i]] = fields[i + 1];
            }

            // Check if this is a status entry (session closed)
            if (data.type === 'status') {
              if (data.status === 'closed' || data.status === 'finalizing') {
                subject.complete();
                return;
              }
              continue;
            }

            // Emit transcript segment
            const speakerId = data.speaker_id || undefined;
            const speakerConfidence = data.speaker_confidence ? parseFloat(data.speaker_confidence) : undefined;
            const englishText = data.english_text || data.englishText || undefined;

            subject.next({
              type: 'transcript',
              text: data.text || '',
              startTime: parseFloat(data.start_time || '0'),
              endTime: parseFloat(data.end_time || '0'),
              isFinal: data.is_final === '1',
              ...(englishText ? { englishText } : {}),
              ...(speakerId ? { speakerId } : {}),
              ...(speakerConfidence != null && !isNaN(speakerConfidence) ? { speakerConfidence } : {}),
            });
          }
        }
      } catch (error) {
        if (ctrl.abort) return;
        this.logger.warn({
          message: 'XREAD error, retrying',
          streamKey,
          error: error instanceof Error ? error.message : String(error),
        });
        // Brief pause before retry
        await new Promise((r) => setTimeout(r, 500));
      }
    }

    subject.complete();
  }
}
