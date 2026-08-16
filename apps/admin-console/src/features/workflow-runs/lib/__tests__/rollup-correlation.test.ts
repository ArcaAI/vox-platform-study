import { describe, expect, it } from 'vitest';
import { correlateRollupsToGraphNodes } from '../rollup-correlation';
import type { RunNodeRollup, WorkflowGraphNode } from '../../api/types';

function rollup(overrides: Partial<RunNodeRollup> = {}): RunNodeRollup {
  return {
    nodeType: 'interpreter.noop',
    order: 0,
    status: 'OK',
    startedAt: '2026-08-16T10:00:00.000Z',
    endedAt: '2026-08-16T10:00:01.000Z',
    durationMs: 1000,
    errorCode: null,
    attemptSeqs: [0],
    attemptCount: 1,
    attemptGroupingIsDerived: true,
    ...overrides,
  };
}

describe('correlateRollupsToGraphNodes', () => {
  it('matches a single node of a type to its single rollup group', () => {
    const nodes: WorkflowGraphNode[] = [{ id: 'n1', type: 'interpreter.noop' }];
    const map = correlateRollupsToGraphNodes(nodes, [rollup()]);
    expect(map.get('n1')).toMatchObject({ nodeType: 'interpreter.noop' });
  });

  it('zips repeated-type rollups onto repeated-type nodes in authored/run order', () => {
    const nodes: WorkflowGraphNode[] = [
      { id: 'first', type: 'interpreter.noop' },
      { id: 'second', type: 'interpreter.noop' },
    ];
    const rollups = [rollup({ order: 0, attemptSeqs: [0] }), rollup({ order: 1, attemptSeqs: [5] })];
    const map = correlateRollupsToGraphNodes(nodes, rollups);
    expect(map.get('first')?.attemptSeqs).toEqual([0]);
    expect(map.get('second')?.attemptSeqs).toEqual([5]);
  });

  it('leaves a rollup unmatched (not guessed) when there are more occurrences than authored nodes of that type', () => {
    const nodes: WorkflowGraphNode[] = [{ id: 'only', type: 'interpreter.noop' }];
    const rollups = [rollup({ order: 0, attemptSeqs: [0] }), rollup({ order: 1, attemptSeqs: [9] })];
    const map = correlateRollupsToGraphNodes(nodes, rollups);
    expect(map.size).toBe(1);
    expect(map.get('only')?.attemptSeqs).toEqual([0]);
  });

  it('ignores a rollup whose node type is absent from the pinned graph entirely', () => {
    const nodes: WorkflowGraphNode[] = [{ id: 'n1', type: 'interpreter.passthrough' }];
    const map = correlateRollupsToGraphNodes(nodes, [rollup({ nodeType: 'interpreter.noop' })]);
    expect(map.size).toBe(0);
  });

  it('sorts by `order` before zipping, independent of input array order', () => {
    const nodes: WorkflowGraphNode[] = [
      { id: 'first', type: 'interpreter.noop' },
      { id: 'second', type: 'interpreter.noop' },
    ];
    const rollups = [rollup({ order: 1, attemptSeqs: [5] }), rollup({ order: 0, attemptSeqs: [0] })];
    const map = correlateRollupsToGraphNodes(nodes, rollups);
    expect(map.get('first')?.attemptSeqs).toEqual([0]);
    expect(map.get('second')?.attemptSeqs).toEqual([5]);
  });
});
