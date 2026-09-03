/**
 * W4 / R3 — the clinician-facing view of the loop plane.
 *
 * Contract: the loop event is
 * `{ kind: 'summary.interim', data: { kindKey, ordinal, total, chars } }` and
 * it deliberately carries NO summary text — "a live UI feed, not a PHI
 * transport". These tests pin that: progress metadata is surfaced, and no
 * body is ever fabricated from an event that does not contain one.
 */

import { describe, expect, it } from 'vitest';

import { foldLoopActivity, type LoopEvent } from '../use-loop-activity';

const event = (over: Partial<LoopEvent> = {}): LoopEvent => ({
  consultationId: 'c-1',
  kind: 'summary.interim',
  publishedAt: '2026-08-22T10:00:00.000Z',
  data: { kindKey: 'soap.subjective', ordinal: 1, total: 4, chars: 210 },
  ...over,
});

describe('foldLoopActivity', () => {
  it('is append-only — every event is kept in arrival order', () => {
    const feed = foldLoopActivity([], event());
    const feed2 = foldLoopActivity(feed, event({ data: { kindKey: 'soap.objective', ordinal: 2, total: 4, chars: 90 } }));
    expect(feed2).toHaveLength(2);
    expect(feed2[0].kindKey).toBe('soap.subjective');
    expect(feed2[1].kindKey).toBe('soap.objective');
  });

  it('surfaces interim-summary progress from metadata alone', () => {
    const [entry] = foldLoopActivity([], event());
    expect(entry.kind).toBe('summary.interim');
    expect(entry.ordinal).toBe(1);
    expect(entry.total).toBe(4);
    expect(entry.chars).toBe(210);
  });

  it('never fabricates summary text — the wire carries none', () => {
    const [entry] = foldLoopActivity([], event());
    expect('text' in entry).toBe(false);
    expect('content' in entry).toBe(false);
    expect(entry.body).toBeUndefined();
  });

  it('keeps a non-summary loop event with its label and drops unusable ones', () => {
    const [entry] = foldLoopActivity([], event({ kind: 'action.started', label: 'Extracting entities', data: undefined }));
    expect(entry.kind).toBe('action.started');
    expect(entry.label).toBe('Extracting entities');
    expect(entry.ordinal).toBeUndefined();
  });

  it('bounds the feed so a long consultation cannot grow it without limit', () => {
    let feed = foldLoopActivity([], event());
    for (let i = 0; i < 260; i += 1) feed = foldLoopActivity(feed, event({ publishedAt: `t-${i}` }));
    expect(feed.length).toBeLessThanOrEqual(200);
  });
});
