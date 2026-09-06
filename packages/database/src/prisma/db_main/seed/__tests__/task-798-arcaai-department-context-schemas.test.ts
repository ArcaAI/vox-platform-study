/**
 * two departments, two observable behaviours.
 *
 * The requirement is that the department (and the clinician's writing style) visibly change the
 * output. Three of the four axes that decide this were already seeded — per-department
 * `PromptTemplate`/`PromptVersion` (approved v3), per-doctor `DnaWritingStyleReport`, and a
 * `DepartmentAgent` binding them. The missing axis was the CONTEXT VOCABULARY: exactly one
 * TENANT-scoped `ConsultationContextSchema` existed per tenant, so every ArcaAI department shared
 * one vocabulary and "the department changes the note" was an assertion with no data behind it.
 *
 * These two DEPARTMENT-scoped schemas are that data: General Medicine anchors on vitals and a
 * problem list, Rheumatology on joint counts, inflammatory markers and a disease-activity output.
 *
 * The load-bearing test here is the last group: the definitions are checked by the REAL
 * `contextSchemaDefinitionProblems()` from `@arcaai/applications`, not by a local re-reading of
 * what the format looked like. A seeded definition that the service would reject on publish is a
 * row no tenant admin could ever have authored. (That check earned its place immediately: the
 * design note this seed was built from specified `fields` as a flat `name -> type` map, and the
 * real validator treats it as an authorable JSON Schema. The document was wrong; the validator
 * said so.)
 *
 * PREREQUISITE: that validator imports `@arcaai/json-schema-subset`, which must be BUILT —
 * `packages/database` does not depend on it, so nothing builds it implicitly. The check below
 * turns the otherwise-cryptic resolver error into an instruction.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  ARCAAI_DEPARTMENT_CONTEXT_SCHEMA_VERSIONS,
  ARCAAI_DEPARTMENT_CONTEXT_SCHEMAS,
  seedArcaaiDepartmentContextSchemas,
} from '../07f-arcaai-department-context-schemas';
import { definitionChecksum } from '../07e-consultation-loop-defaults';
import { SEED_CUSTOMER_TENANT_IDS, SEED_DEPARTMENT_IDS } from '../00-constants';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFINITION_MODULE = path.resolve(HERE, '../../../../../../applications/src/services/consultation-context-schema/context-schema-definition.ts');

const JSON_SCHEMA_SUBSET_DIST = path.resolve(HERE, '../../../../../../json-schema-subset/dist/index.mjs');
if (!existsSync(JSON_SCHEMA_SUBSET_DIST)) {
  throw new Error(
    `cannot validate the seeded context-schema definitions — @arcaai/json-schema-subset is not built.\n` +
      `Run: pnpm --filter @arcaai/json-schema-subset build\n` +
      `(expected at ${JSON_SCHEMA_SUBSET_DIST})`,
  );
}

/* eslint-disable @typescript-eslint/no-explicit-any */
const definitionContract: any = await import(/* @vite-ignore */ DEFINITION_MODULE);
const { computeDefinitionChecksum, contextSchemaDefinitionProblems } = definitionContract;

const schemaFor = (departmentId: string) => {
  const row = ARCAAI_DEPARTMENT_CONTEXT_SCHEMAS.find((s) => s.departmentId === departmentId);
  if (!row) throw new Error(`no seeded schema for department ${departmentId}`);
  return row;
};
const versionFor = (schemaId: string) => {
  const row = ARCAAI_DEPARTMENT_CONTEXT_SCHEMA_VERSIONS.find((v) => v.schemaId === schemaId);
  if (!row) throw new Error(`no seeded version for schema ${schemaId}`);
  return row;
};
const kindKeys = (departmentId: string) => ((schemaFor(departmentId).definition as { kinds: { key: string }[] }).kinds ?? []).map((k) => k.key);
const outputKeys = (departmentId: string) =>
  ((schemaFor(departmentId).definition as { outputs?: { key: string }[] }).outputs ?? []).map((o) => o.key);

describe(' W3 — department-scoped consultation context schemas', () => {
  it('seeds one DEPARTMENT-scoped schema for each of the two ArcaAI departments', () => {
    expect(ARCAAI_DEPARTMENT_CONTEXT_SCHEMAS).toHaveLength(2);
    for (const row of ARCAAI_DEPARTMENT_CONTEXT_SCHEMAS) {
      expect(row.tenantId).toBe(SEED_CUSTOMER_TENANT_IDS.ARCAAI);
      expect(row.scope).toBe('DEPARTMENT');
      expect(row.status).toBe('PUBLISHED');
      expect(row.pinnedVersionNumber).toBe(1);
      // DEPARTMENT scope wins over the tenant default in discovery. `isDefault` is scoped to
      // (tenant, scope, departmentId), so this does NOT collide with the seeded tenant default.
      expect(row.isDefault).toBe(true);
      expect(row.templateLocked).toBe(false);
    }
    expect(ARCAAI_DEPARTMENT_CONTEXT_SCHEMAS.map((r) => r.departmentId).sort()).toEqual(
      [SEED_DEPARTMENT_IDS.GEN_ARCAAI, SEED_DEPARTMENT_IDS.RHEUM_ARCAAI].sort(),
    );
  });

  it('gives each department a distinct slug (the model is unique per (tenantId, slug))', () => {
    const slugs = ARCAAI_DEPARTMENT_CONTEXT_SCHEMAS.map((r) => r.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    // …and neither may collide with the seeded tenant-wide default.
    expect(slugs).not.toContain('consultation_default');
  });

  it('gives the two departments MATERIALLY different vocabularies — the whole point of W3', () => {
    const gen = kindKeys(SEED_DEPARTMENT_IDS.GEN_ARCAAI);
    const rheum = kindKeys(SEED_DEPARTMENT_IDS.RHEUM_ARCAAI);

    expect(gen).toContain('vitals');
    expect(rheum).not.toContain('vitals');

    expect(rheum).toContain('joint_count');
    expect(rheum).toContain('inflammatory_markers');
    expect(gen).not.toContain('joint_count');

    // Different OUTPUTS too — the section headings a reader actually sees on the note.
    expect(outputKeys(SEED_DEPARTMENT_IDS.GEN_ARCAAI)).toContain('problem_list');
    expect(outputKeys(SEED_DEPARTMENT_IDS.RHEUM_ARCAAI)).toContain('disease_activity');
  });
});

describe(' W3 — the definitions are real, not merely well-formed-looking', () => {
  it.each([SEED_DEPARTMENT_IDS.GEN_ARCAAI, SEED_DEPARTMENT_IDS.RHEUM_ARCAAI])(
    '%s: passes the REAL contextSchemaDefinitionProblems() with zero problems',
    (departmentId) => {
      expect(contextSchemaDefinitionProblems(schemaFor(departmentId).definition)).toEqual([]);
    },
  );

  it.each([SEED_DEPARTMENT_IDS.GEN_ARCAAI, SEED_DEPARTMENT_IDS.RHEUM_ARCAAI])(
    '%s: the seeded version checksum is the REAL computeDefinitionChecksum of the definition',
    (departmentId) => {
      const schema = schemaFor(departmentId);
      const version = versionFor(schema.id);
      expect(version.checksum).toBe(computeDefinitionChecksum(schema.definition));
      // …and the seed's own local copy of that helper agrees with the real one.
      expect(version.checksum).toBe(definitionChecksum(schema.definition));
    },
  );

  it('pairs every schema with exactly one version-1 snapshot', () => {
    expect(ARCAAI_DEPARTMENT_CONTEXT_SCHEMA_VERSIONS).toHaveLength(2);
    for (const version of ARCAAI_DEPARTMENT_CONTEXT_SCHEMA_VERSIONS) {
      expect(version.versionNumber).toBe(1);
      expect(ARCAAI_DEPARTMENT_CONTEXT_SCHEMAS.some((s) => s.id === version.schemaId)).toBe(true);
    }
  });
});

describe(' W3 — re-seed safety', () => {
  it('is CREATE-ONLY: an existing default for that (tenant, scope, department) is never overwritten', async () => {
    const calls: string[] = [];
    const client: any = {
      consultationContextSchema: {
        findFirst: async () => {
          calls.push('findFirst');
          return { id: 'pre-existing-operator-row' };
        },
        create: async () => {
          calls.push('create');
          return {};
        },
      },
      consultationContextSchemaVersion: {
        create: async () => {
          calls.push('version.create');
          return {};
        },
      },
    };
    await seedArcaaiDepartmentContextSchemas(client);
    expect(calls).toEqual(['findFirst', 'findFirst']);
    expect(calls).not.toContain('create');
  });

  it('creates schema and version together on a clean database', async () => {
    const calls: string[] = [];
    const client: any = {
      consultationContextSchema: {
        findFirst: async () => null,
        create: async () => {
          calls.push('create');
          return {};
        },
      },
      consultationContextSchemaVersion: {
        create: async () => {
          calls.push('version.create');
          return {};
        },
      },
    };
    await seedArcaaiDepartmentContextSchemas(client);
    expect(calls).toEqual(['create', 'version.create', 'create', 'version.create']);
  });
});
