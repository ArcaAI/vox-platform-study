/**
 * TASK-665 — client-side context payload validation.
 *
 * Mirrors the server's `json-schema-subset.ts` (TASK-658) test coverage for
 * the shared evaluator surface, plus the orchestration semantics this ticket
 * adds: an unrecognized `kindKey` (or a kind with no `fields`) is treated as
 * "nothing to validate against", never a client-side rejection — the whole
 * point of forward compatibility (TASK-654 D2/D4).
 */

import { describe, it, expect } from 'vitest';
import { contextPayloadProblems, validateConsultationContextPayload } from '../contextPayloadValidation';
import type { ConsultationSchemaBundle } from '../../types/consultationSchema';

function bundleWithKind(fields: Record<string, unknown>): ConsultationSchemaBundle {
  return {
    schemaId: 'schema-1',
    slug: 'default',
    name: 'Default',
    versionNumber: 3,
    contextSchemaVersionId: 'version-3',
    checksum: 'abc',
    etag: '"3"',
    definition: {
      schemaVersion: '1.0',
      kinds: [
        {
          key: 'referral_letter',
          label: 'Referral Letter',
          primitive: 'STRUCTURED',
          phiClass: 'PHI',
          cardinality: 'ONE',
          lifecycle: 'ANY',
          producedBy: ['CLIENT'],
          fields,
        },
      ],
    },
  };
}

describe('contextPayloadProblems', () => {
  it('accepts a value matching type/required/properties', () => {
    const schema = { type: 'object', required: ['severity'], properties: { severity: { type: 'string' } } };
    expect(contextPayloadProblems(schema, { severity: 'mild' })).toEqual([]);
  });

  it('reports a missing required property', () => {
    const schema = { type: 'object', required: ['severity'], properties: { severity: { type: 'string' } } };
    expect(contextPayloadProblems(schema, {})).toEqual(['/severity: required property is missing']);
  });

  it('reports a type mismatch and skips further checks on that node', () => {
    const schema = { type: 'string', minLength: 5 };
    const problems = contextPayloadProblems(schema, 42);
    expect(problems).toEqual(['/: expected string']);
  });

  it('routes a discriminated oneOf to the matching branch only', () => {
    const schema = {
      oneOf: [
        { properties: { kind: { const: 'a' }, x: { type: 'number' } }, required: ['x'] },
        { properties: { kind: { const: 'b' }, y: { type: 'string' } }, required: ['y'] },
      ],
      discriminator: { propertyName: 'kind' },
    };
    expect(contextPayloadProblems(schema, { kind: 'a', x: 1 })).toEqual([]);
    expect(contextPayloadProblems(schema, { kind: 'b', x: 1 })).toEqual(['/y: required property is missing']);
  });

  it('rejects an undeclared property when additionalProperties is false', () => {
    const schema = { type: 'object', properties: { a: { type: 'string' } }, additionalProperties: false };
    expect(contextPayloadProblems(schema, { a: 'x', b: 'y' })).toEqual(['/b: property is not declared and additionalProperties is false']);
  });

  it('accepts anything against an empty schema', () => {
    expect(contextPayloadProblems({}, { anything: 'goes' })).toEqual([]);
  });
});

describe('validateConsultationContextPayload', () => {
  it('is valid (nothing to check) when the bundle is null — TDD: unknown kind is ignored, not fatal', () => {
    expect(validateConsultationContextPayload(null, 'referral_letter', { any: 'thing' })).toEqual({ valid: true, problems: [] });
  });

  it('is valid (nothing to check) when the kindKey is not declared in the pinned definition', () => {
    const bundle = bundleWithKind({ type: 'object' });
    expect(validateConsultationContextPayload(bundle, 'not_a_declared_kind', { any: 'thing' })).toEqual({ valid: true, problems: [] });
  });

  it('is valid (nothing to check) when the resolved kind has no fields (non-STRUCTURED)', () => {
    const bundle: ConsultationSchemaBundle = {
      ...bundleWithKind({}),
      definition: {
        schemaVersion: '1.0',
        kinds: [
          {
            key: 'transcript_note',
            label: 'Transcript Note',
            primitive: 'TEXT',
            phiClass: 'PHI',
            cardinality: 'MANY',
            lifecycle: 'DURING',
            producedBy: ['SYSTEM'],
          },
        ],
      },
    };
    expect(validateConsultationContextPayload(bundle, 'transcript_note', { content: 'x' })).toEqual({ valid: true, problems: [] });
  });

  it('validates a payload against the resolved kind fields and reports problems', () => {
    const bundle = bundleWithKind({ type: 'object', required: ['severity'], properties: { severity: { type: 'string' } } });
    const result = validateConsultationContextPayload(bundle, 'referral_letter', {});
    expect(result.valid).toBe(false);
    expect(result.problems).toEqual(['/severity: required property is missing']);
  });

  it('accepts a conforming payload', () => {
    const bundle = bundleWithKind({ type: 'object', required: ['severity'], properties: { severity: { type: 'string' } } });
    const result = validateConsultationContextPayload(bundle, 'referral_letter', { severity: 'mild' });
    expect(result).toEqual({ valid: true, problems: [] });
  });
});
