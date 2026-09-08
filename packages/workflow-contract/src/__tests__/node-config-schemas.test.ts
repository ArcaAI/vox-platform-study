/**
 * Closes the "per-node `configSchema` was never built" gap `registry.contract.md` recorded
 * (`node-config-schemas.ts`'s own docstring). Two things must hold:
 *
 * 1. Every schema this module ships is AUTHORABLE (`authorableJsonSchemaProblems` from
 *    `@arcaai/json-schema-subset`) — the same cross-check `registry.contract.md`'s Task 3
 *    itself named as the verification step: "the schema in the registry contract must be
 *    accepted by `authorableJsonSchemaProblems`."
 * 2. `WORKFLOW_NODE_REGISTRY` actually carries it on `configSchema`.
 *
 * TASK-893 Phase 4 retired the legacy palettes, so the census below is the ELEVEN `core.*` node
 * types plus the SEVENTEEN action keys behind `core.action`. The consultation / guard / stt /
 * summarization node types this file used to enumerate did not lose their schemas — the schemas
 * moved to `ACTION_CONFIG_SCHEMAS`, keyed by action key, and are asserted there.
 */
import { authorableJsonSchemaProblems, jsonSchemaValueProblems } from '@arcaai/json-schema-subset';
import { describe, expect, it } from 'vitest';
import { ACTION_CATALOGUE } from '../action-catalogue';
import { ACTION_CONFIG_SCHEMAS, NODE_CONFIG_SCHEMAS, type NodeConfigSchema } from '../node-config-schemas';
import { classesOf, WORKFLOW_NODE_REGISTRY } from '../node-registry';

/** The eleven `core.*` types TASK-864 introduced and TASK-893 left as the whole node vocabulary. */
const CORE_NODE_TYPES = [
  'core.trigger',
  'core.agent',
  'core.classify',
  'core.humanReview',
  'core.variable',
  'core.condition',
  'core.loop',
  'core.note',
  'core.output',
  'core.data',
  'core.action',
] as const;

describe('NODE_CONFIG_SCHEMAS', () => {
  it.each(Object.entries(NODE_CONFIG_SCHEMAS))('%s config schema is authorable', (_key, schema) => {
    expect(authorableJsonSchemaProblems(schema)).toEqual([]);
  });

  it('carries a schema for every node type in the registry', () => {
    expect(Object.keys(NODE_CONFIG_SCHEMAS).sort()).toEqual([...CORE_NODE_TYPES].sort());
    expect(Object.keys(NODE_CONFIG_SCHEMAS).sort()).toEqual(Object.keys(WORKFLOW_NODE_REGISTRY).sort());
  });
});

/**
 * TASK-893 §7.2 — the SEVENTEEN actions behind `core.action`.
 *
 * Each of these was a node type of its own until Phase 4. Its config schema is unchanged; what
 * changed is where it is keyed. `actionConfigSchemaOf` validates a `core.action` node's `action`
 * sub-config against the entry below, so the same two directions still have to hold: a schema
 * that omitted a field the validator demands would reject graphs the rule set requires, and one
 * that omitted a key the interpreter activity reads would reject config the runtime honours.
 */
describe('ACTION_CONFIG_SCHEMAS (TASK-893 §7.2)', () => {
  const ACTION_KEYS = Object.keys(ACTION_CATALOGUE);
  const CONSULTATION_ACTION_KEYS = ACTION_KEYS.filter((key) => key.startsWith('consultation.'));

  it.each(Object.entries(ACTION_CONFIG_SCHEMAS))('%s action config schema is authorable', (_key, schema) => {
    expect(authorableJsonSchemaProblems(schema)).toEqual([]);
  });

  it('covers every one of the seventeen catalogue actions', () => {
    expect(ACTION_KEYS).toHaveLength(17);
    expect(Object.keys(ACTION_CONFIG_SCHEMAS).sort()).toEqual([...ACTION_KEYS].sort());
  });

  it('keeps the eight consultation actions the clinical palette contributed', () => {
    expect(CONSULTATION_ACTION_KEYS.sort()).toEqual(
      [
        'consultation.bindTerminology',
        'consultation.consentGate',
        'consultation.finalizeAssurance',
        'consultation.inferentialSensors',
        'consultation.persistDraft',
        'consultation.phiHop',
        'consultation.retrieveEvidence',
        'consultation.sensors',
      ].sort(),
    );
  });

  it.each(ACTION_KEYS)('%s is a closed object schema', (key) => {
    const schema = ACTION_CONFIG_SCHEMAS[key];
    expect(schema.type).toBe('object');
    expect(schema.additionalProperties).toBe(false);
  });

  // Fields the rule set already demands must stay AUTHORABLE, or the schema and the validator
  // contradict each other and no graph can satisfy both.
  it.each([
    ['consultation.persistDraft', 'occ'],
    ['consultation.bindTerminology', 'purposeScope'],
    ['consultation.bindTerminology', 'unmappedOutputKey'],
  ])('%s permits the rule-catalogue field %s', (key, field) => {
    const properties = ACTION_CONFIG_SCHEMAS[key].properties as Record<string, unknown>;
    expect(Object.hasOwn(properties, field)).toBe(true);
  });

  /**
   * The error policy travels with the ACTIVITY-classed actions, exactly as it did when each was
   * its own node type. `consultation.consentGate` is not activity-classed, so demanding an error
   * policy of it would be a constraint nothing enforces.
   */
  it('declares `onError` on exactly the activity-classed consultation actions', () => {
    for (const key of CONSULTATION_ACTION_KEYS) {
      const properties = ACTION_CONFIG_SCHEMAS[key].properties as Record<string, { enum?: string[] } | undefined>;
      if (ACTION_CATALOGUE[key].classes.includes('activity')) {
        expect(properties.onError?.enum, key).toEqual(['degrade', 'retry', 'fail']);
        expect(ACTION_CONFIG_SCHEMAS[key].required, key).toContain('onError');
      } else {
        expect(properties.onError, key).toBeUndefined();
      }
    }
  });

  it('offers only the error values the interpreter can honour — never `abort`', () => {
    // A value the runtime cannot enforce must be rejected at authoring time, not accepted and
    // silently ignored — the same posture `guard.moderation.onFail` takes below.
    for (const key of ACTION_KEYS) {
      const properties = ACTION_CONFIG_SCHEMAS[key].properties as Record<string, { enum?: string[] } | undefined>;
      expect(properties.onError?.enum ?? [], key).not.toContain('abort');
    }
  });

  it.each([
    ['consultation.bindTerminology', ['unmappedOutputKey']],
    ['consultation.phiHop', ['mode']],
    ['consultation.retrieveEvidence', ['retrievalEnabled']],
    ['session.timeout', ['idleTimeoutSeconds', 'runEndpointOnExpiry']],
    ['feedback.capture', ['promoteCorrections', 'minConfidence']],
    ['livedoc.stop', ['persistSnapshot']],
    ['summary.finalize', ['lockConfirmedOnly']],
    ['guard.groundedness', ['threshold', 'taskKey', 'policies']],
  ] as const)('%s permits every key its interpreter activity reads', (key, fields) => {
    const properties = ACTION_CONFIG_SCHEMAS[key].properties as Record<string, unknown>;
    for (const field of fields) {
      expect(Object.hasOwn(properties, field), `${key}.${field}`).toBe(true);
    }
  });

  it('consultation.consentGate accepts no config OF ITS OWN — only the palette-agnostic runtime knobs', () => {
    // The gate's activity reads no `payload.config` (`nodes/consultation.py:44`), but the
    // interpreter still honours `timeoutSeconds`/`retry`/`enabled` on the node that hosts the
    // action — see the ADDENDUM at the foot of `node-config-schemas.ts`.
    expect(Object.keys(ACTION_CONFIG_SCHEMAS['consultation.consentGate'].properties as object).sort()).toEqual([
      'enabled',
      'retry',
      'timeoutSeconds',
    ]);
  });

  /**
   * The `mode` enum drives the Studio inspector, so getting it wrong is a patient-safety defect
   * rather than a cosmetic one: a wrong enum offers an admin a value that DEGRADEs at runtime
   * while hiding the value that actually redacts — a redaction node that silently does not redact.
   */
  it('consultation.phiHop mode matches its ACTIVITY guard (`pseudonymize` | `full`)', () => {
    // `nodes/consultation.py:102` -> `if mode not in ("pseudonymize", "full"):`
    const properties = ACTION_CONFIG_SCHEMAS['consultation.phiHop'].properties as Record<string, { enum?: string[] }>;
    expect(properties.mode.enum).toEqual(['pseudonymize', 'full']);
    expect(properties.mode.enum).not.toContain('full-redact');
  });

  it('guard.phi shares the redaction vocabulary — the two are the same activity', () => {
    expect(ACTION_CONFIG_SCHEMAS['guard.phi']).toEqual(ACTION_CONFIG_SCHEMAS['consultation.phiHop']);
    expect(ACTION_CATALOGUE['guard.phi'].classes).toContain('redaction');
  });
});

describe('guard.moderation onFail (W4 — M-1)', () => {
  // The interpreter has NO mechanism for a per-node CONFIG value to override a CODE-OWNED
  // catalogue property: `critical` lives on the descriptor and `NodeActivityResult.status` is
  // `Literal['SUCCEEDED','DEGRADED','SKIPPED']` — there is no `FAILED` an activity can return,
  // and only the workflow body promotes a degraded CRITICAL node to a run-level failure.
  // `guard.moderation` is `critical: false`. So a tenant authoring `onFail: 'abort'` got SILENT
  // NON-ENFORCEMENT: the value validated, was recorded, and changed nothing.
  //
  // Of the two acceptable fixes — enforce it, or reject it at compile time — only the second is
  // available to the shipped v1 interpreter. Rejecting at authoring time is also the safer half:
  // a tenant who asks for "abort" and silently gets "mark" believes they have a hard gate they
  // do not have. `failOn` already set this precedent (restricted to its one v1-permitted value).
  it('does not offer `abort`, which the v1 interpreter cannot enforce', () => {
    const schema = ACTION_CONFIG_SCHEMAS['guard.moderation'];
    // `NodeConfigSchema` is `Readonly<Record<string, unknown>>`, so `properties` is `unknown`.
    // Optional-chaining it narrows to `{}` rather than to a record, so the member access has to
    // be typed on the WAY IN, not on the way out.
    const properties = schema.properties as Record<string, { enum?: string[] } | undefined> | undefined;
    expect(properties?.onFail?.enum).toEqual(['mark']);
  });
});

describe('WORKFLOW_NODE_REGISTRY.configSchema wiring', () => {
  it('attaches the real schema to the agent node type', () => {
    const schema = WORKFLOW_NODE_REGISTRY['core.agent'].configSchema;
    expect(schema).toBeDefined();
    expect(schema?.required).toEqual(['agentRef']);
  });

  it('attaches the real schema to the action node type', () => {
    const schema = WORKFLOW_NODE_REGISTRY['core.action'].configSchema;
    expect(schema).toBeDefined();
    expect(schema?.required).toEqual(['actionKey']);
  });

  it('leaves no node type without a schema — `passthrough`, the last exception, is retired', () => {
    const unschemad = Object.keys(WORKFLOW_NODE_REGISTRY).filter((key) => WORKFLOW_NODE_REGISTRY[key].configSchema === undefined);
    expect(unschemad).toEqual([]);
  });

  it('every OTHER descriptor field is unaffected by the configSchema derivation', () => {
    const descriptor = WORKFLOW_NODE_REGISTRY['core.agent'];
    expect(descriptor.key).toBe('core.agent');
    expect(descriptor.paletteKey).toBe('core');
    expect(descriptor.classes).toEqual(['agent']);
  });
});

/**
 * carry-over 1 — DD-11's prompt PIN must survive a schema round-trip.
 *
 * DD-11 stores a prompt binding as two keys on the node's OWN config
 * (`node-prompt-binding.ts` in `@arcaai/applications`): `promptTemplateId` (WHICH template) and
 * `promptVersionNumber` (WHICH IMMUTABLE VERSION — its own movable pin). The pin is the entire
 * mechanism that stops an admin editing one shared template from silently changing every
 * workflow that references it.
 *
 * Every config schema here is `additionalProperties: false`, and the Studio's inspector builds
 * its form from `Object.entries(schema.properties)` alone
 * (`apps/admin-console/src/features/workflow-studio/lib/schema-form.ts:130`). So an UNDECLARED
 * binding key is stripped twice over: rejected by the value evaluator, and dropped by form
 * generation because no field is ever rendered for it.
 *
 * TASK-893 moved the carrier. In the `core` vocabulary a generation step is `core.agent`, whose
 * prompt comes from the REFERENCED published Agent rather than from a per-node template pin —
 * so the only surface that still binds a template directly is the `prompt.template_ref` ACTION.
 */
describe('DD-11 prompt binding survives a config-schema round-trip', () => {
  const PROMPT_CARRYING_ACTIONS = ['prompt.template_ref'] as const;

  const TEMPLATE_ID = '3f1a7c2e-5b84-4d19-9e63-0a2c8d5f7b41';
  const PINNED_VERSION = 4;

  /** What the Studio actually does to a config: render a field per DECLARED property, then read
   *  the form back. Anything absent from `schema.properties` has no field, so it is dropped. */
  function roundTripThroughGeneratedForm(schema: NodeConfigSchema, config: Record<string, unknown>): Record<string, unknown> {
    const declared = Object.keys((schema.properties ?? {}) as Record<string, unknown>);
    return Object.fromEntries(Object.entries(config).filter(([key]) => declared.includes(key)));
  }

  it('covers every action that binds a prompt template', () => {
    // Keyed off the CATALOGUE, not a hand-kept list: an action whose schema declares the binding
    // keys but is missing here is exactly the drift this catches.
    const binding = Object.keys(ACTION_CONFIG_SCHEMAS)
      .filter((key) => Object.hasOwn((ACTION_CONFIG_SCHEMAS[key].properties ?? {}) as object, 'promptTemplateId'))
      .sort();
    expect(binding).toEqual([...PROMPT_CARRYING_ACTIONS].sort());
  });

  it('no core node type carries a per-node prompt pin — the agent reference replaces it', () => {
    const binding = Object.keys(NODE_CONFIG_SCHEMAS).filter((key) =>
      Object.hasOwn((NODE_CONFIG_SCHEMAS[key].properties ?? {}) as object, 'promptTemplateId'),
    );
    expect(binding).toEqual([]);
    const agentProperties = NODE_CONFIG_SCHEMAS['core.agent'].properties as Record<string, unknown>;
    expect(Object.hasOwn(agentProperties, 'agentRef')).toBe(true);
  });

  it.each(PROMPT_CARRYING_ACTIONS)('%s declares both DD-11 binding keys', (key) => {
    const properties = ACTION_CONFIG_SCHEMAS[key].properties as Record<string, unknown>;
    expect(Object.hasOwn(properties, 'promptTemplateId')).toBe(true);
    expect(Object.hasOwn(properties, 'promptVersionNumber')).toBe(true);
  });

  it.each(PROMPT_CARRYING_ACTIONS)('%s: the value evaluator accepts a config carrying a pin', (key) => {
    const config = { promptTemplateId: TEMPLATE_ID, promptVersionNumber: PINNED_VERSION };
    expect(jsonSchemaValueProblems(ACTION_CONFIG_SCHEMAS[key], config)).toEqual([]);
  });

  it.each(PROMPT_CARRYING_ACTIONS)('%s: the pin survives a generated-form round-trip', (key) => {
    const config = { promptTemplateId: TEMPLATE_ID, promptVersionNumber: PINNED_VERSION };
    const roundTripped = roundTripThroughGeneratedForm(ACTION_CONFIG_SCHEMAS[key], config);
    expect(roundTripped.promptTemplateId).toBe(TEMPLATE_ID);
    expect(roundTripped.promptVersionNumber).toBe(PINNED_VERSION);
  });

  it.each(PROMPT_CARRYING_ACTIONS)('%s types the pin exactly as DD-11 writes it (a positive integer)', (key) => {
    // `readBinding` accepts the pin only when `Number.isInteger(pinned) && pinned > 0`, and the
    // compiled artifact declares `versionNumber: { type: 'integer', minimum: 1 }` on the
    // normative schema AND both Python models. All three must agree, or a value authorable here
    // is unpinnable there.
    const properties = ACTION_CONFIG_SCHEMAS[key].properties as Record<string, { type?: string; minimum?: number }>;
    expect(properties.promptVersionNumber.type).toBe('integer');
    expect(properties.promptVersionNumber.minimum).toBe(1);
  });

  it.each(PROMPT_CARRYING_ACTIONS)('%s still rejects a non-positive pin', (key) => {
    const config = { promptTemplateId: TEMPLATE_ID, promptVersionNumber: 0 };
    expect(jsonSchemaValueProblems(ACTION_CONFIG_SCHEMAS[key], config)).not.toEqual([]);
  });
});

/**
 * a generation node's DOCUMENT-TEMPLATE binding must survive the same round-trip
 * DD-11's prompt pin does.
 *
 * DD-2 ("no runtime shape switching") states that a generation node binds ONE document shape
 * STATICALLY in its config — `documentTemplateId` (WHICH template) and `documentVersionNumber`
 * (WHICH IMMUTABLE VERSION, its own movable pin) — because it guards against the same failure
 * one layer over: a tenant publishing a new `DocumentTemplate` version must not silently change
 * the structure every already-published clinical workflow produces.
 *
 * After TASK-893 the generation class is resolved PER INSTANCE (`classesOf`), and `core.agent` is
 * the one type that resolves to it. The registry descriptor deliberately stays `['agent']`, so
 * this block keys off `classesOf` rather than off `descriptor.classes`.
 */
describe('DD-2 document-template binding survives a config-schema round-trip', () => {
  const DOCUMENT_CARRYING_KEYS = ['core.agent'] as const;

  /** Minimal configs satisfying each schema's own `required`, so the assertions below fail on
   *  the BINDING and never on an unrelated missing field. */
  const DOCUMENT_BASE_CONFIG: Record<(typeof DOCUMENT_CARRYING_KEYS)[number], Record<string, unknown>> = {
    'core.agent': { agentRef: { slug: 'demo-agent' } },
  };

  const DOCUMENT_TEMPLATE_ID = 'a41b6d0c-2f38-4c77-9a51-6d2e7b0c4f93';
  const DOCUMENT_PINNED_VERSION = 2;

  function roundTripThroughGeneratedForm(schema: NodeConfigSchema, config: Record<string, unknown>): Record<string, unknown> {
    const declared = Object.keys((schema.properties ?? {}) as Record<string, unknown>);
    return Object.fromEntries(Object.entries(config).filter(([key]) => declared.includes(key)));
  }

  it('covers exactly the generation-classed node types', () => {
    // Keyed off the INSTANCE class resolution, not a hand-kept list: the next node type someone
    // resolves to `generation` must not be able to ship WITHOUT a document binding and have
    // nothing say so.
    const generationKeys = Object.keys(WORKFLOW_NODE_REGISTRY)
      .filter((key) => classesOf(key).includes('generation'))
      .sort();
    expect(generationKeys).toEqual([...DOCUMENT_CARRYING_KEYS].sort());
  });

  it.each(DOCUMENT_CARRYING_KEYS)('%s declares both DD-2 binding keys', (key) => {
    const properties = NODE_CONFIG_SCHEMAS[key].properties as Record<string, unknown>;
    expect(Object.hasOwn(properties, 'documentTemplateId')).toBe(true);
    expect(Object.hasOwn(properties, 'documentVersionNumber')).toBe(true);
  });

  it.each(DOCUMENT_CARRYING_KEYS)('%s: the value evaluator accepts a config carrying a document pin', (key) => {
    const config = {
      ...DOCUMENT_BASE_CONFIG[key],
      documentTemplateId: DOCUMENT_TEMPLATE_ID,
      documentVersionNumber: DOCUMENT_PINNED_VERSION,
    };
    expect(jsonSchemaValueProblems(NODE_CONFIG_SCHEMAS[key], config)).toEqual([]);
  });

  it.each(DOCUMENT_CARRYING_KEYS)('%s: the document pin survives a generated-form round-trip', (key) => {
    const config = {
      ...DOCUMENT_BASE_CONFIG[key],
      documentTemplateId: DOCUMENT_TEMPLATE_ID,
      documentVersionNumber: DOCUMENT_PINNED_VERSION,
    };
    const roundTripped = roundTripThroughGeneratedForm(NODE_CONFIG_SCHEMAS[key], config);
    expect(roundTripped.documentTemplateId).toBe(DOCUMENT_TEMPLATE_ID);
    expect(roundTripped.documentVersionNumber).toBe(DOCUMENT_PINNED_VERSION);
  });

  it.each(DOCUMENT_CARRYING_KEYS)('%s types the document pin exactly as the compiled artifact does', (key) => {
    // Same bound as `versionNumber` on the normative `compiled-config.schema.json` and both
    // pydantic models (`ge=1`). A pin authorable here that those reject would be a pin the
    // interpreter cannot honour.
    const properties = NODE_CONFIG_SCHEMAS[key].properties as Record<string, { type?: string; minimum?: number }>;
    expect(properties.documentVersionNumber.type).toBe('integer');
    expect(properties.documentVersionNumber.minimum).toBe(1);
  });

  it.each(DOCUMENT_CARRYING_KEYS)('%s still rejects a non-positive document pin', (key) => {
    const config = { ...DOCUMENT_BASE_CONFIG[key], documentTemplateId: DOCUMENT_TEMPLATE_ID, documentVersionNumber: 0 };
    expect(jsonSchemaValueProblems(NODE_CONFIG_SCHEMAS[key], config)).not.toEqual([]);
  });
});

/**
 * TASK-893 B2 — plain-language `summary` beside the existing `description`, on every `core.*`
 * entry in `NODE_CONFIG_SCHEMAS`.
 *
 * `description` is asserted UNCHANGED (still the contract/API-docs text) everywhere `summary`
 * is asserted present, so this file cannot drift into "shortened the contract doc" by accident.
 */
describe('core.* summary copy (TASK-893 B2)', () => {
  function isPlainSchemaObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }

  /** Every summary/description-carrying string must be plain UI copy: short, sentence case,
   *  no ticket ids, no backticks, no shouted MUST/NEVER normative language. */
  function assertPlainCopy(value: string, label: string): void {
    expect(value.length, `${label} is empty`).toBeGreaterThan(0);
    expect(value.length, `${label} exceeds 80 chars: "${value}"`).toBeLessThanOrEqual(80);
    expect(value, `${label} contains a ticket id`).not.toMatch(/\b(TASK|OD|D)-\d+\b/);
    expect(value, `${label} contains a backtick`).not.toContain('`');
    expect(value, `${label} uses shouted MUST/NEVER`).not.toMatch(/\b(MUST|NEVER)\b/);
  }

  it.each(CORE_NODE_TYPES)('%s carries a top-level summary (the palette one-line purpose)', (type) => {
    const schema = NODE_CONFIG_SCHEMAS[type] as { summary?: unknown; description?: unknown };
    expect(typeof schema.summary, `${type}.summary should be a string`).toBe('string');
    assertPlainCopy(schema.summary as string, `${type}.summary`);
  });

  it.each(CORE_NODE_TYPES)('%s: every field with a description also carries a summary', (type) => {
    const missing: string[] = [];

    function walk(node: unknown, path: string): void {
      if (!isPlainSchemaObject(node)) return;
      if (typeof node.description === 'string') {
        if (typeof node.summary !== 'string' || node.summary.length === 0) {
          missing.push(path || '(root)');
        } else {
          assertPlainCopy(node.summary, `${type}${path}.summary`);
        }
      }
      if (isPlainSchemaObject(node.properties)) {
        for (const [key, sub] of Object.entries(node.properties)) walk(sub, `${path}.properties.${key}`);
      }
      if (node.items !== undefined) walk(node.items, `${path}.items`);
    }

    walk(NODE_CONFIG_SCHEMAS[type], '');
    expect(missing, `${type}: description without a paired summary at ${missing.join(', ')}`).toEqual([]);
  });

  it('the enabled toggle keeps the worked example from the ticket verbatim', () => {
    // core.agent is an arbitrary, non-graph-boundary pick — every active core.* type except
    // core.trigger/core.output folds in the same NODE_ENABLED_PROPERTY object (§ADDENDUM above).
    const properties = NODE_CONFIG_SCHEMAS['core.agent'].properties as Record<string, { summary?: string; description?: string }>;
    expect(properties.enabled.summary).toBe('Skip this node without removing it.');
    // `description` is untouched — still the full normative text, never shortened.
    expect(properties.enabled.description).toContain('TASK-890 D-1');
  });
});

/**
 * TASK-893 integration — a secondary input binding is an EDGE, never config.
 *
 * Lane B originally declared a permissive `inputs` property on ten core.* schemas so that
 * `config.inputs.<portName> = { fromNodeId }` would survive `additionalProperties: false`. That
 * config surface is now removed, because the harness interpreter never reads it:
 * `_resolve_bound_inputs` (`apps/harness/.../interpreter/workflow.py`) iterates `node.inputs` —
 * "the compiler-derived edge bindings" — and threads data purely from EDGES. A config-shaped
 * binding would have validated, rendered as bound, and delivered nothing to the run.
 *
 * The inspector's picker therefore writes a real typed edge (`fromPort` -> `toPort: <portName>`);
 * only the CANVAS treatment changed, in that the editor does not draw those edges. This test
 * pins the removal so the dead surface cannot quietly come back — re-adding it would also punch
 * a permissive `object` hole through a deliberate `additionalProperties: false`.
 */
describe('secondary inputs are edges, not config (TASK-893 integration)', () => {
  it.each(CORE_NODE_TYPES)('%s declares no `inputs` config property', (type) => {
    const properties = NODE_CONFIG_SCHEMAS[type].properties as Record<string, unknown> | undefined;
    expect(properties?.inputs).toBeUndefined();
  });

  it('and a config-shaped binding is refused, which is what keeps the lie impossible', () => {
    const config = { agentRef: { slug: 'demo-agent' }, inputs: { context: { fromNodeId: 'trigger-1' } } };
    expect(jsonSchemaValueProblems(NODE_CONFIG_SCHEMAS['core.agent'], config)).not.toEqual([]);
  });
});
