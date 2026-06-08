/**
 * Unit tests for the draft-ready polling decision logic (TASK-339 FU2).
 *
 * After a recording stops the harness drafts the SOAP asynchronously. These
 * pure helpers decide the TanStack `refetchInterval` (poll until the draft is
 * found, then stop; back off gently; give up after a timeout) and the coarse
 * UI status the review surface renders.
 */
import { describe, it, expect } from 'vitest';
import { DEFAULT_DRAFT_POLL_CONFIG, draftWaitStatus, nextDraftPollInterval } from '../draft-polling';

const t0 = 1_000_000;

describe('nextDraftPollInterval', () => {
  it('does not poll when not waiting for a draft', () => {
    expect(nextDraftPollInterval({ waiting: false, draftReady: false, startedAt: null, now: t0 })).toBe(false);
  });

  it('polls at the base interval right after stopping', () => {
    expect(nextDraftPollInterval({ waiting: true, draftReady: false, startedAt: t0, now: t0 })).toBe(DEFAULT_DRAFT_POLL_CONFIG.intervalMs);
  });

  it('stops polling once the draft is ready', () => {
    expect(nextDraftPollInterval({ waiting: true, draftReady: true, startedAt: t0, now: t0 + 4000 })).toBe(false);
  });

  it('stops polling after the timeout elapses (never polls forever)', () => {
    const now = t0 + DEFAULT_DRAFT_POLL_CONFIG.timeoutMs + 1;
    expect(nextDraftPollInterval({ waiting: true, draftReady: false, startedAt: t0, now })).toBe(false);
  });

  it('backs off as time passes but never exceeds the max interval', () => {
    const early = nextDraftPollInterval({ waiting: true, draftReady: false, startedAt: t0, now: t0 }) as number;
    const later = nextDraftPollInterval({ waiting: true, draftReady: false, startedAt: t0, now: t0 + 60_000 }) as number;
    expect(later).toBeGreaterThanOrEqual(early);
    const nearTimeout = nextDraftPollInterval({
      waiting: true,
      draftReady: false,
      startedAt: t0,
      now: t0 + DEFAULT_DRAFT_POLL_CONFIG.timeoutMs - 1,
    }) as number;
    expect(nearTimeout).toBeLessThanOrEqual(DEFAULT_DRAFT_POLL_CONFIG.maxIntervalMs);
  });

  it('honours a custom config', () => {
    const interval = nextDraftPollInterval({
      waiting: true,
      draftReady: false,
      startedAt: t0,
      now: t0,
      config: { intervalMs: 1000, maxIntervalMs: 2000, timeoutMs: 10_000 },
    });
    expect(interval).toBe(1000);
  });
});

describe('draftWaitStatus', () => {
  it('is idle when not waiting and no draft', () => {
    expect(draftWaitStatus({ waiting: false, draftReady: false, startedAt: null, now: t0 })).toBe('idle');
  });

  it('is ready as soon as the draft exists (even if still waiting flag set)', () => {
    expect(draftWaitStatus({ waiting: true, draftReady: true, startedAt: t0, now: t0 + 5000 })).toBe('ready');
  });

  it('is generating while waiting within the timeout window', () => {
    expect(draftWaitStatus({ waiting: true, draftReady: false, startedAt: t0, now: t0 + 5000 })).toBe('generating');
  });

  it('is timed-out once the timeout elapses without a draft', () => {
    const now = t0 + DEFAULT_DRAFT_POLL_CONFIG.timeoutMs + 1;
    expect(draftWaitStatus({ waiting: true, draftReady: false, startedAt: t0, now })).toBe('timed-out');
  });
});
