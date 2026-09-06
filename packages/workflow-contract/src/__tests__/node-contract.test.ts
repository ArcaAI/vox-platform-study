/**
 * Tasks 1/3/4/7 — the `WorkflowNodeDescriptor` contract, closing D-4
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
import { isValidConnection, nodeDescriptorContractProblems } from '../port-validation';

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

describe('every registry descriptor declares the  contract (D-4)', () => {
  it.each(DESCRIPTORS.map((d) => [d.key, d] as const))('%s declares inputs and outputs', (_key, descriptor) => {
    expect(Array.isArray(descriptor.inputs)).toBe(true);
    expect(Array.isArray(descriptor.outputs)).toBe(true);
    // A node with neither an input nor an output cannot participate in a graph at all — except a
    // canvas ANNOTATION (TASK-864 `core.note`), which is stripped by compile() and by design has
    // nothing to wire.
    if (descriptor.classes.includes('annotation')) {
      expect(descriptor.inputs.length + descriptor.outputs.length).toBe(0);
      return;
    }
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

describe('publish-time rule 3 — EVERY node MUST be idempotent, in either lane', () => {
  it('holds for every node in the live registry', () => {
    for (const descriptor of DESCRIPTORS) expect(descriptor.idempotent, descriptor.key).toBe(true);
  });

  it('REJECTS a durable node that is not idempotent', () => {
    const problems = nodeDescriptorContractProblems(descriptorFixture({ lane: 'durable', idempotent: false }));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('idempotent');
  });

  // lane A, item 7. The rule used to exempt the realtime lane, which was wrong for the
  // same reason it was wrong for the durable one: realtime executor retries a node up
  // to its compiled `retry.maximumAttempts` (`realtime-lane.ts`'s `RealtimeNode.maxAttempts`), so
  // a non-idempotent realtime node double-writes on a retry nobody sees.
  it('REJECTS a realtime node that is not idempotent — the realtime executor retries too', () => {
    const problems = nodeDescriptorContractProblems(descriptorFixture({ lane: 'realtime', idempotent: false }));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('idempotent');
  });
});

/**
 * lane A, item 7 — the rule wrote as "a realtime-lane node MUST NOT be
 * `externalWrite`" is GONE, and its removal is asserted rather than merely done: a rule that is
 * silently dropped comes back.
 *
 * It was written before a realtime runtime existed and the runtime falsified it. Two of the three
 * node types executor implements write — `consultation.realtimeSummary` publishes each
 * interim summary to the live consultation feed, which IS the realtime lane's product. See
 * `port-validation.ts`'s `nodeDescriptorContractProblems` docstring for the full argument,
 * including why the hazard it was reaching for (two runtimes executing one node) is now closed
 * structurally by the durable interpreter's `realtime_lane` skip instead.
 */
describe('a realtime-lane node MAY declare externalWrite', () => {
  it('accepts a realtime node that writes', () => {
    expect(nodeDescriptorContractProblems(descriptorFixture({ lane: 'realtime', externalWrite: true, idempotent: true }))).toEqual([]);
  });

  it('permits externalWrite on the durable lane — that is where every persistence node lives', () => {
    expect(nodeDescriptorContractProblems(descriptorFixture({ lane: 'durable', externalWrite: true, idempotent: true }))).toEqual([]);
  });
});

describe('evalGate (OD-11) — optional, and shape-checked when present', () => {
  it('is undefined on every node today; the binding  migrates off DepartmentAgent', () => {
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

/**
 * (option A) — every DATA output socket declares the runtime key it carries.
 *
 * This is the invariant that lets `_resolve_bound_inputs` stop threading the whole upstream
 * output object. A socket without an `outputKey` is unresolvable at runtime, so the interpreter
 * would either raise on a legal graph or fall back to the untyped bundle the port vocabulary
 * exists to abolish. The control half of the rule is enforced by the TYPE (`outputKey?: never`
 * on the `control` member of `WorkflowPortDescriptor`); it is asserted here as well because a
 * type is invisible to a JSON consumer of `GET /admin/workflow-nodes`.
 */
describe('OD-15 — outputKey is declared on every data output port, and on no control port', () => {
  it.each(DESCRIPTORS.map((d) => [d.key, d] as const))('%s declares an outputKey on every data OUTPUT port', (_key, descriptor) => {
    const missing = descriptor.outputs.filter((port) => port.primitive !== 'control' && !port.outputKey).map((port) => port.name);
    expect(missing, `${descriptor.key}: data output ports with no outputKey — the interpreter cannot resolve them`).toEqual([]);
  });

  it.each(DESCRIPTORS.map((d) => [d.key, d] as const))('%s declares NO outputKey on a control port', (_key, descriptor) => {
    const offenders = [...descriptor.inputs, ...descriptor.outputs]
      .filter((port) => port.primitive === 'control' && (port as { outputKey?: string }).outputKey !== undefined)
      .map((port) => port.name);
    expect(offenders, `${descriptor.key}: control ports carry no payload, so they can name no output key`).toEqual([]);
  });

  it.each(DESCRIPTORS.map((d) => [d.key, d] as const))(
    '%s declares NO outputKey on an INPUT port (a socket is bound by toPort)',
    (_key, descriptor) => {
      const offenders = descriptor.inputs.filter((port) => (port as { outputKey?: string }).outputKey !== undefined).map((port) => port.name);
      expect(offenders).toEqual([]);
    },
  );

  it('the two nodes whose descriptor contradicted their activity now declare real data outputs (OD-15)', () => {
    // `persistDraft` emits `{contextItemId, text}` and `finalizeAssurance` genuinely consumes the
    // former — yet both declared `[NEXT]` only, so NO legal edge could express that flow.
    const persist = WORKFLOW_NODE_REGISTRY['consultation.persistDraft'];
    const assure = WORKFLOW_NODE_REGISTRY['consultation.finalizeAssurance'];

    expect(persist.outputs.filter((p) => p.primitive !== 'control').map((p) => [p.name, p.outputKey])).toEqual([
      ['out', 'text'],
      ['contextItemId', 'contextItemId'],
    ]);
    expect(assure.outputs.filter((p) => p.primitive !== 'control').map((p) => [p.name, p.outputKey])).toEqual([['contextItemId', 'contextItemId']]);

    // …and the flow is now expressible as a type-checked edge.
    expect(isValidConnection('consultation.persistDraft', 'contextItemId', 'consultation.finalizeAssurance', 'contextItemId')).toBe(true);
    expect(isValidConnection('consultation.persistDraft', 'out', 'consultation.finalizeAssurance', 'in')).toBe(true);
  });
});
