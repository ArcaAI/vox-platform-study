/**
 * TASK-1019 final review I10a — the EFFECTIVE stale window.
 *
 * Between BullMQ attempts nothing heartbeats: the retry waits
 * 30 s × 2^(attempt−1). A stale window shorter than that wait derives a row
 * STALLED mid-backoff, and a re-trigger then enqueues a DUPLICATE download. The
 * window every caller applies is therefore
 *   max(staleAfterSeconds, 30 · 2^(maxAttempts−1) + 60) seconds.
 */
import { describe, expect, it } from 'vitest';
import { effectiveStaleAfterMs } from '../model-download-settings';

describe('effectiveStaleAfterMs', () => {
  it.each([
    // [staleAfterSeconds, maxAttempts, expected seconds]
    [300, 3, 300], // descriptor defaults: 30·4+60 = 180 < 300
    [60, 3, 180], // a short knob is lifted to cover the longest backoff
    [60, 5, 540], // 30·16+60
    [1_000, 5, 1_000], // a long knob wins
    [10, 1, 90], // one attempt: 30·1+60
  ])('staleAfterSeconds=%i, maxAttempts=%i → %is', (staleAfterSeconds, maxAttempts, seconds) => {
    expect(effectiveStaleAfterMs({ staleAfterMs: staleAfterSeconds * 1000, maxAttempts })).toBe(seconds * 1000);
  });
});
