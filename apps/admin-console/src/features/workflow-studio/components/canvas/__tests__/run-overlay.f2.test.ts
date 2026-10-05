/**
 * TASK-1036 F2 — the run overlay the Composer shows from the latest Test run: node statuses become
 * canvas run states, and a link is `done` once its source finished, `active` while its target runs.
 */
import { describe, expect, it } from 'vitest';
import { edgeRunStatesFrom, runOverlayFromLastRuns } from '../run-overlay';

const EDGES = [
  { id: 'e1', source: 'a', target: 'b' },
  { id: 'e2', source: 'b', target: 'c' },
];

describe('runOverlayFromLastRuns', () => {
  it('maps last-run statuses to canvas run states, with durations', () => {
    const { runStates } = runOverlayFromLastRuns(EDGES, {
      a: { inputs: {}, outputs: {}, durationMs: 120, status: 'SUCCEEDED' },
      b: { inputs: {}, outputs: {}, durationMs: 80, status: 'DEGRADED' },
      c: { inputs: {}, outputs: {}, durationMs: null, status: 'FAILED' },
    });
    expect(runStates.get('a')).toEqual({ state: 'ok', durationMs: 120 });
    expect(runStates.get('b')).toEqual({ state: 'ok', durationMs: 80 });
    expect(runStates.get('c')).toEqual({ state: 'failed' });
  });

  it('lights a link once its source finished and animates the one into the running step', () => {
    const { edgeRunStates } = runOverlayFromLastRuns(EDGES, {
      a: { inputs: {}, outputs: {}, durationMs: 1, status: 'SUCCEEDED' },
      b: { inputs: {}, outputs: {}, durationMs: null, status: 'RUNNING' },
    });
    expect(edgeRunStates.get('e1')).toBe('active');
    expect(edgeRunStates.has('e2')).toBe(false);
  });

  it('is empty before any run', () => {
    const { runStates, edgeRunStates } = runOverlayFromLastRuns(EDGES, {});
    expect(runStates.size).toBe(0);
    expect(edgeRunStates.size).toBe(0);
  });
});

describe('edgeRunStatesFrom', () => {
  it('marks a done link `done` when its target is not running', () => {
    const states = edgeRunStatesFrom(EDGES, (id) => (id === 'a' ? 'done' : 'idle'));
    expect(states.get('e1')).toBe('done');
  });
});
