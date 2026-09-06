/**
 * J3-5 — the single-kind `context` envelope, unwrapped on the AGENT path.
 *
 * `payloadSchemaFromDefinition` keys a declaration's payload under each KIND. That is right for a
 * schema declaring several kinds: `{ audio: …, patient: … }` is genuinely an envelope and a
 * caller has to say which kind a value belongs to.
 *
 * It produces a shape nobody can use for the SEEDED combination, which is one kind whose key is
 * `context`: the envelope becomes `{ context: { safe_age, … } }`, the seeded templates read
 * `{{context.safe_age}}`, and `buildAgentPromptScope` aliases `scope.context` to the WHOLE
 * envelope — so the reference resolves to nothing and the only way to write it would be
 * `{{context.context.safe_age}}`. Every seeded platform prompt is therefore un-runnable on an
 * agent bound to the bridge schema, which is the pairing the seed itself ships.
 *
 * The rule is deliberately narrow (owner decision): EXACTLY ONE kind, and its key is the
 * namespace root `context`. Then the kind IS the context, the envelope adds nothing, and the
 * agent path unwraps. A multi-kind envelope stays verbatim — the wave-2b decision — because
 * there the envelope carries the only information saying which kind a value is.
 */
import { describe, expect, it } from 'vitest';

import {
  CONTEXT_NAMESPACE_ROOT,
  payloadSchemaFromDefinition,
  soleContextKindSchema,
  unwrapSingleKindContextPayload,
} from '../context-schema-definition';

/** The bridge schema's shape, trimmed to two fields (seed `07g-consultation-legacy-context-schema.ts`). */
const LEGACY_DEFINITION = {
  schemaVersion: '1.0',
  kinds: [
    {
      key: 'context',
      label: 'Legacy Prompt Context',
      primitive: 'STRUCTURED',
      fields: { type: 'object', properties: { safe_age: { type: 'string' }, visit_type: { type: 'string' } } },
    },
  ],
};

const MULTI_KIND_DEFINITION = {
  schemaVersion: '1.0',
  kinds: [
    { key: 'context', primitive: 'STRUCTURED', fields: { type: 'object', properties: { safe_age: { type: 'string' } } } },
    { key: 'audio', primitive: 'STREAM_AUDIO' },
  ],
};

describe('soleContextKindSchema — when the envelope adds nothing', () => {
  it('returns the kind`s own schema for one kind keyed `context`', () => {
    const payloadSchema = payloadSchemaFromDefinition(LEGACY_DEFINITION);
    expect(soleContextKindSchema(payloadSchema)).toEqual(LEGACY_DEFINITION.kinds[0].fields);
  });

  it('returns null for a multi-kind envelope — there the key carries information', () => {
    expect(soleContextKindSchema(payloadSchemaFromDefinition(MULTI_KIND_DEFINITION))).toBeNull();
  });

  it('returns null for one kind keyed anything else — the rule is about the NAMESPACE ROOT', () => {
    const single = { schemaVersion: '1.0', kinds: [{ key: 'patient', primitive: 'STRUCTURED', fields: { type: 'object' } }] };
    expect(soleContextKindSchema(payloadSchemaFromDefinition(single))).toBeNull();
  });

  it('returns null for a schema that declares nothing at all', () => {
    expect(soleContextKindSchema(payloadSchemaFromDefinition({ schemaVersion: '1.0', kinds: [] }))).toBeNull();
  });

  it('names the root it keys off, so the two languages cannot drift on the spelling', () => {
    expect(CONTEXT_NAMESPACE_ROOT).toBe('context');
  });
});

describe('unwrapSingleKindContextPayload — one payload shape reaches the prompt', () => {
  const payloadSchema = payloadSchemaFromDefinition(LEGACY_DEFINITION);

  it('accepts the FLAT form (what an invocation caller sends) unchanged', () => {
    expect(unwrapSingleKindContextPayload(payloadSchema, { safe_age: '41', visit_type: 'follow-up' })).toEqual({
      safe_age: '41',
      visit_type: 'follow-up',
    });
  });

  it('unwraps the ENVELOPE form (what a workflow trigger validates as) to the kind`s object', () => {
    expect(unwrapSingleKindContextPayload(payloadSchema, { context: { safe_age: '41' } })).toEqual({ safe_age: '41' });
  });

  it('leaves a multi-kind envelope verbatim — the wave-2b decision stands', () => {
    const multi = payloadSchemaFromDefinition(MULTI_KIND_DEFINITION);
    const payload = { context: { safe_age: '41' }, audio: { uri: 's3://x' } };
    expect(unwrapSingleKindContextPayload(multi, payload)).toBe(payload);
  });

  it('leaves a non-object payload alone rather than inventing a shape', () => {
    expect(unwrapSingleKindContextPayload(payloadSchema, null)).toBeNull();
    expect(unwrapSingleKindContextPayload(payloadSchema, 'not an object')).toBe('not an object');
  });

  it('does not unwrap a flat payload that merely HAS a `context` field alongside others', () => {
    const payload = { context: 'a value', safe_age: '41' };
    expect(unwrapSingleKindContextPayload(payloadSchema, payload)).toBe(payload);
  });
});
