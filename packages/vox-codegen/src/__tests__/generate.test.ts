import { describe, expect, it } from 'vitest';
import { generateConsultationSchemaTypes } from '../generate';
import { UNCONFIGURED_CONSULTATION_SCHEMA_BUNDLE } from '../types';
import { FIXTURE_SCHEMA_BUNDLE } from './fixtures/schema-bundle.fixture';
import { formatDiagnostics, typeCheckSource } from './support/typecheck';

describe('generateConsultationSchemaTypes', () => {
  const FIXED_DATE = new Date('2026-08-12T00:00:00.000Z');

  it('TDD-1: generated types compile against a fixture schema', () => {
    const { contents } = generateConsultationSchemaTypes(FIXTURE_SCHEMA_BUNDLE, {
      tenantId: 'tenant-1',
      generatedAt: FIXED_DATE,
    });

    const diagnostics = typeCheckSource(contents);
    expect(diagnostics, formatDiagnostics(diagnostics)).toHaveLength(0);
  });

  it('TDD-2: a discriminated oneOf produces a real TS union, not merged properties', () => {
    const { contents } = generateConsultationSchemaTypes(FIXTURE_SCHEMA_BUNDLE, {
      tenantId: 'tenant-1',
      generatedAt: FIXED_DATE,
    });

    // The referral field must render as a UNION of the two branches, each
    // keeping its own discriminant literal — never one flattened object with
    // both `department` and `providerName` as siblings (merged soup).
    expect(contents).toMatch(/referral\??:\s*\(\{[^}]*"internal"[^}]*\}\s*\|\s*\{[^}]*"external"[^}]*\}\)/s);
    // "Merged property soup" would put `department` and `providerName`
    // directly adjacent inside ONE object literal (no `|` union boundary
    // between them). A real discriminated union never does.
    expect(contents).not.toMatch(/department:\s*string;\s*providerName/);
    expect(contents).not.toMatch(/providerName:\s*string;\s*department/);
  });

  it('names each STRUCTURED kind and output with a stable PascalCase type', () => {
    const { contents } = generateConsultationSchemaTypes(FIXTURE_SCHEMA_BUNDLE, {
      tenantId: 'tenant-1',
      generatedAt: FIXED_DATE,
    });

    expect(contents).toContain('export type ReferralLetterPayload =');
    expect(contents).toContain('export type VitalsPayload =');
    expect(contents).toContain('export type SoapNoteOutput =');
    expect(contents).toContain('referral_letter: ReferralLetterPayload;');
    expect(contents).toContain('vitals: VitalsPayload;');
    expect(contents).toContain('soap_note: SoapNoteOutput;');
  });

  it('skips a non-STRUCTURED kind (no payload type), but notes it in a comment', () => {
    const { contents } = generateConsultationSchemaTypes(FIXTURE_SCHEMA_BUNDLE, {
      tenantId: 'tenant-1',
      generatedAt: FIXED_DATE,
    });

    expect(contents).not.toMatch(/AttachmentScanPayload/);
    expect(contents).toContain('`attachment_scan` — primitive "DOCUMENT"');
    expect(contents).not.toContain('attachment_scan:');
  });

  it('handles an unconfigured tenant (null definition) without throwing, and says so', () => {
    const { contents, unconfigured } = generateConsultationSchemaTypes(UNCONFIGURED_CONSULTATION_SCHEMA_BUNDLE, {
      tenantId: 'tenant-empty',
      generatedAt: FIXED_DATE,
    });

    expect(unconfigured).toBe(true);
    expect(contents).toContain('No consultation context schema is configured for this tenant.');
    expect(contents).toContain('export type ConsultationContextKindMap = Record<string, never>;');

    const diagnostics = typeCheckSource(contents);
    expect(diagnostics, formatDiagnostics(diagnostics)).toHaveLength(0);
  });

  it('stamps the tenant id and schema version into the header comment', () => {
    const { contents } = generateConsultationSchemaTypes(FIXTURE_SCHEMA_BUNDLE, {
      tenantId: 'tenant-1',
      generatedAt: FIXED_DATE,
    });

    expect(contents).toContain('Tenant: tenant-1');
    expect(contents).toContain('Schema: default v3');
    expect(contents).toContain('DO NOT EDIT BY HAND');
  });
});
