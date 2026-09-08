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
 * `MANDATORY_NODE_TYPES` is still mirrored against the registry below: it is what the
 * mandatory-PRESENCE rules and the `GUARDRAIL_OPTED_OUT` finding both read, and D-1 relaxes
 * EXECUTION, never presence.
 *
 * ## What TASK-893 Phase 4 changed
 *
 * The clinical guards are no longer node TYPES. They are ACTIONS behind `core.action`, so the
 * `mandatory` class they carry lives in `ACTION_CATALOGUE` and is resolved per instance by
 * `classesOf('core.action', config)`. `MANDATORY_NODE_TYPES` is therefore the two graph
 * boundaries alone, and the toggle contract is asserted on BOTH maps — node schemas and action
 * schemas — because an action's config is validated under the node's `action` sub-config.
 */
import { jsonSchemaValueProblems } from '@arcaai/json-schema-subset';
import { describe, expect, it } from 'vitest';
import { ACTION_CATALOGUE } from '../action-catalogue';
import {
  ACTION_CONFIG_SCHEMAS,
  GRAPH_BOUNDARY_NODE_TYPES,
  MANDATORY_NODE_TYPES,
  NODE_CONFIG_SCHEMAS,
  type NodeConfigSchema,
} from '../node-config-schemas';
import { WORKFLOW_NODE_REGISTRY } from '../node-registry';

/** Both halves of the authorable surface: a node's own config, and an action's sub-config. */
const ALL_SCHEMAS: Readonly<Record<string, NodeConfigSchema>> = { ...NODE_CONFIG_SCHEMAS, ...ACTION_CONFIG_SCHEMAS };

const propertiesOf = (key: string): Record<string, NodeConfigSchema | undefined> =>
  (ALL_SCHEMAS[key].properties ?? {}) as Record<string, NodeConfigSchema | undefined>;

const declaresEnabled = (key: string): boolean => Object.hasOwn(propertiesOf(key), 'enabled');

const SCHEMA_KEYS = Object.keys(ALL_SCHEMAS).sort();

/** Derived from the registry and the action catalogue, never listed by hand — that IS the point
 *  of this file. A `mandatory` action carries the class in its catalogue entry; `classesOf`
 *  resolves it onto the hosting `core.action` instance. */
const MANDATORY_KEYS = [
  ...Object.values(WORKFLOW_NODE_REGISTRY)
    .filter((descriptor) => descriptor.classes.includes('mandatory'))
    .map((descriptor) => descriptor.key),
  ...Object.values(ACTION_CATALOGUE)
    .filter((descriptor) => descriptor.classes.includes('mandatory'))
    .map((descriptor) => descriptor.key),
]
  .filter((key) => Object.hasOwn(ALL_SCHEMAS, key))
  .sort();

const BOUNDARY_KEYS = [...GRAPH_BOUNDARY_NODE_TYPES].sort();

const TOGGLEABLE_KEYS = SCHEMA_KEYS.filter((key) => !BOUNDARY_KEYS.includes(key));

/** Minimal configs that satisfy each schema's `required` set, so an assertion below can only
 *  ever fail on `enabled` and never on an unrelated missing field. */
const BASE_CONFIG: Record<string, Record<string, unknown>> = {
  'consultation.consentGate': {},
  'consultation.phiHop': { mode: 'full', onError: 'fail' },
  'consultation.persistDraft': { onError: 'fail' },
  'consultation.finalizeAssurance': { onError: 'fail' },
  'consultation.sensors': { onError: 'degrade' },
  'consultation.retrieveEvidence': { onError: 'degrade' },
  'prompt.template_ref': { promptTemplateId: '3f1a7c2e-5b84-4d19-9e63-0a2c8d5f7b41' },
  'core.trigger': { kinds: ['api'] },
  'core.output': {},
  'core.agent': { agentRef: { slug: 'demo-agent' } },
  'guard.moderation': { guardrailType: 'groundedness', failOn: 'unsafe_or_unknown', onFail: 'mark' },
};

const TOGGLEABLE_SAMPLE = ['core.agent', 'consultation.sensors', 'consultation.retrieveEvidence', 'prompt.template_ref'] as const;

/** D-1: the clinical guards that now OFFER the toggle — all four are actions since Phase 4. */
const MANDATORY_GUARD_SAMPLE = [
  'guard.moderation',
  'consultation.consentGate',
  'consultation.phiHop',
  'consultation.finalizeAssurance',
] as const;

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
    expect(jsonSchemaValueProblems(ALL_SCHEMAS[key], { ...BASE_CONFIG[key], enabled: false })).toEqual([]);
  });
});

describe('the two graph boundaries still have no disable toggle', () => {
  it('withholds `enabled` from exactly `core.trigger` and `core.output`', () => {
    expect(SCHEMA_KEYS.filter((key) => !declaresEnabled(key))).toEqual(BOUNDARY_KEYS);
  });

  it.each(BOUNDARY_KEYS)('%s REJECTS a config that tries to switch it off', (key) => {
    // `additionalProperties: false` is what makes the withholding enforceable rather than
    // merely undrawn: a hand-edited graph carrying the key fails validation at authoring time.
    expect(jsonSchemaValueProblems(NODE_CONFIG_SCHEMAS[key], { ...BASE_CONFIG[key], enabled: false })).not.toEqual([]);
  });

  it('the human sign-off is still the tenant`s, never the platform`s (invariant 5)', () => {
    // TASK-859 invariant 5 — "the system never signs" — is about who DECIDES, never about which
    // nodes may be SKIPPED, so D-1 leaves it untouched. `core.humanReview` is the durable human
    // wait; the property that carries the invariant is that a REVIEW DECISION is never
    // authorable as config, and it is not: the schema offers a deadline and its behaviour on
    // expiry, and no key that stands in for a signature.
    const properties = propertiesOf('core.humanReview');
    expect(Object.hasOwn(properties, 'decision')).toBe(false);
    expect(Object.hasOwn(properties, 'approved')).toBe(false);
    expect(jsonSchemaValueProblems(NODE_CONFIG_SCHEMAS['core.humanReview'], { approved: true })).not.toEqual([]);
  });
});

describe('the mandatory class still mirrors the registry — D-1 relaxed EXECUTION, not PRESENCE', () => {
  it('`MANDATORY_NODE_TYPES` is exactly the registry`s mandatory-class node types', () => {
    // The projection in `node-config-schemas.ts` mirrors NODE TYPES only; a mandatory ACTION
    // carries the class in `ACTION_CATALOGUE` and reaches a node through `classesOf`, so it is
    // asserted separately below rather than folded into this set.
    const mandatoryNodeTypes = Object.values(WORKFLOW_NODE_REGISTRY)
      .filter((descriptor) => descriptor.classes.includes('mandatory'))
      .map((descriptor) => descriptor.key)
      .sort();
    expect([...MANDATORY_NODE_TYPES].sort()).toEqual(mandatoryNodeTypes);
  });

  it('covers the clinical actions the presence rules exist for', () => {
    // A literal restatement of the requirement, so the derivation above cannot quietly stop
    // covering the cases it exists for. `consultation.captureBinding` and `consultation.hitlGate`
    // left the vocabulary with TASK-893 Phase 4 — the human wait is `core.humanReview`, which is
    // `review`-classed rather than `mandatory`.
    expect(MANDATORY_KEYS).toEqual(
      expect.arrayContaining([
        'consultation.consentGate',
        'consultation.phiHop',
        'consultation.persistDraft',
        'consultation.finalizeAssurance',
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
    expect(jsonSchemaValueProblems(ALL_SCHEMAS[key], { ...BASE_CONFIG[key], enabled: false })).toEqual([]);
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
    expect(jsonSchemaValueProblems(ALL_SCHEMAS[key], { ...BASE_CONFIG[key], enabled: 'off' })).not.toEqual([]);
  });
});
