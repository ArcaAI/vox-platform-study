import { Injectable, Logger, OnModuleInit, OnModuleDestroy, Inject, Optional } from '@nestjs/common';
import Redis from 'ioredis';
import { Observable, Subject, finalize } from 'rxjs';
import { IConfigService } from '../../baseServices/_meta/config';

/**
 * Dedicated Redis Subscriber Service
 *
 * Redis requires that a connection in SUBSCRIBE mode cannot execute
 * other commands, so this must be a **separate connection** from the
 * RedisCacheService (which handles get/set/publish).
 *
 * This service manages per-channel subscriptions using RxJS Subjects.
 * Multiple callers can subscribe to the same channel — they share
 * the underlying Redis subscription via reference counting.
 *
 * Used by: TranscriptionRealtimeService (SSE event delivery)
 * Channel pattern: stt:transcription:{jobId}
 */
@Injectable()
export class RedisSubscriberService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisSubscriberService.name);

  /** Dedicated ioredis client in subscriber mode */
  private subscriber: Redis | null = null;

  /** Per-channel Subject that dispatches messages to observers */
  private readonly channels = new Map<string, Subject<string>>();

  /** Reference count per channel (how many active observers) */
  private readonly refCounts = new Map<string, number>();

  private connected = false;

  constructor(@Optional() @Inject(IConfigService) private readonly configService?: IConfigService) {}

  async onModuleInit(): Promise<void> {
    await this.connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.disconnect();
  }

  /**
   * Connect the subscriber Redis client.
   *
   * Uses the same Redis connection config as RedisCacheService
   * (via IConfigService.getRedisConfig()) but creates a separate
   * connection dedicated to SUBSCRIBE mode.
   */
  private async connect(): Promise<void> {
    if (!this.configService) {
      this.logger.warn({
        message: 'ConfigService not available — subscriber disabled',
      });
      return;
    }

    if (!this.configService.isRedisConfigured()) {
      this.logger.warn({
        message: 'Redis not configured — subscriber disabled',
      });
      return;
    }

    try {
      const config = this.configService.getRedisConfig();

      this.subscriber = new Redis({
        host: config.host,
        port: config.port,
        password: config.password,
        retryStrategy: (times) => {
          if (times > 3) {
            this.logger.error({
              message: 'Redis subscriber connection failed after retries',
              retries: times,
            });
            return null;
          }
          return Math.min(times * 200, 2000);
        },
        maxRetriesPerRequest: null, // Required for subscriber mode
        enableReadyCheck: true,
        lazyConnect: false,
      });

      this.subscriber.on('connect', () => {
        this.connected = true;
        this.logger.log({
          message: 'Redis subscriber connected',
          host: config.host,
          port: config.port,
        });
      });

      this.subscriber.on('error', (error) => {
        this.logger.error({
          message: 'Redis subscriber error',
          error: error.message,
        });
        this.connected = false;
      });

      this.subscriber.on('close', () => {
        this.connected = false;
        this.logger.warn({ message: 'Redis subscriber connection closed' });
      });

      // Dispatch incoming messages to the correct channel Subject
      this.subscriber.on('message', (channel: string, message: string) => {
        const subject = this.channels.get(channel);
        if (subject) {
          subject.next(message);
        }
      });
    } catch (error) {
      this.logger.error({
        message: 'Failed to initialize Redis subscriber',
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Disconnect and clean up all subscriptions.
   */
  private async disconnect(): Promise<void> {
    // Complete all active subjects
    for (const [channel, subject] of this.channels.entries()) {
      subject.complete();
      this.channels.delete(channel);
    }
    this.refCounts.clear();

    if (this.subscriber) {
      try {
        await this.subscriber.quit();
      } catch (error) {
        this.logger.warn({
          message: 'Error disconnecting Redis subscriber',
          error: error instanceof Error ? error.message : String(error),
        });
      }
      this.subscriber = null;
      this.connected = false;
    }
  }

  /**
   * Subscribe to a Redis channel.
   *
   * Returns a Promise that resolves to an Observable emitting each message
   * published to that channel. The Promise resolves only after the Redis
   * SUBSCRIBE command completes, ensuring no events are missed.
   *
   * Multiple callers can subscribe to the same channel — they share
   * the underlying Redis subscription. When the last observer unsubscribes,
   * the Redis subscription is removed.
   *
   * @param channel - Redis channel name (e.g. "stt:transcription:{jobId}")
   * @returns Promise resolving to Observable that emits raw JSON message strings
   */
  async subscribeToChannel(channel: string): Promise<Observable<string>> {
    if (!this.subscriber || !this.connected) {
      this.logger.warn({
        message: 'Cannot subscribe — Redis subscriber not connected',
        channel,
      });
      // Return an Observable that completes immediately
      return new Observable((subscriber) => {
        subscriber.complete();
      });
    }

    // Create a new Subject for this channel if it doesn't exist
    if (!this.channels.has(channel)) {
      const subject = new Subject<string>();
      this.channels.set(channel, subject);
      this.refCounts.set(channel, 0);

      // Subscribe at the Redis level — await to ensure no events are missed
      try {
        await this.subscriber.subscribe(channel);
        this.logger.log({
          message: 'Subscribed to Redis channel',
          channel,
        });
      } catch (error) {
        this.logger.error({
          message: 'Failed to subscribe to Redis channel',
          channel,
          error: error instanceof Error ? error.message : String(error),
        });
        this.channels.delete(channel);
        this.refCounts.delete(channel);
        subject.error(error);
        throw error;
      }
    }

    // Increment reference count
    const currentCount = this.refCounts.get(channel) ?? 0;
    this.refCounts.set(channel, currentCount + 1);

    const subject = this.channels.get(channel)!;

    // Return an Observable that decrements refCount on unsubscribe
    return subject.asObservable().pipe(
      finalize(() => {
        this.decrementAndCleanup(channel);
      }),
    );
  }

  /**
   * Explicitly unsubscribe from a channel.
   * Completes all observers and removes the Redis subscription.
   */
  unsubscribeFromChannel(channel: string): void {
    const subject = this.channels.get(channel);
    if (subject) {
      subject.complete();
      this.channels.delete(channel);
      this.refCounts.delete(channel);

      if (this.subscriber && this.connected) {
        this.subscriber.unsubscribe(channel).catch((error) => {
          this.logger.warn({
            message: 'Error unsubscribing from Redis channel',
            channel,
            error: error instanceof Error ? error.message : String(error),
          });
        });
      }

      this.logger.log({
        message: 'Unsubscribed from Redis channel',
        channel,
      });
    }
  }

  /**
   * Check if the subscriber is connected and available.
   */
  isConnected(): boolean {
    return this.connected && this.subscriber !== null;
  }

  /**
   * Decrement reference count for a channel. If count reaches 0,
   * unsubscribe from Redis and clean up the Subject.
   */
  private decrementAndCleanup(channel: string): void {
    const count = this.refCounts.get(channel) ?? 0;
    const newCount = Math.max(0, count - 1);

    if (newCount === 0) {
      this.unsubscribeFromChannel(channel);
    } else {
      this.refCounts.set(channel, newCount);
    }
  }
}
