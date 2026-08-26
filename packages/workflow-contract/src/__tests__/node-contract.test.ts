/**
 * TASK-809 Tasks 1/3/4/7 — the `WorkflowNodeDescriptor` contract, closing D-4
 * ("`WorkflowNodeDescriptor` declares no `inputs`/`outputs`", `node-registry.ts:46-80`).
 *
 * Two things are asserted here and nowhere else:
 *
 * 1. EVERY registry descriptor declares the full contract — typed ports, `trigger`, `lane`,
 *    `requires`, `idempotent`, `schemaVersion`. A descriptor that omits any of them is the
 *    exact state D-4 records, so "every node, no exceptions" is the assertion, not a sample.
 * 2. The two publish-time descriptor rules hold, and — just as importantly — REJECT a
 *    descriptor that breaks them. A rule only tested on conforming data proves nothing, so
 *    each is exercised against a deliberately malformed synthetic descriptor as well as
 *    against the live registry.
 */
import { describe, expect, it } from 'vitest';
import { WORKFLOW_NODE_REGISTRY } from '../node-registry';
import type { WorkflowNodeDescriptor } from '../node-registry';
import { WORKFLOW_PORT_PRIMITIVES } from '../port-model';
import { nodeDescriptorContractProblems } from '../port-validation';

const DESCRIPTORS = Object.values(WORKFLOW_NODE_REGISTRY);

/** A minimal conforming descriptor, mutated per-test to exercise one rule at a time. */
function descriptorFixture(overrides: Partial<WorkflowNodeDescriptor> = {}): WorkflowNodeDescriptor {
  return {
    key: 'test.node',
    implemented: true,
    activityName: 'interpreter.test_node',
    classes: ['activity'],
    paletteKey: null,
    critical: false,
    externalWrite: false,
    defaultTimeoutSeconds: 60,
    defaultMaxAttempts: 1,
    entitlementKey: null,
    inputs: [{ name: 'after', primitive: 'control', required: false, multiple: true }],
    outputs: [{ name: 'next', primitive: 'control', required: false, multiple: true }],
    trigger: 'on-start',
    lane: 'durable',
    requires: [],
    idempotent: true,
    schemaVersion: 1,
    ...overrides,
  };
}

describe('every registry descriptor declares the TASK-809 contract (D-4)', () => {
  it.each(DESCRIPTORS.map((d) => [d.key, d] as const))('%s declares inputs and outputs', (_key, descriptor) => {
    expect(Array.isArray(descriptor.inputs)).toBe(true);
    expect(Array.isArray(descriptor.outputs)).toBe(true);
    // A node with neither an input nor an output cannot participate in a graph at all.
    expect(descriptor.inputs.length + descriptor.outputs.length).toBeGreaterThan(0);
  });

  it.each(DESCRIPTORS.map((d) => [d.key, d] as const))('%s ports use the closed vocabulary and unique names', (_key, descriptor) => {
    for (const port of [...descriptor.inputs, ...descriptor.outputs]) {
      expect(WORKFLOW_PORT_PRIMITIVES).toContain(port.primitive);
      expect(typeof port.name).toBe('string');
      expect(port.name.length).toBeGreaterThan(0);
      expect(typeof port.required).toBe('boolean');
      expect(typeof port.multiple).toBe('boolean');
    }
    expect(new Set(descriptor.inputs.map((p) => p.name)).size).toBe(descriptor.inputs.length);
    expect(new Set(descriptor.outputs.map((p) => p.name)).size).toBe(descriptor.outputs.length);
  });

  it.each(DESCRIPTORS.map((d) => [d.key, d] as const))('%s declares trigger, lane, requires, idempotent, schemaVersion', (_key, descriptor) => {
    expect(['on-start', 'per-turn', 'on-end']).toContain(descriptor.trigger);
    expect(['realtime', 'durable']).toContain(descriptor.lane);
    expect(Array.isArray(descriptor.requires)).toBe(true);
    expect(typeof descriptor.idempotent).toBe('boolean');
    expect(Number.isInteger(descriptor.schemaVersion)).toBe(true);
    expect(descriptor.schemaVersion).toBeGreaterThanOrEqual(1);
  });

  it.each(DESCRIPTORS.map((d) => [d.key, d] as const))('%s satisfies every descriptor-contract rule', (_key, descriptor) => {
    expect(nodeDescriptorContractProblems(descriptor)).toEqual([]);
  });
});

describe('schemaVersion is pinned to the key suffix (never reshape a published node in place)', () => {
  it('an unsuffixed key means schemaVersion 1 across the whole registry', () => {
    for (const descriptor of DESCRIPTORS) {
      if (!descriptor.key.includes('@')) expect(descriptor.schemaVersion).toBe(1);
    }
  });

  it('rejects `agent.ner@2` declaring schemaVersion 1 — the suffix and the field must agree', () => {
    const problems = nodeDescriptorContractProblems(descriptorFixture({ key: 'agent.ner@2', schemaVersion: 1 }));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('schemaVersion');
  });

  it('accepts `agent.ner@2` declaring schemaVersion 2', () => {
    expect(nodeDescriptorContractProblems(descriptorFixture({ key: 'agent.ner@2', schemaVersion: 2 }))).toEqual([]);
  });
});

describe('publish-time rule 3 — a durable-lane node MUST be idempotent (Temporal retries activities)', () => {
  it('holds for every node in the live registry', () => {
    for (const descriptor of DESCRIPTORS) {
      if (descriptor.lane === 'durable') expect(descriptor.idempotent).toBe(true);
    }
  });

  it('REJECTS a durable node that is not idempotent', () => {
    const problems = nodeDescriptorContractProblems(descriptorFixture({ lane: 'durable', idempotent: false }));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('idempotent');
    expect(problems[0]).toContain('durable');
  });

  it('does not impose idempotency on a realtime node', () => {
    expect(nodeDescriptorContractProblems(descriptorFixture({ lane: 'realtime', idempotent: false }))).toEqual([]);
  });
});

describe('publish-time rule 4 — a realtime-lane node MUST NOT declare externalWrite', () => {
  it('holds for every node in the live registry', () => {
    for (const descriptor of DESCRIPTORS) {
      if (descriptor.lane === 'realtime') expect(descriptor.externalWrite).toBe(false);
    }
  });

  it('REJECTS a realtime node that performs an external write', () => {
    const problems = nodeDescriptorContractProblems(descriptorFixture({ lane: 'realtime', externalWrite: true, idempotent: false }));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('externalWrite');
    expect(problems[0]).toContain('realtime');
  });

  it('permits externalWrite on the durable lane — that is where every persistence node lives', () => {
    expect(nodeDescriptorContractProblems(descriptorFixture({ lane: 'durable', externalWrite: true, idempotent: true }))).toEqual([]);
  });
});

describe('evalGate (OD-11) — optional, and shape-checked when present', () => {
  it('is undefined on every node today; the binding TASK-815 migrates off DepartmentAgent', () => {
    for (const descriptor of DESCRIPTORS) {
      expect(descriptor.evalGate).toBeUndefined();
    }
  });

  it('accepts a well-formed evalGate', () => {
    expect(nodeDescriptorContractProblems(descriptorFixture({ evalGate: { goldenSetId: 'gs-1', enabled: true } }))).toEqual([]);
  });

  it('REJECTS an evalGate with an empty goldenSetId — an enabled gate with no golden set gates nothing', () => {
    const problems = nodeDescriptorContractProblems(descriptorFixture({ evalGate: { goldenSetId: '', enabled: true } }));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('goldenSetId');
  });
});
