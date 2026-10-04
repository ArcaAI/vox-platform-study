/**
 * TASK-1036 OD-20 / OD-29 / W1 — every core node config declares `label` (≤ 80) and, where the
 * node has inputs, `inputs`; the mandatory boundaries stay mandatory.
 */
import { jsonSchemaValueProblems } from '@arcaai/json-schema-subset';
import { describe, expect, it } from 'vitest';
import {
  ACTION_CONFIG_SCHEMAS,
  GRAPH_BOUNDARY_NODE_TYPES,
  MANDATORY_NODE_TYPES,
  NODE_CONFIG_SCHEMAS,
  NODE_LABEL_MAX_LENGTH,
} from '../node-config-schemas';
import { CORE_NODE_TYPES } from '../node-registry';

/** A minimal valid config per core type, so only the key under test can fail. */
const MINIMAL: Record<string, Record<string, unknown>> = {
  'core.trigger': { kinds: ['api'] },
  'core.agent': { agentRef: { slug: 'some-agent' } },
  'core.classify': { agentRef: { slug: 'some-agent' }, classes: [{ key: 'a', label: 'A' }] },
  'core.humanReview': { reviewType: 'x' },
  'core.variable': { variables: [{ key: 'a' }] },
  'core.condition': { branches: [{ key: 'a', when: 'true' }] },
  'core.loop': {},
  'core.note': {},
  'core.output': {},
  'core.data': {},
  'core.action': { actionKey: 'guard.phi' },
};

function problems(type: string, config: Record<string, unknown>): string[] {
  return jsonSchemaValueProblems(NODE_CONFIG_SCHEMAS[type], config, '');
}

describe('node `label` (OD-20)', () => {
  it.each([...CORE_NODE_TYPES])('%s accepts a label up to 80 characters and refuses longer or empty', (type) => {
    const base = MINIMAL[type] ?? {};
    const baseline = problems(type, base);
    expect(problems(type, { ...base, label: 'Transcribe the visit' })).toEqual(baseline);
    expect(problems(type, { ...base, label: 'x'.repeat(NODE_LABEL_MAX_LENGTH) })).toEqual(baseline);
    expect(problems(type, { ...base, label: 'x'.repeat(NODE_LABEL_MAX_LENGTH + 1) }).length).toBeGreaterThan(baseline.length);
    expect(problems(type, { ...base, label: '' }).length).toBeGreaterThan(baseline.length);
    expect(problems(type, { ...base, label: 7 }).length).toBeGreaterThan(baseline.length);
  });

  it('is not offered on an action`s own sub-config', () => {
    for (const schema of Object.values(ACTION_CONFIG_SCHEMAS)) {
      expect((schema.properties as Record<string, unknown> | undefined)?.label).toBeUndefined();
    }
  });
});

describe('node `inputs` (OD-29)', () => {
  it('every core node with inputs declares `inputs`; the trigger and the note do not', () => {
    for (const type of CORE_NODE_TYPES) {
      const declared = (NODE_CONFIG_SCHEMAS[type]?.properties as Record<string, unknown>).inputs;
      if (type === 'core.trigger' || type === 'core.note') expect(declared, type).toBeUndefined();
      else expect(declared, type).toBeDefined();
    }
  });

  it('validates each binding', () => {
    const base = MINIMAL['core.agent'] as Record<string, unknown>;
    expect(problems('core.agent', { ...base, inputs: { message: { from: 'nodes.n_a.outputs.text' }, context: { value: { a: 1 } } } })).toEqual([]);
    expect(problems('core.agent', { ...base, inputs: { message: { template: 'Hi {{context.name}}' } } })).toEqual([]);
    expect(problems('core.agent', { ...base, inputs: { message: 'nodes.n_a.outputs.text' } }).length).toBeGreaterThan(0);
    expect(problems('core.agent', { ...base, inputs: { message: { firstOf: ['a', 'b'] } } }).length).toBeGreaterThan(0);
    expect(problems('core.trigger', { kinds: ['api'], inputs: {} }).length).toBeGreaterThan(0);
  });
});

describe('W1 — the boundaries stay mandatory', () => {
  it('core.trigger and core.output are still the mandatory, undeletable boundaries and still withhold `enabled`', () => {
    expect([...MANDATORY_NODE_TYPES].sort()).toEqual(['core.output', 'core.trigger']);
    expect([...GRAPH_BOUNDARY_NODE_TYPES].sort()).toEqual(['core.output', 'core.trigger']);
    for (const type of GRAPH_BOUNDARY_NODE_TYPES) {
      expect((NODE_CONFIG_SCHEMAS[type]?.properties as Record<string, unknown>).enabled).toBeUndefined();
    }
  });
});
