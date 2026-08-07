import { describe, expect, it, vi } from 'vitest';

import { APIConnectionError, HopeAPIError, RateLimitError } from '../errors';
import { computeBackoffDelayMs, executeWithRetry, shouldRetry } from '../retry';

describe('computeBackoffDelayMs — full jitter', () => {
  it('is random(0, min(cap, base * 2**attempt))', () => {
    const options = { baseDelayMs: 100, maxDelayMs: 1000 };
    expect(computeBackoffDelayMs(0, { ...options, random: () => 0.5 })).toBe(50); // min(1000,100)=100 * 0.5
    expect(computeBackoffDelayMs(1, { ...options, random: () => 0.5 })).toBe(100); // min(1000,200)=200 * 0.5
    expect(computeBackoffDelayMs(2, { ...options, random: () => 0.5 })).toBe(200); // min(1000,400)=400 * 0.5
  });

  it('clamps the exponential window at maxDelayMs before applying jitter', () => {
    // attempt=10 → base*2**10 = 102_400, far above the 1000ms cap
    const delay = computeBackoffDelayMs(10, { baseDelayMs: 100, maxDelayMs: 1000, random: () => 0.5 });
    expect(delay).toBe(500); // min(1000, 102400) = 1000 * 0.5
  });

  it('is 0 when random() returns 0', () => {
    expect(computeBackoffDelayMs(3, { baseDelayMs: 100, maxDelayMs: 1000, random: () => 0 })).toBe(0);
  });

  it('never exceeds the cap even at random()→1', () => {
    const delay = computeBackoffDelayMs(3, { baseDelayMs: 100, maxDelayMs: 1000, random: () => 0.999999 });
    expect(delay).toBeLessThanOrEqual(1000);
    expect(delay).toBeGreaterThan(0);
  });

  it('does NOT degenerate into plain (non-jittered) exponential — two different random draws give two different delays', () => {
    const a = computeBackoffDelayMs(2, { baseDelayMs: 100, maxDelayMs: 10_000, random: () => 0.2 });
    const b = computeBackoffDelayMs(2, { baseDelayMs: 100, maxDelayMs: 10_000, random: () => 0.9 });
    expect(a).not.toBe(b);
  });
});

describe('shouldRetry', () => {
  const base = { attempt: 0, maxRetries: 2 };

  it('retries a GET on a retryable status (408, 429, 5xx)', () => {
    expect(shouldRetry({ ...base, method: 'GET', status: 408 })).toBe(true);
    expect(shouldRetry({ ...base, method: 'GET', status: 429 })).toBe(true);
    expect(shouldRetry({ ...base, method: 'GET', status: 500 })).toBe(true);
    expect(shouldRetry({ ...base, method: 'GET', status: 503 })).toBe(true);
  });

  it('does not retry a non-retryable client status', () => {
    expect(shouldRetry({ ...base, method: 'GET', status: 404 })).toBe(false);
    expect(shouldRetry({ ...base, method: 'GET', status: 400 })).toBe(false);
  });

  it('retries a connection error regardless of method (GET)', () => {
    expect(shouldRetry({ ...base, method: 'GET', isConnectionError: true })).toBe(true);
  });

  it('never retries a non-idempotent POST without an idempotency key', () => {
    expect(shouldRetry({ ...base, method: 'POST', status: 503 })).toBe(false);
    expect(shouldRetry({ ...base, method: 'post', status: 503 })).toBe(false); // case-insensitive
    expect(shouldRetry({ ...base, method: 'POST', isConnectionError: true })).toBe(false);
  });

  it('retries a POST when an idempotency key was supplied', () => {
    expect(shouldRetry({ ...base, method: 'POST', status: 503, hasIdempotencyKey: true })).toBe(true);
  });

  it('stops once attempt reaches maxRetries', () => {
    expect(shouldRetry({ method: 'GET', status: 503, attempt: 2, maxRetries: 2 })).toBe(false);
    expect(shouldRetry({ method: 'GET', status: 503, attempt: 1, maxRetries: 2 })).toBe(true);
  });
});

describe('executeWithRetry', () => {
  function fakeSleep() {
    const calls: number[] = [];
    const sleep = vi.fn(async (ms: number) => {
      calls.push(ms);
    });
    return { sleep, calls };
  }

  it('retries a GET on 503 then succeeds, using the injected sleep/random (no real timers)', async () => {
    const { sleep, calls } = fakeSleep();
    const random = vi.fn(() => 0.5);
    let attempts = 0;
    const result = await executeWithRetry(
      async (attemptNumber) => {
        attempts += 1;
        if (attemptNumber < 2) {
          throw new HopeAPIError({ status: 503, message: 'unavailable' });
        }
        return 'ok';
      },
      { method: 'GET', maxRetries: 2, baseDelayMs: 100, maxDelayMs: 1000, random, sleep },
    );

    expect(result).toBe('ok');
    expect(attempts).toBe(3);
    expect(calls).toHaveLength(2);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it('honors Retry-After from a RateLimitError over computed backoff', async () => {
    const { sleep, calls } = fakeSleep();
    let attempts = 0;
    await executeWithRetry(
      async () => {
        attempts += 1;
        if (attempts === 1) {
          throw new RateLimitError({ message: 'slow down', retryAfterMs: 1234 });
        }
        return 'ok';
      },
      { method: 'GET', maxRetries: 2, baseDelayMs: 100, maxDelayMs: 1000, random: () => 0.5, sleep },
    );
    expect(calls).toEqual([1234]);
  });

  it('gives up and rethrows once maxRetries is exhausted', async () => {
    const { sleep } = fakeSleep();
    let attempts = 0;
    await expect(
      executeWithRetry(
        async () => {
          attempts += 1;
          throw new HopeAPIError({ status: 503, message: 'unavailable' });
        },
        { method: 'GET', maxRetries: 2, baseDelayMs: 10, maxDelayMs: 100, random: () => 0.1, sleep },
      ),
    ).rejects.toThrow('unavailable');
    expect(attempts).toBe(3); // initial + 2 retries
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it('never retries a non-idempotent POST without an idempotency key — fails on the first attempt', async () => {
    const { sleep } = fakeSleep();
    let attempts = 0;
    await expect(
      executeWithRetry(
        async () => {
          attempts += 1;
          throw new HopeAPIError({ status: 503, message: 'unavailable' });
        },
        { method: 'POST', maxRetries: 2, baseDelayMs: 10, maxDelayMs: 100, random: () => 0.1, sleep },
      ),
    ).rejects.toThrow('unavailable');
    expect(attempts).toBe(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('retries a POST with an idempotency key', async () => {
    const { sleep } = fakeSleep();
    let attempts = 0;
    const result = await executeWithRetry(
      async () => {
        attempts += 1;
        if (attempts === 1) throw new HopeAPIError({ status: 503, message: 'unavailable' });
        return 'ok';
      },
      { method: 'POST', hasIdempotencyKey: true, maxRetries: 2, baseDelayMs: 10, maxDelayMs: 100, random: () => 0.1, sleep },
    );
    expect(result).toBe('ok');
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it('does not retry a non-retryable status (404) and never sleeps', async () => {
    const { sleep } = fakeSleep();
    await expect(
      executeWithRetry(
        async () => {
          throw new HopeAPIError({ status: 404, message: 'not found' });
        },
        { method: 'GET', maxRetries: 2, baseDelayMs: 10, maxDelayMs: 100, random: () => 0.1, sleep },
      ),
    ).rejects.toThrow('not found');
    expect(sleep).not.toHaveBeenCalled();
  });

  it('retries a connection error (APIConnectionError)', async () => {
    const { sleep } = fakeSleep();
    let attempts = 0;
    const result = await executeWithRetry(
      async () => {
        attempts += 1;
        if (attempts === 1) throw new APIConnectionError({ message: 'ECONNREFUSED' });
        return 'ok';
      },
      { method: 'GET', maxRetries: 2, baseDelayMs: 10, maxDelayMs: 100, random: () => 0.1, sleep },
    );
    expect(result).toBe('ok');
    expect(sleep).toHaveBeenCalledTimes(1);
  });
});
