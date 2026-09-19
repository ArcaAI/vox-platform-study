/**
 * The arrival model.
 *
 * Two properties decide whether a run measures the platform or measures itself:
 * the think time must be a realistic right-skewed distribution rather than a
 * hot loop, and the schedule must make coordinated omission VISIBLE instead of
 * absorbing it.
 */
import { describe, expect, it } from 'vitest';
import { advance, lateness, mulberry32, rampOffsetMs, standardNormal, thinkTimeMs } from '../src/thinktime';

describe('mulberry32', () => {
  it('is deterministic, so a run is reproducible from its seed', () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
  });

  it('stays in [0,1)', () => {
    const random = mulberry32(7);
    for (let i = 0; i < 10_000; i += 1) {
      const value = random();
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });
});

describe('standardNormal', () => {
  it('has roughly zero mean and unit variance', () => {
    const random = mulberry32(99);
    const samples = Array.from({ length: 20_000 }, () => standardNormal(random));
    const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
    const variance = samples.reduce((sum, x) => sum + (x - mean) ** 2, 0) / samples.length;
    expect(Math.abs(mean)).toBeLessThan(0.05);
    expect(Math.abs(variance - 1)).toBeLessThan(0.08);
  });

  it('never returns a non-finite value, even when the uniform draw approaches the log(0) pole', () => {
    // A generator that yields 0 first is exactly the pathological input that
    // makes a naive Box-Muller return Infinity.
    let first = true;
    const pathological = (): number => {
      if (first) {
        first = false;
        return 0;
      }
      return 0.5;
    };
    expect(Number.isFinite(standardNormal(pathological))).toBe(true);
  });
});

describe('thinkTimeMs', () => {
  it('is right-skewed: the mean exceeds the median, as a log-normal must', () => {
    const random = mulberry32(3);
    const samples = Array.from({ length: 20_000 }, () => thinkTimeMs(random, 4_000, 0.6)).sort((a, b) => a - b);
    const median = samples[Math.floor(samples.length / 2)]!;
    const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
    expect(median).toBeGreaterThan(3_400);
    expect(median).toBeLessThan(4_600);
    expect(mean).toBeGreaterThan(median);
  });

  it('clamps, so one draw can neither become a hot loop nor park a user for the whole run', () => {
    const random = mulberry32(11);
    for (let i = 0; i < 50_000; i += 1) {
      const value = thinkTimeMs(random, 4_000, 1.5);
      expect(value).toBeGreaterThanOrEqual(250);
      expect(value).toBeLessThanOrEqual(40_000);
    }
  });
});

describe('lateness + advance — the coordinated-omission correction', () => {
  it('reports how far behind its own plan an iteration started', () => {
    const state = { dueAtMs: 1_000 };
    expect(lateness(state, 1_250)).toBe(250);
    expect(lateness(state, 900)).toBe(0); // early is not late
  });

  it('closed arrival anchors on NOW, so a slow platform reduces the offered load (and the lag stays at zero)', () => {
    const state = { dueAtMs: 1_000 };
    advance(state, 6_000, 4_000, 'closed');
    expect(state.dueAtMs).toBe(10_000);
    expect(lateness(state, 10_000)).toBe(0);
  });

  it('open arrival anchors on the PREVIOUS due time, so lag accumulates and is measured', () => {
    const state = { dueAtMs: 1_000 };
    advance(state, 6_000, 4_000, 'open'); // 5s late already
    expect(state.dueAtMs).toBe(5_000);
    expect(lateness(state, 6_000)).toBe(1_000);

    advance(state, 12_000, 4_000, 'open');
    expect(state.dueAtMs).toBe(9_000);
    expect(lateness(state, 12_000)).toBe(3_000); // the debt grows, which is the point
  });
});

describe('rampOffsetMs', () => {
  it('spreads the population evenly across the ramp so 1,000 users do not start in the same millisecond', () => {
    expect(rampOffsetMs(0, 1_000, 30)).toBe(0);
    expect(rampOffsetMs(500, 1_000, 30)).toBe(15_000);
    expect(rampOffsetMs(999, 1_000, 30)).toBe(29_970);
  });

  it('is a no-op without a ramp', () => {
    expect(rampOffsetMs(500, 1_000, 0)).toBe(0);
    expect(rampOffsetMs(0, 1, 30)).toBe(0);
  });
});
