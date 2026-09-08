/**
 * TASK-930 §8.2 — the ONE trigger context schema, `consultation_note_context`.
 *
 * Hermetic. The definition is pure data; the checksum and the derived payload schema are
 * compared against the REAL canonicalisers in `@arcaai/applications` (imported from source, the
 * `task-798` pattern) so the seed's copies cannot drift; the seed function runs against a fake
 * client to prove CREATE-ONLY.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  NOTE_CONTEXT_KIND_KEY,
  NOTE_CONTEXT_FIELD_NAMES,
  NOTE_CONTEXT_SCHEMA_DEFINITION,
  NOTE_CONTEXT_SCHEMA_SLUG,
  NOTE_CONTEXT_SCHEMAS,
  NOTE_CONTEXT_SCHEMA_VERSIONS,
  definitionChecksum,
  payloadSchemaFromDefinition,
  seedConsultationNoteContextSchema,
} from '../07e-consultation-note-context-schema';
import { SEED_TENANT_ID, SYSTEM_TENANT_ID } from '../00-constants';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFINITION_MODULE = path.resolve(HERE, '../../../../../../applications/src/services/consultation-context-schema/context-schema-definition.ts');
/* eslint-disable @typescript-eslint/no-explicit-any */
const definitionModule: any = await import(/* @vite-ignore */ DEFINITION_MODULE);

const kindsOf = (definition: Record<string, unknown>) => (definition.kinds as Array<Record<string, unknown>>).map((kind) => kind.key);
const contextKind = () => (NOTE_CONTEXT_SCHEMA_DEFINITION.kinds as Array<Record<string, any>>).find((kind) => kind.key === NOTE_CONTEXT_KIND_KEY)!;

describe('TASK-930 §8.2 — consultation_note_context', () => {
  it('is authored for Global and SYSTEM (ArcaAI receives it through phase 26), as the tenant DEFAULT, PUBLISHED and pinned at v1', () => {
    expect(NOTE_CONTEXT_SCHEMA_SLUG).toBe('consultation_note_context');
    expect(NOTE_CONTEXT_SCHEMAS.map((row) => row.tenantId).sort()).toEqual([SYSTEM_TENANT_ID, SEED_TENANT_ID].sort());
    for (const row of NOTE_CONTEXT_SCHEMAS) {
      expect(row).toMatchObject({ slug: NOTE_CONTEXT_SCHEMA_SLUG, scope: 'TENANT', status: 'PUBLISHED', pinnedVersionNumber: 1, isDefault: true, departmentId: null });
    }
    expect(new Set(NOTE_CONTEXT_SCHEMAS.map((row) => row.id)).size).toBe(NOTE_CONTEXT_SCHEMAS.length);
    expect(NOTE_CONTEXT_SCHEMA_VERSIONS.map((version) => version.schemaId).sort()).toEqual(NOTE_CONTEXT_SCHEMAS.map((row) => row.id).sort());
  });

  it('declares the prompt fields the clinical templates bind under ONE structured `context` kind, plus the four day-1 item kinds', () => {
    expect(kindsOf(NOTE_CONTEXT_SCHEMA_DEFINITION)).toEqual(['audio_stream', 'work_note', 'case_note', 'attachment', NOTE_CONTEXT_KIND_KEY]);
    const properties = contextKind().fields.properties as Record<string, Record<string, unknown>>;
    for (const name of ['visit_type', 'current_department', 'language', 'safe_age', 'safe_dob', 'safe_gender', 'formatted_previous_visits', 'formatted_vitals', 'chief_complaint']) {
      expect(properties[name], name).toBeDefined();
      expect(NOTE_CONTEXT_FIELD_NAMES).toContain(name);
    }
    expect(properties.visit_type).toMatchObject({ type: 'string', enum: ['new-visit', 'revisit'] });
    expect(contextKind().fields.required).not.toContain('chief_complaint');
    // The legacy v1 vocabulary (the retired `consultation_legacy_v1` bridge) is folded in, so the
    // prompt-assembly path keeps a declared name for every variable it populates.
    for (const legacy of ['ner_entities', 'clinician_notes', 'pre_summary_text', 'dna_style_text', 'style_DNA_doctor_department_medicine']) {
      expect(properties[legacy], legacy).toBeDefined();
    }
    // OPEN fields — the values are produced by code, so a closed schema would gate the thing it supports.
    expect(contextKind().fields.additionalProperties).toBeUndefined();
  });

  it('is a valid definition by the REAL application validator, and the seeded checksum / payload schema equal the real derivations', () => {
    expect(definitionModule.contextSchemaDefinitionProblems(NOTE_CONTEXT_SCHEMA_DEFINITION)).toEqual([]);
    expect(definitionChecksum(NOTE_CONTEXT_SCHEMA_DEFINITION)).toBe(definitionModule.computeDefinitionChecksum(NOTE_CONTEXT_SCHEMA_DEFINITION));
    for (const version of NOTE_CONTEXT_SCHEMA_VERSIONS) expect(version.checksum).toBe(definitionModule.computeDefinitionChecksum(NOTE_CONTEXT_SCHEMA_DEFINITION));
    expect(payloadSchemaFromDefinition(NOTE_CONTEXT_SCHEMA_DEFINITION)).toEqual(definitionModule.payloadSchemaFromDefinition(NOTE_CONTEXT_SCHEMA_DEFINITION));
    // `trigger.context.visit_type` — the path every §8.4 / §8.5 graph reads — resolves in the payload.
    const payload = payloadSchemaFromDefinition(NOTE_CONTEXT_SCHEMA_DEFINITION) as any;
    expect(payload.properties[NOTE_CONTEXT_KIND_KEY].properties.visit_type.enum).toEqual(['new-visit', 'revisit']);
  });

  it('seeds CREATE-ONLY: a second run writes nothing, and a tenant that already owns a default keeps it', async () => {
    const schemas: Array<Record<string, unknown>> = [];
    const versions: Array<Record<string, unknown>> = [];
    const client = {
      consultationContextSchema: {
        findFirst: async ({ where }: any) =>
          schemas.find((row) => row.tenantId === where.tenantId && (row.id === where.OR[0].id || (row.scope === 'TENANT' && row.isDefault === true))) ?? null,
        create: async ({ data }: any) => {
          schemas.push(data);
          return data;
        },
      },
      consultationContextSchemaVersion: {
        create: async ({ data }: any) => {
          versions.push(data);
          return data;
        },
      },
    };
    await seedConsultationNoteContextSchema(client as never);
    expect(schemas).toHaveLength(2);
    expect(versions).toHaveLength(2);
    await seedConsultationNoteContextSchema(client as never);
    expect(schemas).toHaveLength(2);
    expect(versions).toHaveLength(2);
  });
});
