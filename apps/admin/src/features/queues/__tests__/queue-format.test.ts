import { describe, expect, it } from 'vitest';
import { depthSegments, deriveQueueState, formatBacklogged, formatLatency, formatUptime, QUEUE_BACKLOG_THRESHOLD } from '../queue-format';

// TASK-403 — pure presentation logic for the Queues & Jobs surface (design
// frame `15` v2: state dot+label Running/Backlogged/Failing/Paused + per-queue
// depth visualization).
const counts = (over: Partial<Record<'waiting' | 'active' | 'completed' | 'failed' | 'delayed' | 'paused' | 'prioritized', number>> = {}) => ({
  waiting: 0,
  active: 0,
  completed: 0,
  failed: 0,
  delayed: 0,
  paused: 0,
  prioritized: 0,
  ...over,
});

describe('deriveQueueState', () => {
  it('is Paused (neutral) when the queue is paused — regardless of counts', () => {
    const state = deriveQueueState({ name: 'SendEmail', isPaused: true, counts: counts({ failed: 9 }), workerCount: 0 });
    expect(state).toEqual({ label: 'Paused', colorRole: 'neutral' });
  });

  it('is Failing (destructive) when any job failed', () => {
    const state = deriveQueueState({ name: 'AuditLog', isPaused: false, counts: counts({ failed: 1 }), workerCount: 1 });
    expect(state).toEqual({ label: 'Failing', colorRole: 'destructive' });
  });

  it('is Backlogged (warning) when waiting crosses the threshold', () => {
    const state = deriveQueueState({
      name: 'SysEvent',
      isPaused: false,
      counts: counts({ waiting: QUEUE_BACKLOG_THRESHOLD }),
      workerCount: 1,
    });
    expect(state).toEqual({ label: 'Backlogged', colorRole: 'warning' });
  });

  it('is Running (success) otherwise', () => {
    const state = deriveQueueState({ name: 'SpeechToText', isPaused: false, counts: counts({ completed: 100 }), workerCount: 2 });
    expect(state).toEqual({ label: 'Running', colorRole: 'success' });
  });
});

describe('depthSegments', () => {
  it('splits waiting/active/failed into percentage widths', () => {
    const segs = depthSegments(counts({ waiting: 5, active: 3, failed: 2 }));
    expect(segs).toEqual({ waitingPct: 50, activePct: 30, failedPct: 20, total: 10 });
  });

  it('returns an all-zero split for an idle queue (no NaN)', () => {
    expect(depthSegments(counts())).toEqual({ waitingPct: 0, activePct: 0, failedPct: 0, total: 0 });
  });
});

describe('formatters', () => {
  it('formatLatency renders ms and an em-dash for the unreachable sentinel', () => {
    expect(formatLatency(3)).toBe('3 ms');
    expect(formatLatency(-1)).toBe('—');
  });

  it('formatUptime renders d/h/m from seconds', () => {
    expect(formatUptime(535_500)).toBe('6d 4h');
    expect(formatUptime(4_020)).toBe('1h 7m');
    expect(formatUptime(59)).toBe('59s');
    expect(formatUptime(0)).toBe('—');
  });

  it('formatBacklogged summarises the waiting depth', () => {
    expect(formatBacklogged(counts({ waiting: 120, active: 2 }))).toBe('122 in flight');
    expect(formatBacklogged(counts())).toBe('idle');
  });
});
