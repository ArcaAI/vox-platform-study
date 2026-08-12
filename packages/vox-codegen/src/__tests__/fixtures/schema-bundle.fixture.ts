import type { ConsultationSchemaBundle } from '../../types';

/**
 * A representative discovery bundle exercising every construct
 * `schema-to-ts.ts` supports: nested objects, arrays, enums, and a
 * discriminated `oneOf`. Also includes a non-`STRUCTURED` kind
 * (`attachment_scan`) to prove those are skipped, not mistyped.
 */
export const FIXTURE_SCHEMA_BUNDLE: ConsultationSchemaBundle = {
  schemaId: 'schema-1',
  slug: 'default',
  name: 'Default Schema',
  versionNumber: 3,
  contextSchemaVersionId: 'version-3',
  checksum: 'abc123',
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
        lifecycle: 'POST',
        producedBy: ['AGENT'],
        required: false,
        fields: {
          type: 'object',
          properties: {
            patientName: { type: 'string', minLength: 1 },
            urgency: { type: 'string', enum: ['ROUTINE', 'URGENT'] },
            referral: {
              oneOf: [
                {
                  type: 'object',
                  properties: { kind: { const: 'internal' }, department: { type: 'string' } },
                  required: ['kind', 'department'],
                },
                {
                  type: 'object',
                  properties: { kind: { const: 'external' }, providerName: { type: 'string' } },
                  required: ['kind', 'providerName'],
                },
              ],
              discriminator: { propertyName: 'kind' },
            },
          },
          required: ['patientName', 'urgency'],
        },
      },
      {
        key: 'vitals',
        label: 'Vitals',
        primitive: 'STRUCTURED',
        fields: {
          type: 'object',
          properties: {
            heartRate: { type: 'number' },
            notes: { type: 'array', items: { type: 'string' } },
          },
        },
      },
      {
        key: 'attachment_scan',
        label: 'Attachment',
        primitive: 'DOCUMENT',
      },
    ],
    outputs: [
      {
        key: 'soap_note',
        label: 'SOAP Note',
        primitive: 'STRUCTURED',
        fields: {
          type: 'object',
          properties: {
            subjective: { type: 'string' },
            objective: { type: 'string' },
            assessment: { type: 'string' },
            plan: { type: 'string' },
          },
          required: ['subjective', 'objective', 'assessment', 'plan'],
        },
      },
    ],
  },
};
