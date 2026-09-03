/**
 * Closes the "per-node `configSchema` was never built" gap `registry.contract.md` recorded
 * (`node-config-schemas.ts`'s own docstring). Two things must hold:
 *
 * 1. Every schema this module ships is AUTHORABLE (`authorableJsonSchemaProblems` from
 *    `@arcaai/json-schema-subset`) — the same cross-check `registry.contract.md`'s Task 3
 *    itself named as the verification step: "the schema in the registry contract must be
 *    accepted by `authorableJsonSchemaProblems`."
 * 2. `WORKFLOW_NODE_REGISTRY` actually carries it on `configSchema`, and node types with no
 *    authored schema (documented in `node-config-schemas.ts`'s docstring) stay `undefined`
 *    rather than silently inheriting one.
 */
import { authorableJsonSchemaProblems, jsonSchemaValueProblems } from '@arcaai/json-schema-subset';
import { describe, expect, it } from 'vitest';
import { NODE_CONFIG_SCHEMAS, type NodeConfigSchema } from '../node-config-schemas';
import { WORKFLOW_NODE_REGISTRY } from '../node-registry';

describe('NODE_CONFIG_SCHEMAS', () => {
  it.each(Object.entries(NODE_CONFIG_SCHEMAS))('%s config schema is authorable', (_key, schema) => {
    expect(authorableJsonSchemaProblems(schema)).toEqual([]);
  });

  it('carries a schema for every node type in the registry except `passthrough` (D-9)', () => {
    expect(Object.keys(NODE_CONFIG_SCHEMAS).sort()).toEqual(
      [
        // the GENERIC catalogue. Every one of the eight carries a schema, because for
        // these types the schema IS the node: behaviour is configuration, not key.
        'agentic.agent',
        'agentic.data',
        'agentic.guardrail',
        'agentic.input',
        'agentic.loop',
        'agentic.output',
        'agentic.stt',
        'agentic.tts',
        // lane A — the target catalogue and the guards.
        'agent.discharge_summary',
        'agent.dna_redaction',
        'agent.feedback',
        'agent.grammar',
        'agent.important_findings',
        'agent.ner',
        'agent.normalization',
        'agent.presummarization',
        'agent.retrieval',
        'agent.summarization',
        'agent.transcription',
        'guard.groundedness',
        'guard.moderation',
        'guard.phi',
        'consultation.assemblePrompt',
        'consultation.bindTerminology',
        'consultation.captureBinding',
        'consultation.consentGate',
        'consultation.extractEntities',
        'consultation.finalizeAssurance',
        'consultation.hitlGate',
        'consultation.inferentialSensors',
        'consultation.persistDraft',
        'consultation.phiHop',
        'consultation.proposeCorrections',
        'consultation.realtimeSummary',
        'consultation.retrieveEvidence',
        'consultation.sensors',
        'consultation.suggestions',
        'consultation.synthesize',
        'core.end',
        'core.start',
        // the endpoint stage.
        'feedback.capture',
        'generate.text',
        'guardrail.check',
        'input.context_binding',
        'noop',
        'output.deliver',
        'prompt.template_ref',
        'session.timeout',
        'stt.asrEngine',
        'stt.audioInput',
        'stt.diarization',
        'stt.languageDetection',
        'stt.noiseFilter',
        'stt.phiHop',
        'stt.transcriptOutput',
        'stt.vad',
        'summary.finalize',
      ].sort(),
    );
  });
});

/**
 * the 16 `consultation.*` schemas, closing D-9 ("13 of 16 `consultation.*`
 * node types have no config schema", `node-config-schemas.ts:25-38`; the true count is 16 of 16
 * the "13" predates three additions).
 *
 * `node-types.md` named `contracts/nodes/*.schema.json` files for these and they were never
 * authored, so each schema below is derived from the two sources that DO exist and are already
 * enforced:
 *
 *   1. `DRAFT_CONSULTATION_RULE_SET` (`rule-catalogue.ts`) — every config field a published
 *      consultation graph is already REQUIRED to carry (`occ`, `producesCode`, `purposeScope`,
 *      `unmappedOutputKey`, `requiresFinalized`, and `onError` on every activity-classed node).
 *   2. The interpreter activities themselves (`apps/harness/src/harness/temporal/interpreter/
 *      nodes/consultation*.py`) — every key each activity actually reads off `payload.config`.
 *
 * A schema that omitted (1) would reject graphs the validator demands; one that omitted (2)
 * would reject config the runtime honours. Both directions are asserted here.
 */
describe('consultation.* config schemas (D-9)', () => {
  const CONSULTATION_KEYS = Object.keys(WORKFLOW_NODE_REGISTRY).filter((key) => key.startsWith('consultation.'));

  it('covers all 16 consultation node types', () => {
    expect(CONSULTATION_KEYS).toHaveLength(16);
    for (const key of CONSULTATION_KEYS) {
      expect(WORKFLOW_NODE_REGISTRY[key].configSchema).toBeDefined();
    }
  });

  it.each(CONSULTATION_KEYS)('%s is a closed object schema', (key) => {
    const schema = NODE_CONFIG_SCHEMAS[key];
    expect(schema.type).toBe('object');
    expect(schema.additionalProperties).toBe(false);
  });

  // Every field the DRAFT consultation rule set already demands must be AUTHORABLE, or the
  // schema and the validator contradict each other and no graph can satisfy both.
  it.each([
    ['consultation.persistDraft', 'occ'],
    ['consultation.synthesize', 'producesCode'],
    ['consultation.bindTerminology', 'purposeScope'],
    ['consultation.bindTerminology', 'unmappedOutputKey'],
    ['consultation.extractEntities', 'requiresFinalized'],
    ['consultation.assemblePrompt', 'requiresFinalized'],
  ])('%s permits the rule-catalogue field %s', (key, field) => {
    const properties = NODE_CONFIG_SCHEMAS[key].properties as Record<string, unknown>;
    expect(Object.hasOwn(properties, field)).toBe(true);
  });

  it('requires `onError` on exactly the activity-classed nodes WF-CONS-019 applies to', () => {
    for (const key of CONSULTATION_KEYS) {
      const descriptor = WORKFLOW_NODE_REGISTRY[key];
      const properties = NODE_CONFIG_SCHEMAS[key].properties as Record<string, { enum?: string[] } | undefined>;
      if (descriptor.classes.includes('activity')) {
        expect(properties.onError?.enum).toEqual(['degrade', 'retry', 'fail']);
        expect(NODE_CONFIG_SCHEMAS[key].required).toContain('onError');
      } else {
        // consentGate and hitlGate are not `activity`-classed, so WF-CONS-019 never fires for
        // them and demanding an error policy would be a constraint nothing enforces.
        expect(properties.onError).toBeUndefined();
      }
    }
  });

  it('offers only the three onError values the interpreter can honour — never `abort`', () => {
    // Same posture as `guardrail.check.onFail` above: a value the runtime cannot enforce must
    // be rejected at authoring time, not accepted and silently ignored.
    for (const key of CONSULTATION_KEYS) {
      const properties = NODE_CONFIG_SCHEMAS[key].properties as Record<string, { enum?: string[] } | undefined>;
      expect(properties.onError?.enum ?? []).not.toContain('abort');
    }
  });

  it.each([
    ['consultation.captureBinding', ['action', 'persistSnapshot']],
    ['consultation.extractEntities', ['language', 'persist']],
    ['consultation.bindTerminology', ['unmappedOutputKey']],
    ['consultation.phiHop', ['mode']],
    ['consultation.retrieveEvidence', ['retrievalEnabled']],
    ['consultation.assemblePrompt', ['template', 'dnaStyleId', 'conversationLanguage']],
    ['consultation.realtimeSummary', ['taskKey', 'windowChars', 'systemPrompt', 'temperature', 'maxTokens']],
    ['consultation.suggestions', ['taskKey', 'maxSuggestions', 'temperature', 'maxTokens']],
    ['consultation.proposeCorrections', ['taskKey', 'language', 'temperature', 'maxTokens']],
  ] as const)('%s permits every key its interpreter activity reads', (key, fields) => {
    const properties = NODE_CONFIG_SCHEMAS[key].properties as Record<string, unknown>;
    for (const field of fields) {
      expect(Object.hasOwn(properties, field)).toBe(true);
    }
  });

  it('consultation.synthesize accepts the generate.text knobs it delegates to', () => {
    // `interpreter_consultation_synthesize` returns `await interpreter_text_generate(payload)`
    // verbatim (consultation_compose.py:151-200), so its config surface IS generate.text's,
    // plus `producesCode`.
    const properties = NODE_CONFIG_SCHEMAS['consultation.synthesize'].properties as Record<string, unknown>;
    for (const field of ['taskKey', 'systemPrompt', 'temperature', 'maxTokens', 'topP', 'responseFormat', 'producesCode']) {
      expect(Object.hasOwn(properties, field)).toBe(true);
    }
  });

  it('consultation.consentGate accepts no config OF ITS OWN — only the palette-agnostic runtime knobs', () => {
    // The gate's activity reads no `payload.config` (`nodes/consultation.py:44`). It is not
    // `gate`-classed, though, so the compiler routes it through `compileNode`, which DOES read
    // `timeoutSeconds`/`retry` off every node — see the ADDENDUM at the foot of
    // `node-config-schemas.ts` (lane A, item 5).
    expect(Object.keys(NODE_CONFIG_SCHEMAS['consultation.consentGate'].properties as object).sort()).toEqual(['retry', 'timeoutSeconds']);
  });

  /**
   * The `mode` enum is the one place the two PHI-redaction nodes DIVERGE, and getting it wrong is
   * a patient-safety defect rather than a cosmetic one: `configSchema` drives the Studio
   * inspector, so a wrong enum offers an admin a value that DEGRADEs at runtime while hiding the
   * value that actually redacts — a redaction node that silently does not redact.
   */
  it('consultation.phiHop mode matches its ACTIVITY guard (`pseudonymize` | `full`), not stt.phiHop', () => {
    // `nodes/consultation.py:102` -> `if mode not in ("pseudonymize", "full"):`
    const consultation = NODE_CONFIG_SCHEMAS['consultation.phiHop'].properties as Record<string, { enum?: string[] }>;
    expect(consultation.mode.enum).toEqual(['pseudonymize', 'full']);
    expect(consultation.mode.enum).not.toContain('full-redact');
  });

  it('stt.phiHop keeps its OWN vocabulary — the two enums are deliberately different', () => {
    const stt = NODE_CONFIG_SCHEMAS['stt.phiHop'].properties as Record<string, { enum?: string[] }>;
    expect(stt.mode.enum).toEqual(['pseudonymize', 'full-redact']);
    const consultation = NODE_CONFIG_SCHEMAS['consultation.phiHop'].properties as Record<string, { enum?: string[] }>;
    expect(stt.mode.enum).not.toEqual(consultation.mode.enum);
  });

  /**
   * `consultation.hitlGate` is the only `gate`-classed node, so its config is consumed by the
   * TypeScript COMPILER (`compileGate`, `compiler.ts:153-166`) rather than by its activity, which
   * reads nothing. Declaring `{}` would tell the Studio the platform's only durable human wait
   * takes no configuration.
   */
  it('consultation.hitlGate declares the four fields compileGate actually reads', () => {
    const properties = NODE_CONFIG_SCHEMAS['consultation.hitlGate'].properties as Record<string, unknown>;
    expect(Object.keys(properties).sort()).toEqual(['blocking', 'gateType', 'onTimeout', 'timeoutSeconds']);
  });

  it('consultation.hitlGate is the only gate-classed node, which is why it alone carries gate config', () => {
    const gateClassed = Object.values(WORKFLOW_NODE_REGISTRY)
      .filter((descriptor) => descriptor.classes.includes('gate'))
      .map((descriptor) => descriptor.key);
    expect(gateClassed).toEqual(['consultation.hitlGate']);
  });
});

describe('guardrail.check onFail (W4 — M-1)', () => {
  // The interpreter has NO mechanism for a per-node CONFIG value to override a CODE-OWNED
  // registry property: `critical` lives on `NODE_REGISTRY` and `NodeActivityResult.status` is
  // `Literal['SUCCEEDED','DEGRADED','SKIPPED']` — there is no `FAILED` an activity can return,
  // and only the workflow body promotes a degraded CRITICAL node to a run-level failure.
  // `guardrail.check` is `critical: false`. So a tenant authoring `onFail: 'abort'` got SILENT
  // NON-ENFORCEMENT: the value validated, was recorded, and changed nothing.
  //
  // Of the two acceptable fixes — enforce it, or reject it at compile time — only the second is
  // available to the shipped v1 interpreter. Rejecting at authoring time is also the safer half:
  // a tenant who asks for "abort" and silently gets "mark" believes they have a hard gate they
  // do not have. `failOn` already set this precedent (restricted to its one v1-permitted value).
  it('does not offer `abort`, which the v1 interpreter cannot enforce', () => {
    const schema = NODE_CONFIG_SCHEMAS['guardrail.check'];
    // `NodeConfigSchema` is `Readonly<Record<string, unknown>>`, so `properties`
    // is `unknown`. Optional-chaining it narrows to `{}` rather than to a
    // record, so the member access has to be typed on the WAY IN, not on the way
    // out — casting only the result (`... as { enum?: string[] }`) still leaves
    // `.onFail` unresolvable and fails `tsc --noEmit`.
    const properties = schema.properties as Record<string, { enum?: string[] } | undefined> | undefined;
    expect(properties?.onFail?.enum).toEqual(['mark']);
  });
});

describe('WORKFLOW_NODE_REGISTRY.configSchema wiring', () => {
  it('attaches the real schema to a summarization node type', () => {
    const schema = WORKFLOW_NODE_REGISTRY['generate.text'].configSchema;
    expect(schema).toBeDefined();
    expect(schema?.required).toEqual(['taskKey']);
  });

  it('attaches the real schema to an stt node type', () => {
    const schema = WORKFLOW_NODE_REGISTRY['stt.asrEngine'].configSchema;
    expect(schema).toBeDefined();
    expect(schema?.required).toEqual(['modelSlug']);
  });

  it('leaves passthrough without a schema — it deliberately echoes arbitrary config', () => {
    expect(WORKFLOW_NODE_REGISTRY.passthrough.configSchema).toBeUndefined();
  });

  it('passthrough is now the ONLY node type without a schema (closed D-9 for the rest)', () => {
    const unschemad = Object.keys(WORKFLOW_NODE_REGISTRY).filter((key) => WORKFLOW_NODE_REGISTRY[key].configSchema === undefined);
    expect(unschemad).toEqual(['passthrough']);
  });

  it('every OTHER descriptor field is unaffected by the configSchema derivation', () => {
    const descriptor = WORKFLOW_NODE_REGISTRY['generate.text'];
    expect(descriptor.key).toBe('generate.text');
    expect(descriptor.paletteKey).toBe('summarization');
    expect(descriptor.classes).toEqual(['activity', 'generation', 'mandatory']);
  });
});

/**
 * carry-over 1 — DD-11's prompt PIN must survive a schema round-trip.
 *
 * DD-11 stores a node's prompt binding as two keys on that node's OWN config
 * (`node-prompt-binding.ts` in `@arcaai/applications`): `promptTemplateId` (WHICH template) and
 * `promptVersionNumber` (WHICH IMMUTABLE VERSION — the node's own movable pin). The pin is the
 * entire mechanism that stops an admin editing one shared template from silently changing every
 * workflow that references it.
 *
 * Every config schema here is `additionalProperties: false`, and the Studio's inspector builds
 * its form from `Object.entries(schema.properties)` alone
 * (`apps/admin-console/src/features/workflow-studio/lib/schema-form.ts:130`). So an UNDECLARED
 * binding key is stripped twice over: rejected by the value evaluator, and dropped by form
 * generation because no field is ever rendered for it. A node round-tripped through the
 * authoring UI would come back UNPINNED — silently undoing DD-11 on a published clinical
 * workflow.
 */
describe('DD-11 prompt binding survives a config-schema round-trip', () => {
  /** Node types that may legitimately carry a prompt binding. */
  const PROMPT_CARRYING_KEYS = [
    // the GENERIC agent. It is `generation`-classed, so it carries the SAME two
    // binding groups every other generation node does; that set-equality is what stops a new
    // generation node shipping without an approved, version-pinned prompt.
    'agentic.agent',
    // lane A — DD-9's three generation entries share `consultation.synthesize`'s
    // schema, so they inherit the DD-11 prompt binding with it.
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
    // Lane R (R1) — the realtime grammar pass reuses the correction engine's schema, so it
    // inherits the same bindings.
    'agent.grammar',
  ] as const;

  /** A minimal config satisfying each schema's own `required`, so the assertions below fail on
   *  the BINDING and never on an unrelated missing field. */
  const BASE_CONFIG: Record<(typeof PROMPT_CARRYING_KEYS)[number], Record<string, unknown>> = {
    'agent.presummarization': { producesCode: false, onError: 'fail' },
    'agent.summarization': { producesCode: false, onError: 'fail' },
    'agent.discharge_summary': { producesCode: false, onError: 'fail' },
    'prompt.template_ref': {},
    'generate.text': { taskKey: 'text.finalize' },
    'agentic.agent': { providerConfigRef: { taskKey: 'text.finalize' } },
    'consultation.assemblePrompt': { requiresFinalized: true, onError: 'fail' },
    'consultation.synthesize': { producesCode: false, onError: 'fail' },
    'consultation.realtimeSummary': { onError: 'degrade' },
    'consultation.suggestions': { onError: 'degrade' },
    'consultation.proposeCorrections': { onError: 'degrade' },
    'agent.grammar': { onError: 'degrade' },
  };

  const TEMPLATE_ID = '3f1a7c2e-5b84-4d19-9e63-0a2c8d5f7b41';
  const PINNED_VERSION = 4;

  /** What the Studio actually does to a config: render a field per DECLARED property, then read
   *  the form back. Anything absent from `schema.properties` has no field, so it is dropped. */
  function roundTripThroughGeneratedForm(schema: NodeConfigSchema, config: Record<string, unknown>): Record<string, unknown> {
    const declared = Object.keys((schema.properties ?? {}) as Record<string, unknown>);
    return Object.fromEntries(Object.entries(config).filter(([key]) => declared.includes(key)));
  }

  it('covers every generation-classed node type in the registry', () => {
    // Keyed off the REGISTRY, not a hand-kept list: `collectPromptBindings` deliberately reads
    // the binding off ANY node rather than a type allow-list, so a new generation node added to
    // the registry whose schema omits the binding keys is exactly the regression this catches.
    const generationKeys = Object.values(WORKFLOW_NODE_REGISTRY)
      .filter((descriptor) => descriptor.classes.includes('generation'))
      .map((descriptor) => descriptor.key)
      .sort();
    expect(generationKeys.filter((key) => !PROMPT_CARRYING_KEYS.includes(key as never))).toEqual([]);
  });

  it.each(PROMPT_CARRYING_KEYS)('%s declares both DD-11 binding keys', (key) => {
    const properties = NODE_CONFIG_SCHEMAS[key].properties as Record<string, unknown>;
    expect(Object.hasOwn(properties, 'promptTemplateId')).toBe(true);
    expect(Object.hasOwn(properties, 'promptVersionNumber')).toBe(true);
  });

  it.each(PROMPT_CARRYING_KEYS)('%s: the value evaluator accepts a config carrying a pin', (key) => {
    const config = { ...BASE_CONFIG[key], promptTemplateId: TEMPLATE_ID, promptVersionNumber: PINNED_VERSION };
    expect(jsonSchemaValueProblems(NODE_CONFIG_SCHEMAS[key], config)).toEqual([]);
  });

  it.each(PROMPT_CARRYING_KEYS)('%s: the pin survives a generated-form round-trip', (key) => {
    const config = { ...BASE_CONFIG[key], promptTemplateId: TEMPLATE_ID, promptVersionNumber: PINNED_VERSION };
    const roundTripped = roundTripThroughGeneratedForm(NODE_CONFIG_SCHEMAS[key], config);
    expect(roundTripped.promptTemplateId).toBe(TEMPLATE_ID);
    expect(roundTripped.promptVersionNumber).toBe(PINNED_VERSION);
  });

  it.each(PROMPT_CARRYING_KEYS)('%s types the pin exactly as DD-11 writes it (a positive integer)', (key) => {
    // `readBinding` accepts the pin only when `Number.isInteger(pinned) && pinned > 0`, and the
    // compiled artifact declares `versionNumber: { type: 'integer', minimum: 1 }` on the
    // normative schema AND both Python models. All three must agree, or a value authorable here
    // is unpinnable there.
    const properties = NODE_CONFIG_SCHEMAS[key].properties as Record<string, { type?: string; minimum?: number }>;
    expect(properties.promptVersionNumber.type).toBe('integer');
    expect(properties.promptVersionNumber.minimum).toBe(1);
  });

  it.each(PROMPT_CARRYING_KEYS)('%s still rejects a non-positive pin', (key) => {
    const config = { ...BASE_CONFIG[key], promptTemplateId: TEMPLATE_ID, promptVersionNumber: 0 };
    expect(jsonSchemaValueProblems(NODE_CONFIG_SCHEMAS[key], config)).not.toEqual([]);
  });
});

/**
 * a generation node's DOCUMENT-TEMPLATE binding must survive the same round-trip
 * DD-11's prompt pin does.
 *
 * DD-2 ("no runtime shape switching") states that a generation node binds ONE document shape
 * STATICALLY in its config. That binding is deliberately the SAME two-key shape DD-11 uses for
 * prompts — `documentTemplateId` (WHICH template) and `documentVersionNumber` (WHICH IMMUTABLE
 * VERSION, this node's own movable pin) — because it guards against the same failure one layer
 * over: a tenant publishing a new `DocumentTemplate` version must not silently change the
 * structure every already-published clinical workflow produces.
 *
 * The DECLARATION is load-bearing for the two reasons the prompt binding's is: every schema in
 * `node-config-schemas.ts` is `additionalProperties: false`, and the Studio inspector renders a
 * field only for a DECLARED property. An undeclared key is stripped twice over, so a node
 * round-tripped through the authoring UI comes back with no template bound — and
 * `compiledConfig.policyBindings.documentTemplateRefs` would then read as "this workflow binds
 * no shape" rather than "the binding was dropped".
 */
describe('DD-2 document-template binding survives a config-schema round-trip', () => {
  /** Node types that PRODUCE a document — i.e. exactly the registry's `generation` class. */
  const DOCUMENT_CARRYING_KEYS = [
    // the GENERIC agent. It is `generation`-classed, so it carries the SAME two
    // binding groups every other generation node does; that set-equality is what stops a new
    // generation node shipping without an approved, version-pinned prompt.
    'agentic.agent',
    'agent.presummarization',
    'agent.summarization',
    'agent.discharge_summary',
    'generate.text',
    'consultation.synthesize',
    'consultation.realtimeSummary',
    'consultation.suggestions',
    'consultation.proposeCorrections',
    // Lane R (R1) — the realtime grammar pass reuses the correction engine's schema, so it
    // inherits the same bindings.
    'agent.grammar',
  ] as const;

  /** Minimal configs satisfying each schema's own `required`, so the assertions below fail on
   *  the BINDING and never on an unrelated missing field. */
  const DOCUMENT_BASE_CONFIG: Record<(typeof DOCUMENT_CARRYING_KEYS)[number], Record<string, unknown>> = {
    'agent.presummarization': { producesCode: false, onError: 'fail' },
    'agent.summarization': { producesCode: false, onError: 'fail' },
    'agent.discharge_summary': { producesCode: false, onError: 'fail' },
    'generate.text': { taskKey: 'text.finalize' },
    'agentic.agent': { providerConfigRef: { taskKey: 'text.finalize' } },
    'consultation.synthesize': { producesCode: false, onError: 'fail' },
    'consultation.realtimeSummary': { onError: 'degrade' },
    'consultation.suggestions': { onError: 'degrade' },
    'consultation.proposeCorrections': { onError: 'degrade' },
    'agent.grammar': { onError: 'degrade' },
  };

  const DOCUMENT_TEMPLATE_ID = 'a41b6d0c-2f38-4c77-9a51-6d2e7b0c4f93';
  const DOCUMENT_PINNED_VERSION = 2;

  function roundTripThroughGeneratedForm(schema: NodeConfigSchema, config: Record<string, unknown>): Record<string, unknown> {
    const declared = Object.keys((schema.properties ?? {}) as Record<string, unknown>);
    return Object.fromEntries(Object.entries(config).filter(([key]) => declared.includes(key)));
  }

  it('covers exactly the generation-classed node types in the registry', () => {
    // Keyed off the REGISTRY, not a hand-kept list, for the same reason the DD-11 block above is:
    // the next generation node someone registers must not be able to ship WITHOUT a document
    // binding and have nothing say so.
    const generationKeys = Object.values(WORKFLOW_NODE_REGISTRY)
      .filter((descriptor) => descriptor.classes.includes('generation'))
      .map((descriptor) => descriptor.key)
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
