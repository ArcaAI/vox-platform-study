/**
 * TASK-1036 §10.2 Flow — every step live (Waiting, Running, Done with duration, warning count),
 * links light up as data moves and the active link animates (never under reduced motion).
 */
import { describe, expect, it } from 'vitest';
import { foldRunEvents } from '@/shared/sandbox/api/run-fold';
import type { RunEvent } from '@/shared/sandbox/api/run-protocol';
import { edgeRunStates, flowRunStates, runWarningFindings } from '../lib/flow-state';

let seq = 0;
function ev(type: RunEvent['type'], data: Record<string, unknown>, nodeId?: string): RunEvent {
  seq += 1;
  return { seq, runId: 'r', type, ts: '2026-10-04T10:00:00.000Z', data, ...(nodeId ? { nodeId } : {}) } as RunEvent;
}

const NODES = [{ id: 'start' }, { id: 'asr' }, { id: 'note' }, { id: 'end' }];
const EDGES = [
  { id: 'e1', source: 'start', target: 'asr' },
  { id: 'e2', source: 'asr', target: 'note' },
  { id: 'e3', source: 'note', target: 'end' },
];

function running() {
  seq = 0;
  return foldRunEvents([
    ev('run.started', { kind: 'workflow', slug: 's', versionNumber: 1 }),
    ev('node.started', { kind: 'core.trigger' }, 'start'),
    ev('node.completed', { status: 'COMPLETED', durationMs: 5 }, 'start'),
    ev('node.started', { kind: 'core.agent' }, 'asr'),
    ev('node.completed', { status: 'COMPLETED', durationMs: 1200, warnings: 1 }, 'asr'),
    ev('node.started', { kind: 'core.agent' }, 'note'),
    ev('binding.warning', { input: 'history', code: 'OPTIONAL_EMPTY', message: 'Rendered empty.' }, 'note'),
  ]);
}

describe('flowRunStates', () => {
  it('is empty before a run, so the canvas shows no run chips', () => {
    expect(flowRunStates(NODES, foldRunEvents([])).size).toBe(0);
  });

  it('marks every step: untouched steps wait, the live one runs, finished ones carry their duration', () => {
    const states = flowRunStates(NODES, running());
    expect(states.get('start')).toEqual({ state: 'ok', durationMs: 5 });
    // F2: a step's run warnings ride the overlay too, so the canvas counts them on the node.
    expect(states.get('asr')).toEqual({ state: 'ok', durationMs: 1200, warnings: 1 });
    expect(states.get('note')).toEqual({ state: 'running', warnings: 1 });
    expect(states.get('end')).toEqual({ state: 'pending' });
  });
});

describe('edgeRunStates', () => {
  it('lights links whose data has moved and marks the active one', () => {
    const states = edgeRunStates(EDGES, running());
    expect(states.get('e1')).toBe('done');
    expect(states.get('e2')).toBe('active');
    expect(states.has('e3')).toBe(false);
  });
});

describe('runWarningFindings', () => {
  it('turns a step’s run warnings into canvas warnings, with the count', () => {
    const findings = runWarningFindings(running());
    expect(findings).toEqual([
      expect.objectContaining({ severity: 'WARNING', nodeId: 'asr', message: 'This run: 1 warning.' }),
      expect.objectContaining({ severity: 'WARNING', nodeId: 'note', message: 'This run: 1 warning — history: Rendered empty.' }),
    ]);
  });
});
