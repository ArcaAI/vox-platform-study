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

  it('carries a schema for every node type with a committed contract document (13 palette node types + 3 derivable utility/marker types)', () => {
    expect(Object.keys(NODE_CONFIG_SCHEMAS).sort()).toEqual(
      [
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

  it('leaves every consultation node type without a schema — no committed contract document exists yet', () => {
    const consultationKeys = Object.keys(WORKFLOW_NODE_REGISTRY).filter((key) => key.startsWith('consultation.'));
    expect(consultationKeys.length).toBeGreaterThan(0);
    for (const key of consultationKeys) {
      expect(WORKFLOW_NODE_REGISTRY[key].configSchema).toBeUndefined();
    }
  });

  it('every OTHER descriptor field is unaffected by the configSchema derivation', () => {
    const descriptor = WORKFLOW_NODE_REGISTRY['generate.text'];
    expect(descriptor.key).toBe('generate.text');
    expect(descriptor.paletteKey).toBe('summarization');
    expect(descriptor.classes).toEqual(['activity', 'generation', 'mandatory']);
  });
});
