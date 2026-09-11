/**
 * TASK-951 lane F — the `@role`, `@materializeAs` and `@streamContext` JSDoc
 * annotations `generate.ts` emits beside the existing `@identity` one
 * (TASK-950).
 *
 * Mirrors `generate.user-identity.task950.test.ts`'s fixture shape: minimal
 * bundles built inline rather than the shared `FIXTURE_SCHEMA_BUNDLE`, since
 * these markers are this ticket's concern alone.
 */

import { describe, expect, it } from 'vitest';
import { generateConsultationSchemaTypes } from '../generate';
import type { ConsultationSchemaBundle, ContextKindDeclaration } from '../types';
import { FIXTURE_SCHEMA_BUNDLE } from './fixtures/schema-bundle.fixture';
import { formatDiagnostics, typeCheckSource } from './support/typecheck';

const GENERATED_AT = new Date('2026-09-11T00:00:00.000Z');

/** A `STRUCTURED`, `cardinality: 'ONE'` kind whose properties every field-level role can name. */
const ENCOUNTER_KIND: ContextKindDeclaration = {
  key: 'encounter',
  label: 'Encounter',
  primitive: 'STRUCTURED',
  cardinality: 'ONE',
  fields: {
    type: 'object',
    properties: {
      doctor_id: { type: 'string' },
      department_code: { type: 'string' },
      visit_type: { type: 'string' },
      event_id: { type: 'string' },
    },
    required: ['doctor_id', 'department_code', 'visit_type', 'event_id'],
  },
};

/** A `STRUCTURED` kind shaped for the type-level `materializeAs`/`streamContext` markers. */
const NOTES_KIND: ContextKindDeclaration = {
  key: 'previous_case_notes',
  label: 'Previous Case Notes',
  primitive: 'STRUCTURED',
  cardinality: 'ONE',
  fields: {
    type: 'object',
    properties: { notes: { type: 'array', items: { type: 'object', properties: { text: { type: 'string' } } } } },
    required: ['notes'],
  },
};

function bundleWith(...kinds: ContextKindDeclaration[]): ConsultationSchemaBundle {
  return {
    schemaId: 'schema-1',
    slug: 'default',
    name: 'Default Schema',
    versionNumber: 1,
    contextSchemaVersionId: 'version-1',
    checksum: 'abc123',
    etag: '"1"',
    definition: { schemaVersion: '1.0', kinds },
  };
}

function generate(...kinds: ContextKindDeclaration[]) {
  return generateConsultationSchemaTypes(bundleWith(...kinds), { tenantId: 'tenant-1', generatedAt: GENERATED_AT });
}

describe('generateConsultationSchemaTypes — @role annotations (TASK-951)', () => {
  it('emits @role department (by code), @role visitType and @role externalRef on their own marked properties, and @identity still works alongside them', () => {
    const kind: ContextKindDeclaration = {
      ...ENCOUNTER_KIND,
      userIdentity: { field: 'doctor_id' },
      department: { field: 'department_code', by: 'code' },
      visitType: { field: 'visit_type' },
      externalRef: { field: 'event_id' },
    };

    const { contents } = generate(kind);

    expect(contents).toMatch(/\/\*\* @identity[^*]*\*\/ doctor_id: string;/);
    expect(contents).toMatch(/\/\*\* @role department \(by code\)[^*]*\*\/ department_code: string;/);
    expect(contents).toMatch(/\/\*\* @role visitType[^*]*\*\/ visit_type: string;/);
    expect(contents).toMatch(/\/\*\* @role externalRef[^*]*\*\/ event_id: string;/);
    expect(contents).toContain('TASK-951');

    const diagnostics = typeCheckSource(contents);
    expect(diagnostics, formatDiagnostics(diagnostics)).toHaveLength(0);
  });

  it('emits @role department (by name) when the marker says `by: \'name\'`', () => {
    const kind: ContextKindDeclaration = { ...ENCOUNTER_KIND, department: { field: 'department_code', by: 'name' } };

    const { contents } = generate(kind);

    expect(contents).toMatch(/\/\*\* @role department \(by name\)[^*]*\*\/ department_code: string;/);
  });

  it('a role marker naming a property absent from `fields` adds no tag and does not throw', () => {
    const unmarked = generate(ENCOUNTER_KIND);

    let dangling!: ReturnType<typeof generate>;
    expect(() => {
      dangling = generate({ ...ENCOUNTER_KIND, department: { field: 'does_not_exist', by: 'code' }, visitType: { field: 'also_missing' } });
    }).not.toThrow();

    expect(dangling.contents).not.toContain('@role');
    expect(dangling.contents).toBe(unmarked.contents);
  });
});

describe('generateConsultationSchemaTypes — @materializeAs / @streamContext (type-level, TASK-951)', () => {
  it('emits a type-level @materializeAs CASE_NOTE tag directly above the kind\'s `export type`', () => {
    const { contents } = generate({ ...NOTES_KIND, materializeAs: 'CASE_NOTE' });

    expect(contents).toMatch(/@materializeAs CASE_NOTE[^\n]*\n \*\/\nexport type PreviousCaseNotesPayload =/);
    expect(contents).toContain('TASK-951');

    const diagnostics = typeCheckSource(contents);
    expect(diagnostics, formatDiagnostics(diagnostics)).toHaveLength(0);
  });

  it('emits a type-level @streamContext tag for a stream-identity kind', () => {
    const streamKind: ContextKindDeclaration = {
      key: 'stream',
      label: 'Stream Metadata',
      primitive: 'STRUCTURED',
      cardinality: 'ONE',
      fields: { type: 'object', properties: { mic_id: { type: 'string' } }, required: ['mic_id'] },
      streamContext: true,
    };

    const { contents } = generate(streamKind);

    expect(contents).toMatch(/@streamContext[^\n]*\n \*\/\nexport type StreamPayload =/);

    const diagnostics = typeCheckSource(contents);
    expect(diagnostics, formatDiagnostics(diagnostics)).toHaveLength(0);
  });

  it('emits both type-level tags together when a kind declares both markers', () => {
    const { contents } = generate({ ...NOTES_KIND, materializeAs: 'CASE_NOTE', streamContext: true });

    expect(contents).toContain('@materializeAs CASE_NOTE');
    expect(contents).toContain('@streamContext');
  });

  it('produces byte-identical output to an equivalent run when no kind declares any of the five markers', () => {
    const first = generate(ENCOUNTER_KIND, NOTES_KIND);
    const second = generate({ ...ENCOUNTER_KIND }, { ...NOTES_KIND });

    expect(first.contents).toBe(second.contents);
    expect(first.contents).not.toMatch(/@role|@materializeAs|@streamContext/);
  });

  it("leaves the shared fixture (no kind marked) byte-identical to today's expectation", () => {
    // FIXTURE_SCHEMA_BUNDLE (generate.test.ts's own fixture) declares none of
    // the five markers — the annotation machinery must be a no-op on it,
    // exactly as it was before this ticket.
    const withAnnotationsWired = generateConsultationSchemaTypes(FIXTURE_SCHEMA_BUNDLE, { tenantId: 'tenant-1', generatedAt: GENERATED_AT });
    const reference = generateConsultationSchemaTypes(FIXTURE_SCHEMA_BUNDLE, { tenantId: 'tenant-1', generatedAt: GENERATED_AT });

    expect(withAnnotationsWired.contents).toBe(reference.contents);
    expect(withAnnotationsWired.contents).not.toMatch(/@role|@materializeAs|@streamContext/);
  });

  it('a materializeAs/streamContext marker on an OUTPUT entry (which never carries one) is simply absent, never thrown on', () => {
    const bundle: ConsultationSchemaBundle = {
      schemaId: 'schema-1',
      slug: 'default',
      name: 'Default Schema',
      versionNumber: 1,
      contextSchemaVersionId: 'version-1',
      checksum: 'abc123',
      etag: '"1"',
      definition: {
        schemaVersion: '1.0',
        kinds: [],
        outputs: [{ key: 'case_note', primitive: 'STRUCTURED', fields: { type: 'object', properties: { text: { type: 'string' } } } }],
      },
    };

    expect(() => generateConsultationSchemaTypes(bundle, { tenantId: 'tenant-1', generatedAt: GENERATED_AT })).not.toThrow();
    const { contents } = generateConsultationSchemaTypes(bundle, { tenantId: 'tenant-1', generatedAt: GENERATED_AT });
    expect(contents).not.toMatch(/@role|@materializeAs|@streamContext/);
  });
});
