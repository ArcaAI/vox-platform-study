/** TASK-1059 (lane O2) — a DEGRADED `node.completed` may carry `errorCode` / `errorMessage`. */
import { describe, expect, it } from 'vitest';
import { runEventProblems } from '../run-protocol';

const event = (data: Record<string, unknown>) => ({
  seq: 1,
  runId: 'run_01J9ZQ4V8W3K2N5P7R9T1X3Z5B',
  type: 'node.completed',
  ts: '2026-10-04T10:00:00.000Z',
  nodeId: 'n_note',
  data,
});

describe('node.completed errorCode / errorMessage', () => {
  it('a DEGRADED completion with both validates', () => {
    expect(
      runEventProblems(event({ status: 'DEGRADED', durationMs: 5, errorCode: 'INTERNAL_ERROR', errorMessage: 'The step could not be completed.' })),
    ).toEqual([]);
  });
  it('a lowercase errorCode is refused', () => {
    expect(runEventProblems(event({ status: 'DEGRADED', durationMs: 5, errorCode: 'internal_error' })).join('\n')).toContain('errorCode');
  });
  it('a healthy completion without them validates', () => {
    expect(runEventProblems(event({ status: 'COMPLETED', durationMs: 5 }))).toEqual([]);
  });
});
