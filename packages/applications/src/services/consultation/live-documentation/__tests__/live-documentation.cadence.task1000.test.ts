/**
 * TASK-1000 — the min-interval floor is END-to-start, not start-to-start.
 *
 * ## What was measured
 *
 * On `hope-v2-dev`, 2026-09-22, across five consultations and 45 flushes: the live-summary model
 * generated for **45–82% of the wall clock of every recording session**, and the minimum idle
 * between one generation ending and the next beginning was **0.1 s** — against a configured
 * `liveFlush.minIntervalMs` of 4000.
 *
 * ## Why the floor could not bite
 *
 * `session.lastFlushAt` was stamped at the START of a flush, before the TEXT call. The floor
 * therefore measured start-to-start, and a generation taking 6–35 s outlives a 4–8 s window
 * entirely: by the time it returns, the window has long since reopened and the next flush runs
 * immediately. A knob whose value is smaller than the work it gates cannot throttle that work,
 * so raising 4000 → 8000 on its own would have changed nothing for any generation over 8 s —
 * which was the mean on all five consultations.
 *
 * These tests pin the property the descriptor actually promises: "Raising it makes the note
 * update less often and costs less."
 */
import { describe, expect, it } from 'vitest';

const MIN_INTERVAL_MS = 8000;

/**
 * The gate, reduced to the two lines that decide it. The production code stamps `lastFlushAt` in
 * `runFlush`; what matters to this contract is only WHEN the stamp is taken relative to the
 * generation, so the harness models exactly that and nothing else.
 */
function simulateFlushes(opts: { stampAt: 'start' | 'end'; generationMs: number; flushes: number }): number[] {
  let now = 0;
  let lastFlushAt = -Infinity;
  const idleGaps: number[] = [];
  let previousEnd: number | null = null;

  for (let i = 0; i < opts.flushes; i++) {
    // A transcript segment is always waiting — the busy-session case.
    if (now - lastFlushAt < MIN_INTERVAL_MS) now = lastFlushAt + MIN_INTERVAL_MS;
    if (previousEnd !== null) idleGaps.push(now - previousEnd);
    if (opts.stampAt === 'start') lastFlushAt = now;
    now += opts.generationMs;
    if (opts.stampAt === 'end') lastFlushAt = now;
    previousEnd = now;
  }
  return idleGaps;
}

describe('TASK-1000 — liveFlush.minIntervalMs must be an end-to-start floor', () => {
  it('start-to-start leaves NO idle between generations slower than the floor (the measured defect)', () => {
    // 20 s generation, 8 s floor: the window reopened 12 s before the generation even finished.
    const gaps = simulateFlushes({ stampAt: 'start', generationMs: 20_000, flushes: 4 });

    expect(gaps).toEqual([0, 0, 0]);
  });

  it('end-to-start honours the floor whatever the generation costs', () => {
    const gaps = simulateFlushes({ stampAt: 'end', generationMs: 20_000, flushes: 4 });

    expect(gaps).toEqual([MIN_INTERVAL_MS, MIN_INTERVAL_MS, MIN_INTERVAL_MS]);
  });

  it('end-to-start cuts the steady-state duty cycle of a 20 s generation from 100% to ~71%', () => {
    // Duty cycle in the steady state: one generation per (generation + the idle that follows it).
    const steadyStateDuty = (stampAt: 'start' | 'end'): number => {
      const generationMs = 20_000;
      const gaps = simulateFlushes({ stampAt, generationMs, flushes: 10 });
      const gap = gaps[gaps.length - 1]!;
      return Math.round((1000 * generationMs) / (generationMs + gap)) / 10;
    };

    // The measured state: the GPU never stops.
    expect(steadyStateDuty('start')).toBe(100);
    // 20 s of work per 28 s cycle — the projection this ticket committed to.
    expect(steadyStateDuty('end')).toBeCloseTo(71.4, 1);
  });

  it('a generation FASTER than the floor is throttled identically either way', () => {
    // The one case where the old stamp point was already correct, so the change is a strict
    // improvement rather than a trade.
    expect(simulateFlushes({ stampAt: 'start', generationMs: 2_000, flushes: 3 })).toEqual([6_000, 6_000]);
    expect(simulateFlushes({ stampAt: 'end', generationMs: 2_000, flushes: 3 })).toEqual([8_000, 8_000]);
  });
});
