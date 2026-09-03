/**
 * SessionRemovalRetryService unit tests.
 *
 * When the gateway's fire-and-forget `removeSession` fails on WS disconnect,
 * the session id is parked on a Redis-backed retry set and the upstream
 * DELETE is retried with exponential backoff (bounded attempts) so STT-v2
 * sessions are not leaked until the 60s inactivity reaper.
 */

import { Logger } from '@nestjs/common';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import {
  SESSION_REMOVAL_RETRY_BASE_DELAY_MS,
  SESSION_REMOVAL_RETRY_MAX_ATTEMPTS,
  SESSION_REMOVAL_RETRY_SET_KEY,
  SessionRemovalRetryService,
} from '../session-removal-retry.service';

const createMockSessionService = () => ({
  removeSession: vi.fn().mockResolvedValue(undefined),
});

const createMockCache = () => ({
  sadd: vi.fn().mockResolvedValue(1),
  srem: vi.fn().mockResolvedValue(1),
  expire: vi.fn().mockResolvedValue(true),
});

/** Total time that covers every scheduled backoff step plus slack. */
const ALL_ATTEMPTS_MS = SESSION_REMOVAL_RETRY_BASE_DELAY_MS * 2 ** (SESSION_REMOVAL_RETRY_MAX_ATTEMPTS + 1);

describe('SessionRemovalRetryService', () => {
  let service: SessionRemovalRetryService;
  let mockSessionService: ReturnType<typeof createMockSessionService>;
  let mockCache: ReturnType<typeof createMockCache>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    mockSessionService = createMockSessionService();
    mockCache = createMockCache();
    service = new SessionRemovalRetryService(mockSessionService as any, mockCache as any);
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
    vi.spyOn(Logger.prototype, 'debug').mockImplementation(() => {});
  });

  afterEach(() => {
    service.onModuleDestroy();
    vi.useRealTimers();
  });

  it('persists the session id on the Redis-backed retry set when enqueued', async () => {
    service.enqueue('sess-park');
    await vi.advanceTimersByTimeAsync(0);

    expect(mockCache.sadd).toHaveBeenCalledWith(SESSION_REMOVAL_RETRY_SET_KEY, 'sess-park');
    // TTL-bounded like the sibling stream-session keys — no leaked Redis memory.
    expect(mockCache.expire).toHaveBeenCalledWith(SESSION_REMOVAL_RETRY_SET_KEY, expect.any(Number));
  });

  it('retries with backoff and clears the Redis entry once a retry succeeds', async () => {
    mockSessionService.removeSession.mockRejectedValueOnce(new Error('stt down')).mockResolvedValueOnce(undefined);

    service.enqueue('sess-retry', false, 'tenant-retry');

    // Attempt 1 after the base delay — fails.
    await vi.advanceTimersByTimeAsync(SESSION_REMOVAL_RETRY_BASE_DELAY_MS);
    expect(mockSessionService.removeSession).toHaveBeenCalledTimes(1);
    expect(mockCache.srem).not.toHaveBeenCalled();

    // Attempt 2 after the doubled delay — succeeds and clears the entry.
    await vi.advanceTimersByTimeAsync(SESSION_REMOVAL_RETRY_BASE_DELAY_MS * 2);
    expect(mockSessionService.removeSession).toHaveBeenCalledTimes(2);
    // a retry is the SAME internal DELETE, so it stays as
    // attributable as the first attempt — the tenant rides along unchanged.
    expect(mockSessionService.removeSession).toHaveBeenCalledWith('sess-retry', false, 'tenant-retry');
    expect(mockCache.srem).toHaveBeenCalledWith(SESSION_REMOVAL_RETRY_SET_KEY, 'sess-retry');
  });

  // `interrupted` is the CALLER's determination (the WS
  // gateway's finalizeSession), threaded through enqueue -> every retry
  // attempt unchanged, since this service has no basis of its own to
  // recompute it.
  it('threads interrupted:true through every retry attempt', async () => {
    mockSessionService.removeSession.mockRejectedValueOnce(new Error('stt down')).mockResolvedValueOnce(undefined);

    service.enqueue('sess-abort-retry', true, 'tenant-abort');

    await vi.advanceTimersByTimeAsync(SESSION_REMOVAL_RETRY_BASE_DELAY_MS);
    expect(mockSessionService.removeSession).toHaveBeenNthCalledWith(1, 'sess-abort-retry', true, 'tenant-abort');

    await vi.advanceTimersByTimeAsync(SESSION_REMOVAL_RETRY_BASE_DELAY_MS * 2);
    expect(mockSessionService.removeSession).toHaveBeenNthCalledWith(2, 'sess-abort-retry', true, 'tenant-abort');
  });

  it('stops after the bounded number of attempts and logs an error (entry left for ops)', async () => {
    const errorSpy = vi.spyOn(Logger.prototype, 'error');
    mockSessionService.removeSession.mockRejectedValue(new Error('still down'));

    service.enqueue('sess-exhaust');
    await vi.advanceTimersByTimeAsync(ALL_ATTEMPTS_MS);

    expect(mockSessionService.removeSession).toHaveBeenCalledTimes(SESSION_REMOVAL_RETRY_MAX_ATTEMPTS);
    expect(errorSpy).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'sess-exhaust' }));
    // Never cleared — the Redis entry stays visible (TTL reclaims it).
    expect(mockCache.srem).not.toHaveBeenCalled();
  });

  it('keeps retrying in-process even when the Redis persistence write fails', async () => {
    mockCache.sadd.mockRejectedValueOnce(new Error('redis blip'));
    mockSessionService.removeSession.mockResolvedValueOnce(undefined);

    service.enqueue('sess-redis-blip');
    await vi.advanceTimersByTimeAsync(SESSION_REMOVAL_RETRY_BASE_DELAY_MS);

    // No tenant threaded by this caller: the service declares `tenantless:job-queue`
    // downstream rather than omitting the header (see StreamingSessionService).
    expect(mockSessionService.removeSession).toHaveBeenCalledWith('sess-redis-blip', false, undefined);
  });

  it('cancels pending retries on module destroy', async () => {
    mockSessionService.removeSession.mockRejectedValue(new Error('down'));

    service.enqueue('sess-shutdown');
    service.onModuleDestroy();
    await vi.advanceTimersByTimeAsync(ALL_ATTEMPTS_MS);

    expect(mockSessionService.removeSession).not.toHaveBeenCalled();
  });
});
