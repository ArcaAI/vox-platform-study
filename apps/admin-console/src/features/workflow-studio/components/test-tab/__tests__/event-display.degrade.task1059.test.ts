/** TASK-1059 C-12 — a degraded step's reason (errorCode) shows in the Events list. */
import { describe, expect, it } from 'vitest';
import type { RunEvent } from '@/shared/sandbox/api/run-protocol';
import { describeEvent } from '../lib/event-display';

const ev = (data: Record<string, unknown>) => ({ seq: 1, runId: 'r', type: 'node.completed', ts: '2026-10-04T10:00:00.000Z', nodeId: 'n', data }) as RunEvent;

describe('node.completed degrade reason', () => {
  it('appends errorCode and message', () => {
    expect(describeEvent(ev({ status: 'DEGRADED', durationMs: 100, errorCode: 'agent_unresolvable', errorMessage: 'No agent v3' }), (id) => id)).toContain(
      'reason: agent_unresolvable — No agent v3',
    );
  });
  it('accepts an error record and stays silent when COMPLETED', () => {
    expect(describeEvent(ev({ status: 'DEGRADED', durationMs: 1, error: { code: 'X', message: 'm' } }), (id) => id)).toContain('reason: X — m');
    expect(describeEvent(ev({ status: 'COMPLETED', durationMs: 1, errorCode: 'ignored' }), (id) => id)).not.toContain('reason');
  });
});
