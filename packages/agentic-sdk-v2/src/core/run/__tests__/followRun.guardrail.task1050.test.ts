/** TASK-1050 W2d — `followRun` keeps following through `run.paused` and `guardrail.notice`; only the real terminal event ends it. */

import { describe, expect, it } from 'vitest';
import { followRun, type RawRunFrame, type RunConnector } from '../RunStreamClient';

const v2 = (type: string, seq: number, data: Record<string, unknown>): RawRunFrame => ({
  event: type,
  id: String(seq),
  data: JSON.stringify({ seq, runId: 'run-1', type, ts: 't', data }),
});

describe('followRun — run.paused is not terminal', () => {
  it('delivers notice and paused, stays on the SAME connection, and ends on run.completed', async () => {
    let connections = 0;
    const connector: RunConnector = async ({ onFrame }) => {
      connections += 1;
      onFrame(v2('guardrail.notice', 1, { noticeId: 'n', type: 'guardrail.blocked', messageKey: 'guardrail.blocked.outbound' }));
      onFrame(v2('run.paused', 2, { reason: 'guardrail_hold', noticeId: 'n', nodeId: 'x' }));
      onFrame(v2('run.completed', 3, { status: 'COMPLETED', durationMs: 1, tokens: { in: 0, out: 0 } }));
    };
    const types: string[] = [];
    const outcome = await followRun({ runId: 'run-1', connector, onEvent: (event) => types.push(event.type), reconnectDelayMs: 0 });
    expect(outcome).toBe('terminal');
    expect(types).toEqual(['guardrail.notice', 'run.paused', 'run.completed']);
    expect(connections).toBe(1);
  });

  it('a stream that ends at run.paused is a drop, not an end: it reconnects after the last seq', async () => {
    const afters: Array<number | undefined> = [];
    const connector: RunConnector = async ({ after, onFrame }) => {
      afters.push(after);
      if (afters.length === 1) onFrame(v2('run.paused', 2, { reason: 'guardrail_hold', noticeId: 'n', nodeId: 'x' }));
      else onFrame(v2('run.completed', 3, { status: 'COMPLETED', durationMs: 1, tokens: { in: 0, out: 0 } }));
    };
    const outcome = await followRun({ runId: 'run-1', connector, onEvent: () => undefined, reconnectDelayMs: 0 });
    expect(outcome).toBe('terminal');
    expect(afters).toEqual([undefined, 2]);
  });
});
