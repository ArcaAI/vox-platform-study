/**
 * `generateConsultationSchemaTypes` — `OpenConsultationContext` and the `@schemaVersion` header
 * tag.
 *
 * `OpenConsultationContext` is the typed shape a caller passes to `open<TContext>()` instead of
 * an untyped `Record<string, unknown>` — only the STRUCTURED, `lifecycle: 'PRE'` kinds a CLIENT
 * may supply qualify; anything AI/SYSTEM-produced, POST-lifecycle, or non-STRUCTURED is never
 * something a client sends at open.
 */

import { describe, expect, it } from 'vitest';
import { generateConsultationSchemaTypes } from '../generate';
import type { ConsultationSchemaBundle, ContextKindDeclaration } from '../types';
import { formatDiagnostics, typeCheckSource } from './support/typecheck';

const GENERATED_AT = new Date('2026-09-17T00:00:00.000Z');

const VITALS_KIND: ContextKindDeclaration = {
  key: 'vitals',
  label: 'Vitals',
  primitive: 'STRUCTURED',
  cardinality: 'ONE',
  lifecycle: 'PRE',
  producedBy: ['CLIENT'],
  required: false,
  fields: {
    type: 'object',
    properties: { systolic: { type: 'number' }, diastolic: { type: 'number' } },
  },
};

const REFERRAL_KIND: ContextKindDeclaration = {
  key: 'referral',
  label: 'Referral',
  primitive: 'STRUCTURED',
  cardinality: 'ONE',
  lifecycle: 'PRE',
  producedBy: ['CLIENT'],
  required: true,
  fields: {
    type: 'object',
    properties: { department: { type: 'string' } },
    required: ['department'],
  },
};

const AGENT_PRODUCED_KIND: ContextKindDeclaration = {
  key: 'summary_note',
  label: 'Summary Note',
  primitive: 'STRUCTURED',
  cardinality: 'ONE',
  lifecycle: 'POST',
  producedBy: ['AGENT'],
  fields: { type: 'object', properties: { text: { type: 'string' } } },
};

const NON_STRUCTURED_KIND: ContextKindDeclaration = {
  key: 'attachment',
  label: 'Attachment',
  primitive: 'DOCUMENT',
  lifecycle: 'PRE',
  producedBy: ['CLIENT'],
};

function bundleWith(kinds: ContextKindDeclaration[], versionNumber: number | null = 3): ConsultationSchemaBundle {
  return {
    schemaId: 'schema-1',
    slug: 'default',
    name: 'Default Schema',
    versionNumber,
    contextSchemaVersionId: 'version-3',
    checksum: 'abc123',
    etag: '"3"',
    definition: versionNumber === null ? null : { schemaVersion: '1.0', kinds },
  };
}

function generate(kinds: ContextKindDeclaration[], versionNumber: number | null = 3) {
  return generateConsultationSchemaTypes(bundleWith(kinds, versionNumber), { tenantId: 'tenant-1', generatedAt: GENERATED_AT });
}

describe('OpenConsultationContext', () => {
  it('includes an optional property per STRUCTURED/PRE/CLIENT kind', () => {
    const { contents } = generate([VITALS_KIND]);

    expect(contents).toMatch(/export type OpenConsultationContext = \{\n\s*vitals\?: VitalsPayload;\n\};/);
    const diagnostics = typeCheckSource(contents);
    expect(diagnostics, formatDiagnostics(diagnostics)).toHaveLength(0);
  });

  it('drops the `?` when the kind is required: true', () => {
    const { contents } = generate([REFERRAL_KIND]);

    expect(contents).toMatch(/export type OpenConsultationContext = \{\n\s*referral: ReferralPayload;\n\};/);
  });

  it('excludes an AGENT/POST-produced kind', () => {
    const { contents } = generate([AGENT_PRODUCED_KIND]);

    const openContextSection = contents.slice(contents.indexOf('export type OpenConsultationContext'));
    expect(openContextSection).not.toContain('summary_note');
  });

  it('excludes a non-STRUCTURED kind even when PRE + CLIENT', () => {
    const { contents } = generate([NON_STRUCTURED_KIND]);

    const openContextSection = contents.slice(contents.indexOf('export type OpenConsultationContext'));
    expect(openContextSection).not.toContain('attachment');
  });

  it('emits an empty object type when no kind qualifies', () => {
    const { contents } = generate([AGENT_PRODUCED_KIND]);

    expect(contents).toContain('export type OpenConsultationContext = {};');
  });

  it('emits an empty object type for an unconfigured tenant', () => {
    const { contents } = generate([], null);

    expect(contents).toContain('export type OpenConsultationContext = {};');
  });

  it('combines multiple qualifying kinds into one type', () => {
    const { contents } = generate([VITALS_KIND, REFERRAL_KIND]);

    expect(contents).toContain('vitals?: VitalsPayload;');
    expect(contents).toContain('referral: ReferralPayload;');
    const diagnostics = typeCheckSource(contents);
    expect(diagnostics, formatDiagnostics(diagnostics)).toHaveLength(0);
  });
});

describe('@schemaVersion header tag', () => {
  it('emits @schemaVersion <n> when the tenant has a configured version', () => {
    const { contents } = generate([VITALS_KIND], 3);

    expect(contents).toContain('@schemaVersion 3');
  });

  it('omits @schemaVersion for an unconfigured tenant', () => {
    const { contents } = generate([], null);

    expect(contents).not.toContain('@schemaVersion');
  });
});
