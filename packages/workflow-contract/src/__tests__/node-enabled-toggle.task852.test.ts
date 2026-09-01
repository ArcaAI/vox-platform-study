/**
 * TASK-852 item 3 — the per-node `enabled` toggle is DECLARED, so it is reachable.
 *
 * The realtime consultation executor has always honoured a per-node kill switch
 * (`enabled: node.config?.enabled !== false`, `realtime-lane.ts`), but `enabled` was not a
 * declared property of ANY node config schema. Every schema here is `additionalProperties:
 * false` AND the Studio inspector builds its form from `Object.entries(schema.properties)`
 * alone, so the key was stripped twice over: the validator rejected it and the authoring UI
 * had no field for it. A node round-tripped through the Studio came back with its gate
 * silently removed — the exact failure this module's own docstring describes for the prompt
 * and document bindings.
 *
 * ## The MANDATORY exclusion is derived, not a hand-kept name list
 *
 * A node type carrying the registry class `mandatory` is one the rule catalogue REQUIRES on
 * every path from `core.start` to a terminal (`rule-catalogue.ts`'s `REQUIRED_PATH_THROUGH`
 * rule with `throughClass: 'mandatory'` — "nothing routes around a gate"). `enabled: false`
 * on such a node is that same routing-around by another means: the graph still contains the
 * node, so the structural rule still passes, while the runtime skips it. For
 * `consultation.consentGate` that is a consent gate an admin can switch off — a compliance
 * defect in a healthcare product, not a feature.
 *
 * So the exclusion is not "these six node names"; it is "the class the rule catalogue already
 * uses to mean must-run", and this file asserts the two sets are the same one. A future
 * mandatory node type gets the exclusion for free; one that loses the class loses it here too,
 * visibly.
 */
import { jsonSchemaValueProblems } from '@arcaai/json-schema-subset';
import { describe, expect, it } from 'vitest';
import { NODE_CONFIG_SCHEMAS, type NodeConfigSchema } from '../node-config-schemas';
import { WORKFLOW_NODE_REGISTRY } from '../node-registry';

const propertiesOf = (key: string): Record<string, NodeConfigSchema | undefined> =>
  (NODE_CONFIG_SCHEMAS[key].properties ?? {}) as Record<string, NodeConfigSchema | undefined>;

const declaresEnabled = (key: string): boolean => Object.hasOwn(propertiesOf(key), 'enabled');

const SCHEMA_KEYS = Object.keys(NODE_CONFIG_SCHEMAS).sort();

/** Derived from the registry, never listed by hand — that IS the point of this file. */
const MANDATORY_KEYS = Object.values(WORKFLOW_NODE_REGISTRY)
  .filter((descriptor) => descriptor.classes.includes('mandatory'))
  .map((descriptor) => descriptor.key)
  .filter((key) => Object.hasOwn(NODE_CONFIG_SCHEMAS, key))
  .sort();

const TOGGLEABLE_KEYS = SCHEMA_KEYS.filter((key) => !MANDATORY_KEYS.includes(key));

/** Minimal configs that satisfy each schema's `required` set, so an assertion below can only
 *  ever fail on `enabled` and never on an unrelated missing field. */
const BASE_CONFIG: Record<string, Record<string, unknown>> = {
  'consultation.consentGate': {},
  'consultation.phiHop': { mode: 'full', onError: 'fail' },
  'consultation.hitlGate': {},
  'consultation.realtimeSummary': { onError: 'degrade' },
  'consultation.extractEntities': { requiresFinalized: false, onError: 'degrade' },
  'consultation.sensors': { onError: 'degrade' },
  'agent.important_findings': { onError: 'degrade' },
  'prompt.template_ref': { promptTemplateId: '3f1a7c2e-5b84-4d19-9e63-0a2c8d5f7b41' },
};

const TOGGLEABLE_SAMPLE = [
  'consultation.realtimeSummary',
  'consultation.extractEntities',
  'consultation.sensors',
  'agent.important_findings',
  'prompt.template_ref',
] as const;

const MANDATORY_SAMPLE = ['consultation.consentGate', 'consultation.phiHop', 'consultation.hitlGate'] as const;

describe('TASK-852 — every non-mandatory node type declares the `enabled` toggle', () => {
  it.each(TOGGLEABLE_KEYS)('%s declares `enabled` as a boolean defaulting to on', (key) => {
    const enabled = propertiesOf(key).enabled;

    expect(enabled).toBeDefined();
    expect(enabled?.type).toBe('boolean');
    // Absent must mean ENABLED — a node whose config predates this key must keep running, and
    // `realtime-lane.ts` already encodes that as `enabled: config?.enabled !== false`.
    expect((enabled as { default?: unknown } | undefined)?.default).toBe(true);
  });

  it('renders as a control the Studio can draw — a plain boolean, not a nested object', () => {
    // The inspector maps `type: 'boolean'` to a shadcn `<Switch>`; anything else degrades to the
    // raw-JSON escape hatch, which is "an admin can hand-write JSON", not "an admin can toggle".
    for (const key of TOGGLEABLE_KEYS) {
      expect(propertiesOf(key).enabled).not.toHaveProperty('properties');
    }
  });
});

describe('TASK-852 — a mandatory node type has no disable toggle at all', () => {
  it('withholds `enabled` from exactly the registry`s mandatory-class node types', () => {
    expect(SCHEMA_KEYS.filter((key) => !declaresEnabled(key))).toEqual(MANDATORY_KEYS);
  });

  it('covers the six consultation nodes a disable toggle must never reach', () => {
    // A literal restatement of the requirement, so the derivation above cannot quietly stop
    // covering the cases it exists for.
    expect(MANDATORY_KEYS).toEqual(
      expect.arrayContaining([
        'consultation.consentGate',
        'consultation.captureBinding',
        'consultation.phiHop',
        'consultation.persistDraft',
        'consultation.finalizeAssurance',
        'consultation.hitlGate',
      ]),
    );
  });

  it.each(MANDATORY_SAMPLE)('%s REJECTS a config that tries to switch it off', (key) => {
    // `additionalProperties: false` is what makes the withholding enforceable rather than
    // merely undrawn: a hand-edited graph carrying the key fails validation at authoring time.
    expect(jsonSchemaValueProblems(NODE_CONFIG_SCHEMAS[key], { ...BASE_CONFIG[key], enabled: false })).not.toEqual([]);
  });
});

describe('TASK-852 — the toggle survives the round trip that used to strip it', () => {
  it.each(TOGGLEABLE_SAMPLE)('%s: the value evaluator accepts `enabled: false`', (key) => {
    expect(jsonSchemaValueProblems(NODE_CONFIG_SCHEMAS[key], { ...BASE_CONFIG[key], enabled: false })).toEqual([]);
  });

  it.each(TOGGLEABLE_SAMPLE)('%s: `enabled` survives a generated-form round trip', (key) => {
    // What the Studio actually does: render a field per DECLARED property, then read the form
    // back. An undeclared key has no field, so it is dropped — which is the half of the bug
    // that no validator would ever have caught.
    const declared = Object.keys(propertiesOf(key));
    const roundTripped = Object.fromEntries(
      Object.entries({ ...BASE_CONFIG[key], enabled: false }).filter(([name]) => declared.includes(name)),
    );

    expect(roundTripped.enabled).toBe(false);
  });

  it.each(TOGGLEABLE_SAMPLE)('%s: still rejects a non-boolean `enabled`', (key) => {
    expect(jsonSchemaValueProblems(NODE_CONFIG_SCHEMAS[key], { ...BASE_CONFIG[key], enabled: 'off' })).not.toEqual([]);
  });
});
