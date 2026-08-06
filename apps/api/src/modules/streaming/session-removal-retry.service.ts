/**
 * `SessionRemovalRetryService`.
 *
 * The WS gateway removes the upstream STT-v2 session with a fire-and-forget
 * `removeSession` on disconnect. When that DELETE fails (STT-v2 restart,
 * network blip), the Python session used to stay leaked until its 60s
 * inactivity reaper. This service parks the session id on a Redis-backed
 * retry set and retries the removal with exponential backoff:
 *
 *   - `stt:session-removal:retry` (Redis SET, TTL-bounded like the sibling
 *     `stream-session-*` keys) records every parked id so a leak is visible
 *     to ops even across an API restart.
 *   - In-process timers drive bounded retries (base 1s, doubling). A
 *     successful retry removes the id from the set; exhausted retries log
 *     an error and leave the entry for the TTL to reclaim (the STT-v2
 *     inactivity reaper remains the final backstop).
 *
 * Redis being down never blocks the in-process retries — persistence is
 * best-effort accounting, the retries themselves are what un-leak sessions.
 */
import { IRedisCacheService, StreamingSessionService } from '@arcaai/applications';
import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';

/** Redis SET holding session ids whose upstream removal is pending retry. */
export const SESSION_REMOVAL_RETRY_SET_KEY = 'stt:session-removal:retry';

/** Bounded retry budget per session id. */
export const SESSION_REMOVAL_RETRY_MAX_ATTEMPTS = 5;

/** First retry delay; doubles per attempt (1s, 2s, 4s, 8s, 16s). */
export const SESSION_REMOVAL_RETRY_BASE_DELAY_MS = 1_000;

/** TTL refreshed on every enqueue — matches the stream-session key posture. */
export const SESSION_REMOVAL_RETRY_TTL_SECONDS = 24 * 60 * 60;

@Injectable()
export class SessionRemovalRetryService implements OnModuleDestroy {
  private readonly logger = new Logger(SessionRemovalRetryService.name);

  /** Pending in-process retry timers, cancelled on shutdown. */
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private destroyed = false;

  constructor(
    private readonly sessionService: StreamingSessionService,
    @Inject(IRedisCacheService) private readonly cache: IRedisCacheService,
  ) {}

  onModuleDestroy(): void {
    this.destroyed = true;
    for (const timer of this.timers) {
      clearTimeout(timer);
    }
    this.timers.clear();
  }

  /**
   * Park a session whose upstream removal failed and start the bounded
   * backoff retries. Fire-and-forget safe: never throws.
   *
   * TASK-615 WS-C: `interrupted` carries through to every retry's
   * `removeSession` call. This method is ONLY ever reached from the WS
   * gateway's `finalizeSession` (an explicit close's removeSession failing
   * is just as retryable as an abort's), so the caller's own `interrupted`
   * determination is the one that matters — never recomputed here.
   */
  enqueue(sessionId: string, interrupted = false): void {
    if (!sessionId || this.destroyed) {
      return;
    }

    void this.persist(sessionId);
    this.scheduleAttempt(sessionId, 1, interrupted);

    this.logger.warn({
      message: 'Session removal failed — parked for retry (TASK-351 P1-3)',
      sessionId,
      maxAttempts: SESSION_REMOVAL_RETRY_MAX_ATTEMPTS,
    });
  }

  /** Best-effort Redis accounting; a Redis blip must not stop the retries. */
  private async persist(sessionId: string): Promise<void> {
    try {
      await this.cache.sadd(SESSION_REMOVAL_RETRY_SET_KEY, sessionId);
      await this.cache.expire(SESSION_REMOVAL_RETRY_SET_KEY, SESSION_REMOVAL_RETRY_TTL_SECONDS);
    } catch (err) {
      this.logger.warn({
        message: 'Failed to persist session-removal retry entry — retrying in-process only',
        sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private scheduleAttempt(sessionId: string, attempt: number, interrupted: boolean): void {
    if (this.destroyed) {
      return;
    }
    if (attempt > SESSION_REMOVAL_RETRY_MAX_ATTEMPTS) {
      this.logger.error({
        message: 'Session removal retries exhausted — session may stay leaked until the STT-v2 inactivity reaper',
        sessionId,
        attempts: SESSION_REMOVAL_RETRY_MAX_ATTEMPTS,
        retrySetKey: SESSION_REMOVAL_RETRY_SET_KEY,
      });
      return;
    }

    const delayMs = SESSION_REMOVAL_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1);
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      void this.attempt(sessionId, attempt, interrupted);
    }, delayMs);
    (timer as unknown as { unref?: () => void }).unref?.();
    this.timers.add(timer);
  }

  private async attempt(sessionId: string, attempt: number, interrupted: boolean): Promise<void> {
    if (this.destroyed) {
      return;
    }
    try {
      await this.sessionService.removeSession(sessionId, interrupted);
      await this.cache.srem(SESSION_REMOVAL_RETRY_SET_KEY, sessionId).catch(() => {});
      this.logger.log({
        message: 'Session removal retry succeeded',
        sessionId,
        attempt,
      });
    } catch (err) {
      this.logger.warn({
        message: 'Session removal retry failed',
        sessionId,
        attempt,
        maxAttempts: SESSION_REMOVAL_RETRY_MAX_ATTEMPTS,
        error: err instanceof Error ? err.message : String(err),
      });
      this.scheduleAttempt(sessionId, attempt + 1, interrupted);
    }
  }
}
