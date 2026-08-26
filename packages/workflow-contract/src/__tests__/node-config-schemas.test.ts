/**
 * Closes the "per-node `configSchema` was never built" gap `registry.contract.md` recorded
 * (TASK-719 Task 3 / `node-config-schemas.ts`'s own docstring). Two things must hold:
 *
 * 1. Every schema this module ships is AUTHORABLE (`authorableJsonSchemaProblems` from
 *    `@arcaai/json-schema-subset`) — the same cross-check `registry.contract.md`'s Task 3
 *    itself named as the verification step: "the schema in the registry contract must be
 *    accepted by `authorableJsonSchemaProblems`."
 * 2. `WORKFLOW_NODE_REGISTRY` actually carries it on `configSchema`, and node types with no
 *    authored schema (documented in `node-config-schemas.ts`'s docstring) stay `undefined`
 *    rather than silently inheriting one.
 */
import { authorableJsonSchemaProblems } from '@arcaai/json-schema-subset';
import { describe, expect, it } from 'vitest';
import { NODE_CONFIG_SCHEMAS } from '../node-config-schemas';
import { WORKFLOW_NODE_REGISTRY } from '../node-registry';

describe('NODE_CONFIG_SCHEMAS', () => {
  it.each(Object.entries(NODE_CONFIG_SCHEMAS))('%s config schema is authorable', (_key, schema) => {
    expect(authorableJsonSchemaProblems(schema)).toEqual([]);
  });

  it('carries a schema for every node type in the registry except `passthrough` (TASK-809 D-9)', () => {
    expect(Object.keys(NODE_CONFIG_SCHEMAS).sort()).toEqual(
      [
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
        'generate.text',
        'guardrail.check',
        'input.context_binding',
        'noop',
        'output.deliver',
        'prompt.template_ref',
        'stt.asrEngine',
        'stt.audioInput',
        'stt.diarization',
        'stt.languageDetection',
        'stt.noiseFilter',
        'stt.phiHop',
        'stt.transcriptOutput',
        'stt.vad',
      ].sort(),
    );
  });
});

/**
 * TASK-809 Task 9 — the 16 `consultation.*` schemas, closing D-9 ("13 of 16 `consultation.*`
 * node types have no config schema", `node-config-schemas.ts:25-38`; the true count is 16 of 16
 * — the "13" predates TASK-791's three additions).
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

  it('consultation.consentGate accepts no config at all', () => {
    expect(NODE_CONFIG_SCHEMAS['consultation.consentGate'].properties).toEqual({});
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

describe('guardrail.check onFail (TASK-791 W4 — M-1)', () => {
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

  it('passthrough is now the ONLY node type without a schema (TASK-809 closed D-9 for the rest)', () => {
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
