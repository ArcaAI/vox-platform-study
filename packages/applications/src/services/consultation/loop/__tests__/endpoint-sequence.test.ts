/**
 * The consultation ENDPOINT STAGE — TASK-882: read off the assigned graph.
 *
 * The stage used to be the `consultation.endpoint.actions` setting (an admin-ordered list),
 * extended by a department agent's `alwaysActions` and vetoed by its `neverActions`. All three
 * levers are gone: membership is NODE PRESENCE (+ the node's `enabled`) on the governing
 * consultation graph, order is EDGE ORDER, and a graph that declares no endpoint node runs the
 * platform default — "nobody authored this" must never mean "close consultations without
 * finalizing them".
 */
import { describe, expect, it } from 'vitest';
import {
  CONSULTATION_ENDPOINT_ACTIONS_DEFAULT,
  ENDPOINT_ELIGIBLE_ACTIONS,
  endpointSequenceFromGraph,
  resolveEndpointSequence,
} from '../endpoint-sequence';

type Node = { id: string; type: string; config?: Record<string, unknown> };
const graph = (nodes: Node[], edges: Array<[string, string]> = []) => ({
  version: 1 as const,
  nodes: nodes.map((n) => ({ ...n, config: n.config ?? {} })),
  edges: edges.map(([from, to], i) => ({ id: `e${i}`, from, fromPort: 'next', to, toPort: 'after' })),
});

describe('endpointSequenceFromGraph — membership is node presence + enabled, order is edge order', () => {
  it('returns null when the graph declares no endpoint node — the platform default applies', () => {
    expect(endpointSequenceFromGraph(graph([{ id: 'a', type: 'consultation.synthesize' }]))).toBeNull();
  });

  it('follows the edges, not the declaration order', () => {
    const g = graph(
      [
        { id: 'fb', type: 'feedback.capture' },
        { id: 'fin', type: 'harness.finalize' },
        { id: 'lock', type: 'summary.finalize' },
      ],
      [
        ['fin', 'lock'],
        ['lock', 'fb'],
      ],
    );
    expect(endpointSequenceFromGraph(g)).toEqual(['harness.finalize', 'summary.finalize', 'feedback.capture']);
  });

  it('omits a node switched off with `enabled: false`', () => {
    const g = graph(
      [
        { id: 'fin', type: 'harness.finalize' },
        { id: 'lock', type: 'summary.finalize', config: { enabled: false } },
        { id: 'fb', type: 'feedback.capture' },
      ],
      [
        ['fin', 'lock'],
        ['lock', 'fb'],
      ],
    );
    expect(endpointSequenceFromGraph(g)).toEqual(['harness.finalize', 'feedback.capture']);
  });

  it('counts a core.action that delegates to an endpoint key, reading `enabled` off the core.action', () => {
    const g = graph(
      [
        { id: 'stop', type: 'core.action', config: { actionKey: 'livedoc.stop' } },
        { id: 'fin', type: 'core.action', config: { actionKey: 'harness.finalize' } },
        { id: 'fb', type: 'core.action', config: { actionKey: 'feedback.capture', enabled: false } },
      ],
      [
        ['stop', 'fin'],
        ['fin', 'fb'],
      ],
    );
    expect(endpointSequenceFromGraph(g)).toEqual(['livedoc.stop', 'harness.finalize']);
  });

  it('falls back to declaration order for nodes no edge orders', () => {
    const g = graph([
      { id: 'lock', type: 'summary.finalize' },
      { id: 'fin', type: 'harness.finalize' },
    ]);
    expect(endpointSequenceFromGraph(g)).toEqual(['summary.finalize', 'harness.finalize']);
  });

  it('runs an action once, at the position of its FIRST node', () => {
    const g = graph(
      [
        { id: 'fin1', type: 'harness.finalize' },
        { id: 'lock', type: 'summary.finalize' },
        { id: 'fin2', type: 'harness.finalize' },
      ],
      [
        ['fin1', 'lock'],
        ['lock', 'fin2'],
      ],
    );
    expect(endpointSequenceFromGraph(g)).toEqual(['harness.finalize', 'summary.finalize']);
  });

  it('returns null (never a stage of nothing) when every endpoint node is disabled', () => {
    expect(endpointSequenceFromGraph(graph([{ id: 'fin', type: 'harness.finalize', config: { enabled: false } }]))).toBeNull();
  });
});

describe('resolveEndpointSequence — the stage a consultation runs', () => {
  it('runs the platform default, minus livedoc.stop, when the graph declared nothing and no audio streams', () => {
    expect(resolveEndpointSequence({ declared: null, hasStreamAudio: false })).toEqual([
      'session.timeout',
      'harness.finalize',
      'summary.finalize',
      'feedback.capture',
    ]);
  });

  it('keeps livedoc.stop when the consultation streams audio', () => {
    expect(resolveEndpointSequence({ declared: null, hasStreamAudio: true })).toEqual([...CONSULTATION_ENDPOINT_ACTIONS_DEFAULT]);
  });

  it('runs the graph-declared chain in its declared order', () => {
    expect(resolveEndpointSequence({ declared: ['harness.finalize', 'summary.finalize'], hasStreamAudio: false })).toEqual([
      'harness.finalize',
      'summary.finalize',
    ]);
  });

  it('drops livedoc.stop from a declared chain when no audio streams (unchanged behaviour)', () => {
    expect(resolveEndpointSequence({ declared: ['livedoc.stop', 'harness.finalize'], hasStreamAudio: false })).toEqual(['harness.finalize']);
  });

  it('a declared chain of nothing eligible degrades to the platform default, never to an empty stage', () => {
    expect(resolveEndpointSequence({ declared: ['not.a.key'], hasStreamAudio: false })).toEqual([
      'session.timeout',
      'harness.finalize',
      'summary.finalize',
      'feedback.capture',
    ]);
  });
});

describe('the endpoint vocabulary', () => {
  it('the platform default is the five-step stage in the clinically safe order', () => {
    expect([...CONSULTATION_ENDPOINT_ACTIONS_DEFAULT]).toEqual([
      'livedoc.stop',
      'session.timeout',
      'harness.finalize',
      'summary.finalize',
      'feedback.capture',
    ]);
  });

  it('eligibility is a closed list — a graph author places the stage, they do not invent steps for it', () => {
    expect([...ENDPOINT_ELIGIBLE_ACTIONS].sort()).toEqual(['feedback.capture', 'harness.finalize', 'livedoc.stop', 'session.timeout', 'summary.finalize']);
  });

  it('every default entry is eligible', () => {
    for (const key of CONSULTATION_ENDPOINT_ACTIONS_DEFAULT) expect(ENDPOINT_ELIGIBLE_ACTIONS).toContain(key);
  });
});
