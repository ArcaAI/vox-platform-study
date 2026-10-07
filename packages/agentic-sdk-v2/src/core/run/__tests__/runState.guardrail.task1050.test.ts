/** TASK-1050 W2d — the pure run reducer: notices deduplicate by noticeId, `run.paused` never settles the run. */

import { describe, expect, it } from 'vitest';
import { INITIAL_RUN_STATE, runReducer, type RunEvent, type RunState } from '../runState';

const notice = (id: string, over: Record<string, unknown> = {}) => ({
  schemaVersion: 1,
  noticeId: id,
  type: 'guardrail.warning',
  direction: 'inbound',
  action: 'warn',
  checks: [],
  itemIds: [],
  messageKey: 'guardrail.warning.generic',
  defaultMessage: 'A safety check flagged this content. Review it before you rely on it.',
  requiresAcknowledgement: true,
  resumable: false,
  policyVersion: 'pv',
  occurredAt: 't',
  ...over,
});

let seq = 0;
const apply = (state: RunState, type: string, data: Record<string, unknown>, nodeId?: string): RunState =>
  runReducer(state, {
    type: 'event',
    event: { seq: ++seq, runId: 'r', type, ts: 't', ...(nodeId ? { nodeId } : {}), data } as unknown as RunEvent,
    reset: false,
    protocol: 2,
    maxEvents: 100,
  });

describe('runReducer — guardrail', () => {
  it('collects notices once per noticeId (a repeat replaces the earlier entry)', () => {
    let state: RunState = { ...INITIAL_RUN_STATE, runId: 'r', status: 'RUNNING' };
    state = apply(state, 'guardrail.notice', notice('a'), 'n');
    state = apply(state, 'guardrail.notice', notice('b'), 'n');
    state = apply(state, 'guardrail.notice', notice('a', { requiresAcknowledgement: false }), 'n');
    expect(state.guardrailNotices.map((n) => n.noticeId)).toEqual(['a', 'b']);
    expect(state.guardrailNotices[0]?.requiresAcknowledgement).toBe(false);
  });

  it('run.completed merges its guardrailNotices without duplicating the streamed ones', () => {
    let state: RunState = { ...INITIAL_RUN_STATE, runId: 'r', status: 'RUNNING' };
    state = apply(state, 'guardrail.notice', notice('a'), 'n');
    state = apply(state, 'run.completed', { status: 'COMPLETED', durationMs: 1, tokens: { in: 0, out: 0 }, guardrailNotices: [notice('a'), notice('c')] });
    expect(state.guardrailNotices.map((n) => n.noticeId)).toEqual(['a', 'c']);
    expect(state.status).toBe('COMPLETED');
  });

  it('run.paused keeps the status RUNNING and records the pause; the next node or an end clears it', () => {
    let state: RunState = { ...INITIAL_RUN_STATE, runId: 'r', status: 'RUNNING' };
    state = apply(state, 'run.paused', { reason: 'guardrail_hold', noticeId: 'a', nodeId: 'n' });
    expect(state.status).toBe('RUNNING');
    expect(state.paused?.noticeId).toBe('a');
    expect(apply(state, 'node.started', { kind: 'k' }, 'n').paused).toBeNull();
    expect(apply(state, 'run.failed', { status: 'FAILED', durationMs: 1, error: { code: 'GUARDRAIL_BLOCKED', message: 'A guardrail blocked the content.' } }).paused).toBeNull();
    expect(apply(state, 'run.cancelled', { status: 'CANCELED', durationMs: 1 }).paused).toBeNull();
  });
});
