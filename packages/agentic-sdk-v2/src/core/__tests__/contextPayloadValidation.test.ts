/**
 * Client-side context payload validation.
 *
 * Covers ONLY the orchestration semantics this module adds: an unrecognized
 * `kindKey` (or a kind with no `fields`) is treated as "nothing to validate
 * against", never a client-side rejection — the whole point of forward
 * compatibility.
 *
 * The evaluator itself is NOT retested here. It is no longer a port of the
 * server's rule but literally the same code (`@arcaai/json-schema-subset`),
 * and it owns the single test suite for that behaviour. A second copy of
 * those cases would only pretend to guard against a drift that can no longer
 * happen.
 */

import { describe, it, expect } from 'vitest';
import { validateConsultationContextPayload } from '../contextPayloadValidation';
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
