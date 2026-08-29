/**
 * TASK-815 / OD-11 — the eval gate binds to the NODE, and the binding is
 * TENANT DATA, so it lives in node CONFIG.
 *
 * ## Two `evalGate`s, and why there are two
 *
 * TASK-809 added `evalGate?: { goldenSetId, enabled }` to
 * `WorkflowNodeDescriptor`. A descriptor is a CODE-OWNED, per-node-TYPE
 * constant — the same object for every tenant — so it can express "this node
 * type ships with a platform default gate" and nothing else. It cannot hold a
 * tenant's own `goldenSetId` (a row in that tenant's data) and it cannot hold a
 * per-tenant enable/disable, which OD-11 requires ("Tenant admin will enable or
 * disable if needed").
 *
 * So the BINDING is a config key on the node INSTANCE, declared here, and the
 * descriptor field remains the type-level default the instance overrides.
 * `EvalPromotionGateService` reads instance-first, descriptor-second.
 *
 * ## Why it must be DECLARED rather than merely tolerated
 *
 * Every config schema is `additionalProperties: false`, and the Studio's
 * inspector builds its form from `Object.entries(schema.properties)` alone. An
 * undeclared key is stripped twice over — rejected by the value evaluator and
 * dropped by form generation — so a node round-tripped through the authoring UI
 * would come back with NO GATE. That is a safety control disappearing silently,
 * which is the one failure mode this ticket is written to prevent.
 */
import { describe, expect, it } from 'vitest';
import { jsonSchemaValueProblems } from '@arcaai/json-schema-subset';
import { NODE_CONFIG_SCHEMAS, type NodeConfigSchema } from '../node-config-schemas';
import { WORKFLOW_NODE_REGISTRY } from '../node-registry';

const PROMPT_CARRYING_KEYS = [
  // TASK-806 lane A — DD-9's three generation entries reuse `consultation.synthesize`'s schema.
  'agent.presummarization',
  'agent.summarization',
  'agent.discharge_summary',
  'prompt.template_ref',
  'generate.text',
  'consultation.assemblePrompt',
  'consultation.synthesize',
  'consultation.realtimeSummary',
  'consultation.suggestions',
  'consultation.proposeCorrections',
] as const;

const BASE_CONFIG: Record<(typeof PROMPT_CARRYING_KEYS)[number], Record<string, unknown>> = {
  'agent.presummarization': { producesCode: false, onError: 'fail' },
  'agent.summarization': { producesCode: false, onError: 'fail' },
  'agent.discharge_summary': { producesCode: false, onError: 'fail' },
  'prompt.template_ref': { promptTemplateId: '3f1a7c2e-5b84-4d19-9e63-0a2c8d5f7b41' },
  'generate.text': { taskKey: 'text.finalize' },
  'consultation.assemblePrompt': { requiresFinalized: true, onError: 'fail' },
  'consultation.synthesize': { producesCode: false, onError: 'fail' },
  'consultation.realtimeSummary': { onError: 'degrade' },
  'consultation.suggestions': { onError: 'degrade' },
  'consultation.proposeCorrections': { onError: 'degrade' },
};

const GOLDEN_SET_ID = '9c2f0f1e-6c1a-4a2b-8f3d-1b7e5c9a0d24';

function roundTripThroughGeneratedForm(schema: NodeConfigSchema, config: Record<string, unknown>): Record<string, unknown> {
  const declared = Object.keys((schema.properties ?? {}) as Record<string, unknown>);
  return Object.fromEntries(Object.entries(config).filter(([key]) => declared.includes(key)));
}

describe('OD-11 — the eval gate is a declared node-config key', () => {
  it.each(PROMPT_CARRYING_KEYS)('%s declares evalGate', (key) => {
    const properties = NODE_CONFIG_SCHEMAS[key].properties as Record<string, unknown>;
    expect(Object.hasOwn(properties, 'evalGate')).toBe(true);
  });

  it.each(PROMPT_CARRYING_KEYS)('%s: the value evaluator accepts a well-formed gate', (key) => {
    const config = { ...BASE_CONFIG[key], evalGate: { goldenSetId: GOLDEN_SET_ID, enabled: true } };
    expect(jsonSchemaValueProblems(NODE_CONFIG_SCHEMAS[key], config)).toEqual([]);
  });

  it.each(PROMPT_CARRYING_KEYS)('%s: the gate survives a generated-form round-trip', (key) => {
    const config = { ...BASE_CONFIG[key], evalGate: { goldenSetId: GOLDEN_SET_ID, enabled: false } };
    const roundTripped = roundTripThroughGeneratedForm(NODE_CONFIG_SCHEMAS[key], config);
    expect(roundTripped.evalGate).toEqual({ goldenSetId: GOLDEN_SET_ID, enabled: false });
  });

  it('REFUSES a gate with no goldenSetId — an enabled gate with no golden set gates nothing', () => {
    const config = { taskKey: 'text.finalize', evalGate: { enabled: true } };
    expect(jsonSchemaValueProblems(NODE_CONFIG_SCHEMAS['generate.text'], config).length).toBeGreaterThan(0);
  });

  it('REFUSES a gate with no `enabled` — the tenant-admin toggle is not optional', () => {
    // OD-11 makes disabling the gate an EXPLICIT act. An absent `enabled` would
    // have to be read as one value or the other, and either reading is a safety
    // control decided by omission.
    const config = { taskKey: 'text.finalize', evalGate: { goldenSetId: GOLDEN_SET_ID } };
    expect(jsonSchemaValueProblems(NODE_CONFIG_SCHEMAS['generate.text'], config).length).toBeGreaterThan(0);
  });

  it('REFUSES unknown keys inside the gate', () => {
    const config = { taskKey: 'text.finalize', evalGate: { goldenSetId: GOLDEN_SET_ID, enabled: true, mode: 'block' } };
    expect(jsonSchemaValueProblems(NODE_CONFIG_SCHEMAS['generate.text'], config).length).toBeGreaterThan(0);
  });

  it('covers every generation-classed node type in the registry', () => {
    const generationKeys = Object.values(WORKFLOW_NODE_REGISTRY)
      .filter((descriptor) => descriptor.classes.includes('generation'))
      .map((descriptor) => descriptor.key)
      .sort();
    expect(generationKeys.filter((key) => !PROMPT_CARRYING_KEYS.includes(key as never))).toEqual([]);
  });
});
