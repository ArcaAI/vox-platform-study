/**
 * TASK-1036 §8.4 item 2-3 / §10.1 "Auto-mapping" — what one link MEANS, against the real registry
 * and the frozen NodeIO contract.
 *
 *  - D-C: ASR → text agent binds `transcript → message` (it used to pass nothing).
 *  - D-D: Start → text agent binds the run input into `context` (it used to degrade to order only).
 *  - D-F: an agent's handles are its TASK's fields (`transcript`, `data`), not a fixed port table.
 *  - OD-18: a second producer into a single-value input is refused, with a `firstOf` offer (Q1).
 *  - Q3: a branch link carries the router's input through (`nodes.<router>.outputs.input`).
 */
import { describe, expect, it } from 'vitest';
import type { AgentIOResolver } from '@arcaai/workflow-contract';
import type { GraphStoreEdge, GraphStoreNode } from '../../store/types';
import { canvasPortsOf, ioTone, parsePortHandle } from '../composer-io';
import { edgeMappingLabels, planConnection } from '../connection-plan';
import { REGISTRY } from './registry-fixture';

const AGENTS: AgentIOResolver = {
  asr: { task: 'SPEECH_TO_TEXT' },
  writer: { task: 'TEXT_GENERATION' },
  structured: { task: 'TEXT_GENERATION', outputSchema: { type: 'object', properties: { text: { type: 'string' }, plan: { type: 'string' } } } },
  ner: { task: 'NAMED_ENTITY_RECOGNITION' },
  tts: { task: 'TEXT_TO_SPEECH' },
};

function node(id: string, type: string, config: Record<string, unknown> = {}): GraphStoreNode {
  return { id, type, position: { x: 0, y: 0 }, safetyClasses: [], config };
}
const agent = (id: string, slug: string, extra: Record<string, unknown> = {}) => node(id, 'core.agent', { agentRef: { slug }, ...extra });

function plan(nodes: GraphStoreNode[], edges: GraphStoreEdge[], source: string, target: string, handles: { sourceHandle?: string; targetHandle?: string } = {}) {
  return planConnection({ nodes, edges, descriptorByType: REGISTRY, agents: AGENTS, source, target, ...handles });
}

describe('canvasPortsOf — task-aware typed ports (D-F)', () => {
  it('draws an ASR agent with audio in and transcript/segments/language out', () => {
    const ports = canvasPortsOf(agent('a', 'asr'), AGENTS);
    expect(ports?.inputs.map((port) => `${port.name}:${port.type}`)).toEqual(['audio:audio']);
    expect(ports?.outputs.map((port) => port.name)).toEqual(['transcript', 'segments', 'language']);
  });

  it('adds `data` to a text agent only when its output schema is structured', () => {
    expect(canvasPortsOf(agent('a', 'writer'), AGENTS)?.outputs.map((port) => port.name)).toEqual(['text']);
    expect(canvasPortsOf(agent('a', 'structured'), AGENTS)?.outputs.map((port) => port.name)).toEqual(['text', 'data']);
  });

  it('has no typed ports for an agent whose task is not known yet (primary dots instead)', () => {
    expect(canvasPortsOf(agent('a', 'unknown-slug'), AGENTS)).toBeNull();
    expect(canvasPortsOf(node('a', 'core.agent'), AGENTS)).toBeNull();
  });

  it('keeps branch nodes on their branch handles: no typed OUTPUT ports for a router', () => {
    const ports = canvasPortsOf(node('c', 'core.condition', { branches: [{ key: 'urgent', when: 'true' }] }), AGENTS);
    expect(ports?.inputs.map((port) => port.name)).toEqual(['in']);
    expect(ports?.outputs).toEqual([]);
  });

  it('round-trips the handle ids it draws', () => {
    expect(parsePortHandle('out:transcript')).toEqual({ direction: 'out', field: 'transcript' });
    expect(parsePortHandle('in:message')).toEqual({ direction: 'in', field: 'message' });
    expect(parsePortHandle('then')).toBeNull();
    expect(parsePortHandle(null)).toBeNull();
  });

  it('names a colour family per type', () => {
    expect(ioTone('text')).toBe('text');
    expect(ioTone('list<entity>')).toBe('list');
    expect(ioTone('document')).toBe('file');
    expect(ioTone('json')).toBe('json');
  });
});

describe('planConnection — auto-mapping', () => {
  it('D-C: ASR → text agent binds transcript → message, over an ordering edge', () => {
    const nodes = [agent('asr1', 'asr'), agent('w1', 'writer')];
    const result = plan(nodes, [], 'asr1', 'w1');
    expect(result).toMatchObject({
      ok: true,
      request: { source: 'asr1', sourceHandle: 'next', target: 'w1', targetHandle: 'after' },
      binding: { input: 'message', binding: { from: 'nodes.asr1.outputs.transcript' } },
      label: 'transcript → message',
    });
  });

  it('D-D: Start → text agent binds the run input into context', () => {
    const nodes = [node('t', 'core.trigger'), agent('w1', 'writer')];
    expect(plan(nodes, [], 't', 'w1')).toMatchObject({
      ok: true,
      binding: { input: 'context', binding: { from: 'nodes.t.outputs.context' } },
      label: 'context → context',
    });
  });

  it('honours the exact handles the author dragged between', () => {
    const nodes = [agent('asr1', 'asr'), agent('w1', 'writer')];
    expect(plan(nodes, [], 'asr1', 'w1', { sourceHandle: 'out:segments', targetHandle: 'in:context' })).toMatchObject({
      ok: true,
      binding: { input: 'context', binding: { from: 'nodes.asr1.outputs.segments' } },
    });
  });

  it('refuses a dragged pair whose types do not fit, saying why', () => {
    const nodes = [agent('w1', 'writer'), agent('asr1', 'asr')];
    const result = plan(nodes, [], 'w1', 'asr1', { sourceHandle: 'out:text', targetHandle: 'in:audio' });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toMatch(/audio/);
  });

  it('links for order only when nothing fits and no handles were named, and says so', () => {
    const nodes = [node('t', 'core.trigger'), agent('asr1', 'asr')];
    const result = plan(nodes, [], 't', 'asr1');
    expect(result.ok).toBe(true);
    expect(result.ok && result.binding).toBeUndefined();
    expect(result.ok && result.note).toMatch(/audio/);
  });

  it('refuses linking into Start and out of End', () => {
    const nodes = [node('t', 'core.trigger'), node('o', 'core.output'), agent('w1', 'writer')];
    expect(plan(nodes, [], 'w1', 't').ok).toBe(false);
    expect(plan(nodes, [], 'o', 'w1').ok).toBe(false);
  });

  it('writes only the binding when the two steps are already linked', () => {
    const nodes = [agent('asr1', 'asr'), agent('w1', 'writer', { inputs: { message: { from: 'nodes.asr1.outputs.transcript' } } })];
    const edges: GraphStoreEdge[] = [{ id: 'e1', source: 'asr1', sourceHandle: 'next', target: 'w1', targetHandle: 'after' }];
    expect(plan(nodes, edges, 'asr1', 'w1', { sourceHandle: 'out:segments', targetHandle: 'in:context' })).toMatchObject({
      ok: true,
      request: null,
      binding: { input: 'context', binding: { from: 'nodes.asr1.outputs.segments' } },
    });
  });
});

describe('planConnection — OD-18 fan-in and the Q1 firstOf offer', () => {
  it('refuses a second producer into a bound single-value input and offers an ordered coalesce', () => {
    const nodes = [agent('a1', 'writer'), agent('a2', 'writer'), agent('w', 'writer', { inputs: { message: { from: 'nodes.a1.outputs.text' } } })];
    const edges: GraphStoreEdge[] = [{ id: 'e1', source: 'a1', sourceHandle: 'next', target: 'w', targetHandle: 'after' }];
    const result = plan(nodes, edges, 'a2', 'w', { sourceHandle: 'out:text', targetHandle: 'in:message' });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toMatch(/already/);
    expect(!result.ok && result.coalesce).toMatchObject({
      request: { source: 'a2', target: 'w' },
      input: 'message',
      binding: { firstOf: ['nodes.a1.outputs.text', 'nodes.a2.outputs.text'] },
    });
  });

  it('counts a legacy data edge as a producer', () => {
    const nodes = [agent('a1', 'writer'), agent('a2', 'writer'), agent('w', 'writer')];
    const edges: GraphStoreEdge[] = [{ id: 'e1', source: 'a1', sourceHandle: 'out', target: 'w', targetHandle: 'in' }];
    const result = plan(nodes, edges, 'a2', 'w', { sourceHandle: 'out:text', targetHandle: 'in:message' });
    expect(result.ok).toBe(false);
  });

  it('may re-point a binding that read the step being replaced (insert on edge)', () => {
    const nodes = [agent('a1', 'writer'), agent('mid', 'writer'), agent('w', 'writer', { inputs: { message: { from: 'nodes.a1.outputs.text' } } })];
    const result = planConnection({ nodes, edges: [], descriptorByType: REGISTRY, agents: AGENTS, source: 'mid', target: 'w', replaceProducer: 'a1' });
    expect(result).toMatchObject({ ok: true, binding: { input: 'message', binding: { from: 'nodes.mid.outputs.text' } } });
  });
});

describe('planConnection — Q3 branch links carry the router input', () => {
  it('binds nodes.<router>.outputs.input into the target`s main input', () => {
    const nodes = [node('c', 'core.condition', { branches: [{ key: 'urgent', when: 'true' }] }), agent('w', 'writer')];
    const result = plan(nodes, [], 'c', 'w', { sourceHandle: 'urgent' });
    expect(result).toMatchObject({
      ok: true,
      request: { source: 'c', sourceHandle: 'urgent', target: 'w' },
      binding: { input: 'message', binding: { from: 'nodes.c.outputs.input' } },
    });
  });
});

describe('edgeMappingLabels — the link shows its mapping', () => {
  it('labels authored and legacy edges with `field → input`', () => {
    const nodes = [agent('asr1', 'asr'), agent('w', 'writer', { inputs: { message: { from: 'nodes.asr1.outputs.transcript' } } }), node('o', 'core.output')];
    const edges: GraphStoreEdge[] = [
      { id: 'e1', source: 'asr1', sourceHandle: 'next', target: 'w', targetHandle: 'after' },
      { id: 'e2', source: 'w', sourceHandle: 'out', target: 'o', targetHandle: 'in' },
    ];
    const labels = edgeMappingLabels(nodes, edges, AGENTS);
    expect(labels.get('e1')).toEqual({ label: 'transcript → message', sourceField: 'transcript', targetField: 'message' });
    expect(labels.get('e2')).toEqual({ label: 'text → in', sourceField: 'text', targetField: 'in' });
  });

  it('has no entry for an ordering-only link', () => {
    const nodes = [agent('a', 'writer'), agent('b', 'writer')];
    const edges: GraphStoreEdge[] = [{ id: 'e1', source: 'a', sourceHandle: 'next', target: 'b', targetHandle: 'after' }];
    expect(edgeMappingLabels(nodes, edges, AGENTS).has('e1')).toBe(false);
  });
});
