/**
 * TASK-1039 — the protocol normaliser: v2 frames pass through, and for ONE release the legacy
 * workflow frame shapes (`workflow.run.progress`, `workflow.node.*`, `workflow.token.delta`,
 * `workflow.run.completed`) are mapped onto v2 events, so `RunHandle` works against a gateway that
 * has not shipped protocol v2 yet.
 *
 * The legacy shapes asserted here are the ones `toLegacyEnvelope`
 * (`apps/api/src/modules/workflows/run-protocol-delivery.ts`) emits, plus the gateway-minted
 * snapshot frame (`buildWorkflowRunEventEnvelope`).
 */

import { describe, expect, it } from 'vitest';
import { RunFrameNormaliser } from '../run-normaliser';

function legacy(type: string, payload: Record<string, unknown>, id?: string) {
  const envelope = {
    schemaVersion: 1,
    id: '01924f00-0000-7000-8000-000000000001',
    tenantId: 't',
    type,
    occurredAt: '2026-10-04T10:00:00.000Z',
    correlationId: 'run-1',
    causationId: null,
    idempotencyKey: 'k',
    payload,
  };
  return { event: type, data: JSON.stringify(envelope), id };
}

function v2(type: string, seq: number, data: Record<string, unknown>, nodeId?: string) {
  const envelope = { seq, runId: 'run-1', type, ts: '2026-10-04T10:00:00.000Z', ...(nodeId ? { nodeId } : {}), data };
  return { event: type, data: JSON.stringify(envelope), id: String(seq) };
}

describe('RunFrameNormaliser — protocol v2', () => {
  it('passes a v2 frame through unchanged and reports the protocol', () => {
    const n = new RunFrameNormaliser('run-1');
    const out = n.normalise(v2('output.text.delta', 4, { field: 'text', text: 'hi' }, 'n1'));
    expect(out.protocol).toBe(2);
    expect(out.events).toEqual([{ seq: 4, runId: 'run-1', type: 'output.text.delta', ts: '2026-10-04T10:00:00.000Z', nodeId: 'n1', data: { field: 'text', text: 'hi' } }]);
  });

  it('skips a malformed frame rather than destroying the stream', () => {
    const n = new RunFrameNormaliser('run-1');
    expect(n.normalise({ event: 'message', data: '{not json', id: '1' }).events).toEqual([]);
    expect(n.normalise(v2('run.teleported', 2, {})).events).toEqual([]);
  });
});

describe('RunFrameNormaliser — legacy shapes (one release)', () => {
  it('maps token deltas to output.text.delta on field "text" with local, increasing seqs', () => {
    const n = new RunFrameNormaliser('run-1');
    const a = n.normalise(legacy('workflow.token.delta', { nodeId: 'n1', sequence: 9, text: 'Hel' }, '1-0'));
    const b = n.normalise(legacy('workflow.token.delta', { nodeId: 'n1', sequence: 10, text: 'lo' }, '2-0'));
    expect(a.protocol).toBe('legacy');
    expect(a.events[0]).toMatchObject({ type: 'output.text.delta', runId: 'run-1', nodeId: 'n1', data: { field: 'text', text: 'Hel' } });
    expect(b.events[0]!.seq).toBeGreaterThan(a.events[0]!.seq);
  });

  it('maps node lifecycle frames', () => {
    const n = new RunFrameNormaliser('run-1');
    expect(n.normalise(legacy('workflow.node.started', { nodeId: 'n1', nodeType: 'core.agent' })).events[0]).toMatchObject({
      type: 'node.started',
      nodeId: 'n1',
      data: { kind: 'core.agent' },
    });
    expect(n.normalise(legacy('workflow.node.completed', { nodeId: 'n1', status: 'SUCCEEDED' })).events[0]).toMatchObject({
      type: 'node.completed',
      data: { status: 'COMPLETED' },
    });
    expect(n.normalise(legacy('workflow.node.completed', { nodeId: 'n2', status: 'DEGRADED' })).events[0]).toMatchObject({ data: { status: 'DEGRADED' } });
    const failed = n.normalise(legacy('workflow.node.failed', { nodeId: 'n3', status: 'FAILED', reason: 'MODEL_ERROR' })).events[0]!;
    expect(failed).toMatchObject({ type: 'node.failed', nodeId: 'n3', data: { error: { code: 'MODEL_ERROR', message: 'The model returned an error.' } } });
  });

  it.each([
    ['SUCCEEDED', 'run.completed', { status: 'COMPLETED' }],
    ['DEGRADED', 'run.completed', { status: 'COMPLETED', degraded: true }],
    ['COMPLETED', 'run.completed', { status: 'COMPLETED' }],
    ['FAILED', 'run.failed', { status: 'FAILED' }],
    ['TIMED_OUT', 'run.failed', { status: 'TIMED_OUT' }],
    ['CANCELLED', 'run.cancelled', { status: 'CANCELED' }],
    ['CANCELED', 'run.cancelled', { status: 'CANCELED' }],
  ])('maps a terminal workflow.run.completed %s onto %s', (status, type, data) => {
    const n = new RunFrameNormaliser('run-1');
    const out = n.normalise(legacy('workflow.run.completed', { runId: 'run-1', status }, '9-0'));
    expect(out.events).toHaveLength(1);
    expect(out.events[0]).toMatchObject({ type, data });
  });

  it('carries a legacy failure reason as the error code, and never invents prose', () => {
    const n = new RunFrameNormaliser('run-1');
    const out = n.normalise(legacy('workflow.run.completed', { status: 'FAILED', reason: 'GUARDRAIL_BLOCKED' }));
    expect(out.events[0]).toMatchObject({ type: 'run.failed', data: { error: { code: 'GUARDRAIL_BLOCKED', message: 'A guardrail blocked the content.' } } });
    const bare = n.normalise(legacy('workflow.run.completed', { status: 'TIMED_OUT' }));
    expect(bare.events[0]).toMatchObject({ data: { error: { code: 'RUN_TIMED_OUT' } } });
  });

  it('passes a delivered result through when the legacy completion carries one', () => {
    const n = new RunFrameNormaliser('run-1');
    const result = { kind: 'inline', value: { text: 'done' } };
    expect(n.normalise(legacy('workflow.run.completed', { status: 'SUCCEEDED', result })).events[0]).toMatchObject({ data: { result } });
  });

  it('turns the snapshot frame into a status hint, not an event', () => {
    const n = new RunFrameNormaliser('run-1');
    const out = n.normalise(legacy('workflow.run.progress', { runId: 'run-1', status: 'RUNNING' }));
    expect(out.events).toEqual([]);
    expect(out.statusHint).toBe('RUNNING');
  });

  it('drops legacy frames v2 has no counterpart for', () => {
    const n = new RunFrameNormaliser('run-1');
    expect(n.normalise(legacy('workflow.loop.iteration', { nodeId: 'l' })).events).toEqual([]);
    expect(n.normalise(legacy('workflow.guardrail.verdict', { nodeId: 'g' })).events).toEqual([]);
  });
});
