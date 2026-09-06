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
 * ## What TASK-890 D-1 changed (owner decision, 2026-09-06)
 *
 * The withholding used to key off the registry class `mandatory`, so the seven clinical guard
 * nodes offered no toggle at all. The owner decided the opposite: a tenant MAY opt out of
 * platform guardrail screening per agent / workflow / node, and the compensating controls are a
 * publish WARNING (`GUARDRAIL_OPTED_OUT`), a per-call ledger attribute (`guardrail: 'opted_out'`)
 * and an observable `SKIPPED(disabled_by_config)` step — not the absence of a switch. So the
 * fold now withholds `enabled` from the two GRAPH BOUNDARIES alone (`core.trigger`,
 * `core.output`), whose disablement is an unrunnable graph rather than a guardrail opinion.
 *
 * `MANDATORY_NODE_TYPES` itself is UNCHANGED and still mirrored against the registry below: it is
 * what the mandatory-PRESENCE rules and the `GUARDRAIL_OPTED_OUT` finding both read, and D-1
 * relaxes EXECUTION, never presence. `consultation.hitlGate` — the human sign-off — still offers
 * no runtime knob at all, because it is the one `gate`-classed type and sits in
 * `RUNTIME_PROPERTY_EXCLUSIONS` (TASK-859 invariant 5: the system never signs).
 */
import { jsonSchemaValueProblems } from '@arcaai/json-schema-subset';
import { describe, expect, it } from 'vitest';
import { GRAPH_BOUNDARY_NODE_TYPES, MANDATORY_NODE_TYPES, NODE_CONFIG_SCHEMAS, type NodeConfigSchema } from '../node-config-schemas';
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

/** The one type whose schema the COMPILER (not an activity) consumes — it offers no runtime knob. */
const RUNTIME_EXCLUDED_KEYS = ['consultation.hitlGate'];

const BOUNDARY_KEYS = [...GRAPH_BOUNDARY_NODE_TYPES].sort();

const TOGGLEABLE_KEYS = SCHEMA_KEYS.filter((key) => !BOUNDARY_KEYS.includes(key) && !RUNTIME_EXCLUDED_KEYS.includes(key));

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
  'core.trigger': { kinds: ['api'] },
  'core.output': {},
  'guardrail.check': { guardrailType: 'groundedness', failOn: 'unsafe_or_unknown', onFail: 'mark' },
  'consultation.finalizeAssurance': { onError: 'fail' },
};

const TOGGLEABLE_SAMPLE = [
  'consultation.realtimeSummary',
  'consultation.extractEntities',
  'consultation.sensors',
  'agent.important_findings',
  'prompt.template_ref',
] as const;

/** D-1: the clinical guard nodes that now OFFER the toggle. */
const MANDATORY_GUARD_SAMPLE = ['guardrail.check', 'consultation.consentGate', 'consultation.phiHop', 'consultation.finalizeAssurance'] as const;

describe('every node type except the two graph boundaries declares the `enabled` toggle', () => {
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

  it.each(MANDATORY_GUARD_SAMPLE)('%s (a MANDATORY clinical guard) offers the toggle after D-1', (key) => {
    expect(declaresEnabled(key)).toBe(true);
    expect(jsonSchemaValueProblems(NODE_CONFIG_SCHEMAS[key], { ...BASE_CONFIG[key], enabled: false })).toEqual([]);
  });
});

describe('the two graph boundaries — and the human gate — still have no disable toggle', () => {
  it('withholds `enabled` from exactly `core.trigger`, `core.output` and the runtime-excluded gate', () => {
    expect(SCHEMA_KEYS.filter((key) => !declaresEnabled(key))).toEqual([...BOUNDARY_KEYS, ...RUNTIME_EXCLUDED_KEYS].sort());
  });

  it.each(BOUNDARY_KEYS)('%s REJECTS a config that tries to switch it off', (key) => {
    // `additionalProperties: false` is what makes the withholding enforceable rather than
    // merely undrawn: a hand-edited graph carrying the key fails validation at authoring time.
    expect(jsonSchemaValueProblems(NODE_CONFIG_SCHEMAS[key], { ...BASE_CONFIG[key], enabled: false })).not.toEqual([]);
  });

  it('`consultation.hitlGate` still offers NO runtime knob at all (invariant 5 — the system never signs)', () => {
    const properties = propertiesOf('consultation.hitlGate');
    expect(Object.hasOwn(properties, 'enabled')).toBe(false);
    expect(Object.hasOwn(properties, 'retry')).toBe(false);
    expect(jsonSchemaValueProblems(NODE_CONFIG_SCHEMAS['consultation.hitlGate'], { enabled: false })).not.toEqual([]);
  });
});

describe('the mandatory class still mirrors the registry — D-1 relaxed EXECUTION, not PRESENCE', () => {
  it('`MANDATORY_NODE_TYPES` is exactly the registry`s mandatory-class node types', () => {
    expect([...MANDATORY_NODE_TYPES].sort()).toEqual(MANDATORY_KEYS);
  });

  it('covers the six consultation nodes the presence rules exist for', () => {
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

  it('the graph boundaries are a SUBSET of the mandatory set — a boundary is mandatory for a structural reason', () => {
    for (const key of GRAPH_BOUNDARY_NODE_TYPES) expect(MANDATORY_NODE_TYPES.has(key)).toBe(true);
    expect(BOUNDARY_KEYS).toEqual(['core.output', 'core.trigger']);
  });
});

describe('the toggle survives the round trip that used to strip it', () => {
  it.each(TOGGLEABLE_SAMPLE)('%s: the value evaluator accepts `enabled: false`', (key) => {
    expect(jsonSchemaValueProblems(NODE_CONFIG_SCHEMAS[key], { ...BASE_CONFIG[key], enabled: false })).toEqual([]);
  });

  it.each(TOGGLEABLE_SAMPLE)('%s: `enabled` survives a generated-form round trip', (key) => {
    // What the Studio actually does: render a field per DECLARED property, then read the form
    // back. An undeclared key has no field, so it is dropped — which is the half of the bug
    // that no validator would ever have caught.
    const declared = Object.keys(propertiesOf(key));
    const roundTripped = Object.fromEntries(Object.entries({ ...BASE_CONFIG[key], enabled: false }).filter(([name]) => declared.includes(name)));

    expect(roundTripped.enabled).toBe(false);
  });

  it.each(TOGGLEABLE_SAMPLE)('%s: still rejects a non-boolean `enabled`', (key) => {
    expect(jsonSchemaValueProblems(NODE_CONFIG_SCHEMAS[key], { ...BASE_CONFIG[key], enabled: 'off' })).not.toEqual([]);
  });
});
