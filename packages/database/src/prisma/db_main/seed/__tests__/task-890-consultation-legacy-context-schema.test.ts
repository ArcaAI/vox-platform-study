/**
 * TASK-890 §3.4 — the legacy bridge, seeded.
 *
 * The load-bearing assertions are the last two groups:
 *
 *  - the definition is checked by the REAL `contextSchemaDefinitionProblems()` from
 *    `@arcaai/applications`, not by a local re-reading of what the format looks like. A seeded
 *    definition the service would reject on publish is a row no admin could have authored —
 *    and, worse here, a row the clone path (which goes through `create()` + `publish()`)
 *    would refuse at provisioning time;
 *  - the declared names are exactly the set `PromptAssemblyService.buildVariables` populates.
 *    That is the whole point of the bridge: a v1 prompt referencing `{{context.safe_dob}}`
 *    must pass the publish gate, and one referencing `{{context.safe_d0b}}` must not.
 *
 * PREREQUISITE: that validator imports `@arcaai/json-schema-subset`, which must be BUILT —
 * `packages/database` does not depend on it, so nothing builds it implicitly.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  LEGACY_CONTEXT_KIND_KEY,
  LEGACY_CONTEXT_SCHEMA,
  LEGACY_CONTEXT_SCHEMA_DEFINITION,
  LEGACY_CONTEXT_SCHEMA_SLUG,
  LEGACY_CONTEXT_SCHEMA_VERSION,
  LEGACY_CONTEXT_VARIABLE_NAMES,
} from '../07g-consultation-legacy-context-schema';
import { SYSTEM_TENANT_ID } from '../00-constants';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFINITION_MODULE = path.resolve(
  HERE,
  '../../../../../../applications/src/services/consultation-context-schema/context-schema-definition.ts',
);

const JSON_SCHEMA_SUBSET_DIST = path.resolve(HERE, '../../../../../../json-schema-subset/dist/index.mjs');
if (!existsSync(JSON_SCHEMA_SUBSET_DIST)) {
  throw new Error(
    `cannot validate the seeded legacy context schema — @arcaai/json-schema-subset is not built.\n` +
      `Run: pnpm --filter @arcaai/json-schema-subset build\n` +
      `(expected at ${JSON_SCHEMA_SUBSET_DIST})`,
  );
}

/* eslint-disable @typescript-eslint/no-explicit-any */
const definitionContract: any = await import(/* @vite-ignore */ DEFINITION_MODULE);
const { computeDefinitionChecksum, contextSchemaDefinitionProblems, payloadSchemaFromDefinition, LEGACY_CONTEXT_SCHEMA_SLUG: SLUG_FROM_APPLICATIONS } =
  definitionContract;

const kind = () => (LEGACY_CONTEXT_SCHEMA_DEFINITION as { kinds: Array<Record<string, unknown>> }).kinds[0]!;

describe('TASK-890 — the legacy consultation context schema (SYSTEM reference row)', () => {
  it('is a SYSTEM row, published and pinned, so the clone path has something servable to copy', () => {
    expect(LEGACY_CONTEXT_SCHEMA.tenantId).toBe(SYSTEM_TENANT_ID);
    expect(LEGACY_CONTEXT_SCHEMA.slug).toBe(LEGACY_CONTEXT_SCHEMA_SLUG);
    expect(LEGACY_CONTEXT_SCHEMA.scope).toBe('TENANT');
    expect(LEGACY_CONTEXT_SCHEMA.status).toBe('PUBLISHED');
    expect(LEGACY_CONTEXT_SCHEMA.pinnedVersionNumber).toBe(1);
  });

  it('is NOT the default — a compatibility vocabulary must not demote the tenant’s own', () => {
    // The clone path honours "at most one default per (tenant, scope, department)" by
    // DEMOTING the incumbent. Seeding this as a default would therefore silently replace
    // `consultation_default` in every tenant the reference set provisions.
    expect(LEGACY_CONTEXT_SCHEMA.isDefault).toBe(false);
  });

  it('carries a slug the create DTO would actually accept (underscores, not hyphens)', () => {
    expect(LEGACY_CONTEXT_SCHEMA_SLUG).toMatch(/^[a-z0-9_]{2,48}$/);
  });

  it('names the same slug the applications layer resolves the tenant clone by', () => {
    // Two declarations of one literal, because `packages/database` cannot import
    // `@arcaai/applications`. This is the guard that keeps them in step.
    expect(SLUG_FROM_APPLICATIONS).toBe(LEGACY_CONTEXT_SCHEMA_SLUG);
  });

  it('pins a version whose checksum is computed by the real canonicaliser', () => {
    expect(LEGACY_CONTEXT_SCHEMA_VERSION.schemaId).toBe(LEGACY_CONTEXT_SCHEMA.id);
    expect(LEGACY_CONTEXT_SCHEMA_VERSION.versionNumber).toBe(1);
    expect(LEGACY_CONTEXT_SCHEMA_VERSION.checksum).toBe(computeDefinitionChecksum(LEGACY_CONTEXT_SCHEMA_DEFINITION));
  });
});

describe('TASK-890 — the definition the service would accept', () => {
  it('has no problems according to the REAL publish validator', () => {
    expect(contextSchemaDefinitionProblems(LEGACY_CONTEXT_SCHEMA_DEFINITION)).toEqual([]);
  });

  it('declares exactly one STRUCTURED kind, keyed `context`', () => {
    expect((LEGACY_CONTEXT_SCHEMA_DEFINITION as { kinds: unknown[] }).kinds).toHaveLength(1);
    expect(kind().key).toBe(LEGACY_CONTEXT_KIND_KEY);
    expect(kind().primitive).toBe('STRUCTURED');
    expect(kind().producedBy).toEqual(['SYSTEM']);
  });

  it('leaves the field set OPEN — the values are code-produced, so a closed schema would gate a consultation', () => {
    expect(kind().fields).not.toHaveProperty('additionalProperties');
  });
});

describe('TASK-890 — the declared names ARE the buildVariables set', () => {
  it('declares every name the prompt assembler can populate, and nothing else', () => {
    const declared = Object.keys((kind().fields as { properties: Record<string, unknown> }).properties);

    expect(declared.sort()).toEqual([...LEGACY_CONTEXT_VARIABLE_NAMES].sort());
  });

  it('includes v1’s nine pre-summary placeholders verbatim', () => {
    // `PRE_SUMMARY_TEMPLATE_VARIABLES` in `pre-summary-variables.ts`. Re-typed here on purpose:
    // this test is the guard that the two lists agree, so importing one of them would defeat it.
    for (const name of [
      'current_department',
      'visit_type',
      'safe_age',
      'safe_dob',
      'safe_gender',
      'safe_vitals',
      'formatted_test_results',
      'formatted_previous_visits',
      'language_name',
    ]) {
      expect(LEGACY_CONTEXT_VARIABLE_NAMES).toContain(name);
    }
  });

  it('includes the eleven per-department DNA style slots', () => {
    expect(LEGACY_CONTEXT_VARIABLE_NAMES.filter((name) => name.startsWith('style_DNA_doctor_department_'))).toHaveLength(11);
  });

  it('declares every variable as a string — the value builders serialise before a prompt sees them', () => {
    const properties = (kind().fields as { properties: Record<string, { type: string }> }).properties;

    for (const [name, schema] of Object.entries(properties)) {
      expect(schema.type, name).toBe('string');
    }
  });
});

describe('TASK-890 — what the publish gate will check a prompt against', () => {
  it('derives a payload schema whose `context` property carries every legacy name', () => {
    const derived = payloadSchemaFromDefinition(LEGACY_CONTEXT_SCHEMA_DEFINITION) as {
      properties: Record<string, { properties: Record<string, unknown> }>;
    };

    expect(Object.keys(derived.properties)).toEqual([LEGACY_CONTEXT_KIND_KEY]);
    expect(Object.keys(derived.properties[LEGACY_CONTEXT_KIND_KEY]!.properties).sort()).toEqual([...LEGACY_CONTEXT_VARIABLE_NAMES].sort());
  });
});
