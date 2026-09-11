/**
 * TASK-951 (lane A) — ArcaAI carries exactly TWO consultation context schemas.
 *
 * Hermetic, in the `task-798` / `task-930` shape: the definitions are pure data, checked against
 * the REAL `contextSchemaDefinitionProblems()` / `computeDefinitionChecksum()` /
 * `payloadSchemaFromDefinition()` / `userIdentityBindingFromDefinition()` in `@arcaai/applications`
 * (imported from source), and the seed function runs against a fake client.
 *
 * ## Why the marker keys are filtered out of the validator's verdict
 *
 * The four open-time markers and the two informational ones (`department`, `visitType`,
 * `externalRef`, `materializeAs`, `streamContext` — `userIdentity` already exists) are LANE B's
 * grammar, landing in parallel with this lane. Until it does, `KIND_KEYS` does not list them and
 * the validator reports each as `unknown key`. This test therefore asserts two things separately:
 * the markers are PRESENT on the right kinds with the right shape (lane A's contract), and the
 * definitions carry NO OTHER problem (which is the part lane B cannot change). After lane B lands
 * the filter matches nothing and the assertion tightens to "zero problems" on its own.
 *
 * PREREQUISITE: the validator imports `@arcaai/json-schema-subset`, which must be BUILT.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { SEED_ARCAAI_CONTEXT_SCHEMA_IDS, SEED_ARCAAI_CONTEXT_SCHEMA_VERSION_IDS, SEED_CUSTOMER_TENANT_IDS } from '../00-constants';
import {
  NOTE_CONTEXT_PROMPT_KIND,
  NOTE_CONTEXT_SCHEMA_DEFINITION,
  NOTE_CONTEXT_SCHEMA_SLUG,
  definitionChecksum,
  payloadSchemaFromDefinition,
} from '../07e-consultation-note-context-schema';
import {
  ARCAAI_CONSULTATION_SCRIBE_DEFINITION,
  ARCAAI_CONSULTATION_SCRIBE_SLUG,
  ARCAAI_REALTIME_TRANSCRIPTION_DEFINITION,
  ARCAAI_REALTIME_TRANSCRIPTION_FROZEN_CONTEXT_SCHEMA,
  ARCAAI_REALTIME_TRANSCRIPTION_SLUG,
  ARCAAI_RETIRED_DEPARTMENT_SCHEMA_SLUGS,
  ARCAAI_TWO_CONTEXT_SCHEMAS,
  ARCAAI_TWO_CONTEXT_SCHEMA_VERSIONS,
  seedArcaaiTwoContextSchemas,
} from '../07g-arcaai-two-schemas';
import { ASR_AGENT_SLUG, checksumOf } from '../25-agents';
import { ARCAAI_SCRIBE_CONTEXT_SCHEMA_ID, ARCAAI_SCRIBE_CONTEXT_SCHEMA_VERSION_ID, ARCAAI_WORKFLOW_TARGETS } from '../29-arcaai-agents-and-workflows';

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
const definitionModule: any = await import(/* @vite-ignore */ DEFINITION_MODULE);
const { computeDefinitionChecksum, contextSchemaDefinitionProblems, userIdentityBindingFromDefinition } = definitionModule;

const ARCAAI = SEED_CUSTOMER_TENANT_IDS.ARCAAI;

/** The marker keys lane B adds to `KIND_KEYS`; `userIdentity` is already there. */
const LANE_B_MARKER_KEYS = ['department', 'visitType', 'externalRef', 'materializeAs', 'streamContext'] as const;
const LANE_B_UNKNOWN_KEY = new RegExp(`unknown key \`(${LANE_B_MARKER_KEYS.join('|')})\``);

/** Every problem the REAL validator reports that is NOT "lane B has not landed yet". */
const realProblems = (definition: Record<string, unknown>): string[] =>
  (contextSchemaDefinitionProblems(definition) as string[]).filter((problem) => !LANE_B_UNKNOWN_KEY.test(problem));

const kindsOf = (definition: Record<string, unknown>) => definition.kinds as Array<Record<string, any>>;
const kind = (definition: Record<string, unknown>, key: string) => {
  const found = kindsOf(definition).find((entry) => entry.key === key);
  if (!found) throw new Error(`no kind \`${key}\``);
  return found;
};

describe('TASK-951 — ArcaAI seeds exactly two context schemas', () => {
  it('both rows are TENANT-scoped, PUBLISHED, pinned at v1, authored (not cloned), and only the scribe is the default', () => {
    expect(ARCAAI_TWO_CONTEXT_SCHEMAS).toHaveLength(2);
    expect(ARCAAI_TWO_CONTEXT_SCHEMAS.map((row) => row.slug)).toEqual([ARCAAI_REALTIME_TRANSCRIPTION_SLUG, ARCAAI_CONSULTATION_SCRIBE_SLUG]);
    for (const row of ARCAAI_TWO_CONTEXT_SCHEMAS) {
      expect(row).toMatchObject({
        tenantId: ARCAAI,
        scope: 'TENANT',
        departmentId: null,
        status: 'PUBLISHED',
        pinnedVersionNumber: 1,
        resourceStatus: 'ENABLED',
        // AUTHORED for ArcaAI: a reference-set resync must never overwrite a contract ALaaS
        // integrates against, and `templateLocked` is exactly the flag that would let it.
        sourceTemplateSlug: null,
        templateLocked: false,
      });
    }
    expect(ARCAAI_TWO_CONTEXT_SCHEMAS.filter((row) => row.isDefault).map((row) => row.slug)).toEqual([ARCAAI_CONSULTATION_SCRIBE_SLUG]);
  });

  it('uses the allocated id slots, and pairs each schema with exactly one v1 snapshot', () => {
    expect(ARCAAI_TWO_CONTEXT_SCHEMAS.map((row) => row.id)).toEqual([
      SEED_ARCAAI_CONTEXT_SCHEMA_IDS.REALTIME_TRANSCRIPTION,
      SEED_ARCAAI_CONTEXT_SCHEMA_IDS.CONSULTATION_SCRIBE,
    ]);
    expect(ARCAAI_TWO_CONTEXT_SCHEMA_VERSIONS.map((version) => version.id)).toEqual([
      SEED_ARCAAI_CONTEXT_SCHEMA_VERSION_IDS.REALTIME_TRANSCRIPTION,
      SEED_ARCAAI_CONTEXT_SCHEMA_VERSION_IDS.CONSULTATION_SCRIBE,
    ]);
    // The retired `07f` slots are burned, never reused.
    expect(ARCAAI_TWO_CONTEXT_SCHEMAS.map((row) => row.id)).not.toContain('79000000-0000-0000-0001-000000000010');
    expect(ARCAAI_TWO_CONTEXT_SCHEMAS.map((row) => row.id)).not.toContain('79000000-0000-0000-0001-000000000011');
    for (const version of ARCAAI_TWO_CONTEXT_SCHEMA_VERSIONS) {
      expect(version.versionNumber).toBe(1);
      expect(version.tenantId).toBe(ARCAAI);
      expect(ARCAAI_TWO_CONTEXT_SCHEMAS.some((row) => row.id === version.schemaId)).toBe(true);
    }
  });

  it('the seeded checksums are the REAL computeDefinitionChecksum of their definitions', () => {
    for (const [index, version] of ARCAAI_TWO_CONTEXT_SCHEMA_VERSIONS.entries()) {
      const definition = index === 0 ? ARCAAI_REALTIME_TRANSCRIPTION_DEFINITION : ARCAAI_CONSULTATION_SCRIBE_DEFINITION;
      expect(version.definition).toBe(definition);
      expect(version.checksum).toBe(computeDefinitionChecksum(definition));
      expect(version.checksum).toBe(definitionChecksum(definition));
    }
  });
});

describe('TASK-951 — the definitions are publishable by the REAL validator', () => {
  it.each([
    ['arcaai_realtime_transcription', ARCAAI_REALTIME_TRANSCRIPTION_DEFINITION],
    ['arcaai_consultation_scribe', ARCAAI_CONSULTATION_SCRIBE_DEFINITION],
  ])('%s: carries no problem other than a marker key lane B has not declared yet', (_slug, definition) => {
    expect(realProblems(definition as Record<string, unknown>)).toEqual([]);
  });

  it('the seed copy of payloadSchemaFromDefinition agrees with the real one for both definitions', () => {
    for (const definition of [ARCAAI_REALTIME_TRANSCRIPTION_DEFINITION, ARCAAI_CONSULTATION_SCRIBE_DEFINITION]) {
      expect(payloadSchemaFromDefinition(definition)).toEqual(definitionModule.payloadSchemaFromDefinition(definition));
    }
  });
});

describe('TASK-951 — schema 1, the standalone transcription contract (R2)', () => {
  it('declares the audio stream and a client-owned `stream` kind that echoes verbatim', () => {
    expect(kindsOf(ARCAAI_REALTIME_TRANSCRIPTION_DEFINITION).map((entry) => entry.key)).toEqual(['audio_stream', 'stream']);
    const stream = kind(ARCAAI_REALTIME_TRANSCRIPTION_DEFINITION, 'stream');
    expect(stream).toMatchObject({ primitive: 'STRUCTURED', cardinality: 'ONE', lifecycle: 'PRE', producedBy: ['CLIENT'], streamContext: true });
    expect(stream.fields.required).toEqual(['mic_id']);
    // "exactly the same metadata things" back — a curated subset would not be an echo.
    expect(stream.fields.additionalProperties).toBe(true);
  });

  it('declares the two outputs the session produces', () => {
    const outputs = (ARCAAI_REALTIME_TRANSCRIPTION_DEFINITION.outputs as Array<Record<string, any>>).map((entry) => entry.key);
    expect(outputs).toEqual(['transcript', 'transcript_segment']);
  });

  it('declares no user-identity field — a stream session names no clinician', () => {
    expect(userIdentityBindingFromDefinition(ARCAAI_REALTIME_TRANSCRIPTION_DEFINITION)).toBeNull();
  });
});

describe('TASK-951 — schema 2, the consultation scribe (R1/R3)', () => {
  it('declares the seven kinds, with the platform prompt context REFERENCED from 07e, not retyped', () => {
    expect(kindsOf(ARCAAI_CONSULTATION_SCRIBE_DEFINITION).map((entry) => entry.key)).toEqual([
      'audio_stream',
      'encounter',
      'vitals',
      'previous_case_notes',
      'work_note',
      'attachment',
      'context',
    ]);
    // The SAME object the note-context schema publishes: the clinical templates bind
    // `{{trigger.context.*}}`, and two copies would eventually disagree about the names.
    expect(kind(ARCAAI_CONSULTATION_SCRIBE_DEFINITION, 'context')).toBe(NOTE_CONTEXT_PROMPT_KIND);
    expect(kind(ARCAAI_CONSULTATION_SCRIBE_DEFINITION, 'context')).toEqual(kind(NOTE_CONTEXT_SCHEMA_DEFINITION, 'context'));
  });

  it('`encounter` carries all four open-time markers, each naming a property it declares', () => {
    const encounter = kind(ARCAAI_CONSULTATION_SCRIBE_DEFINITION, 'encounter');
    expect(encounter).toMatchObject({ primitive: 'STRUCTURED', cardinality: 'ONE', lifecycle: 'PRE', producedBy: ['CLIENT'], required: true });
    expect(encounter.userIdentity).toEqual({ field: 'doctor_id' });
    expect(encounter.department).toEqual({ field: 'department_code', by: 'code' });
    expect(encounter.visitType).toEqual({ field: 'visit_type' });
    expect(encounter.externalRef).toEqual({ field: 'event_id' });

    const properties = encounter.fields.properties as Record<string, Record<string, unknown>>;
    for (const field of ['doctor_id', 'department_code', 'visit_type', 'event_id']) {
      expect(properties[field], field).toBeDefined();
      expect(properties[field]!.type, field).toBe('string');
    }
    expect(encounter.fields.required).toEqual(['doctor_id', 'event_id', 'department_code', 'visit_type']);
    // The visit type selects the prompt, so its values must be catalogue keys, not free text.
    expect(properties.visit_type!.enum).toEqual(['new-visit', 'revisit']);
  });

  it('the identity marker is what the REAL derivation reads off the definition', () => {
    expect(userIdentityBindingFromDefinition(ARCAAI_CONSULTATION_SCRIBE_DEFINITION)).toEqual({ kindKey: 'encounter', field: 'doctor_id' });
  });

  it('`vitals` is the NORMALISED object shape (OD-4), every property optional', () => {
    const vitals = kind(ARCAAI_CONSULTATION_SCRIBE_DEFINITION, 'vitals');
    expect(vitals).toMatchObject({ primitive: 'STRUCTURED', cardinality: 'ONE', lifecycle: 'PRE', phiClass: 'PHI' });
    expect(Object.keys(vitals.fields.properties as Record<string, unknown>)).toEqual([
      'bloodPressure',
      'heartRate',
      'respiratoryRate',
      'temperature',
      'oxygenSaturation',
      'weightKg',
      'heightCm',
      'bmi',
      'bloodGlucose',
      'painScore',
      'recordedAt',
      'notes',
    ]);
    // "send what you have" — a required field here would refuse a partial observation set.
    expect(vitals.fields.required).toBeUndefined();
    // NOT an observation list: a prompt/agent/workflow binds a NAMED property.
    expect((vitals.fields.properties as Record<string, unknown>).observations).toBeUndefined();
  });

  it('`previous_case_notes` materializes as CASE_NOTE items, in the shape lane B gates on', () => {
    const notes = kind(ARCAAI_CONSULTATION_SCRIBE_DEFINITION, 'previous_case_notes');
    expect(notes.materializeAs).toBe('CASE_NOTE');
    expect(notes.fields.required).toEqual(['notes']);
    expect(notes.fields.properties.notes.type).toBe('array');
    expect(notes.fields.properties.notes.items.type).toBe('object');
    expect(notes.fields.properties.notes.items.required).toEqual(['text']);
    expect(notes.fields.properties.notes.items.properties.text.type).toBe('string');
  });

  it('at most one kind claims each marker role', () => {
    for (const marker of ['userIdentity', ...LANE_B_MARKER_KEYS]) {
      const claimants = kindsOf(ARCAAI_CONSULTATION_SCRIBE_DEFINITION).filter((entry) => entry[marker] !== undefined);
      expect(claimants.length, marker).toBeLessThanOrEqual(1);
      // A marker only ever sits on a STRUCTURED / ONE kind.
      for (const claimant of claimants) expect([claimant.primitive, claimant.cardinality], marker).toEqual(['STRUCTURED', 'ONE']);
    }
  });
});

describe('TASK-951 — the bindings', () => {
  it('all 11 ArcaAI consultation triggers reference the scribe, not the note-context clone', () => {
    expect(ARCAAI_WORKFLOW_TARGETS).toHaveLength(11);
    expect(ARCAAI_SCRIBE_CONTEXT_SCHEMA_ID).toBe(SEED_ARCAAI_CONTEXT_SCHEMA_IDS.CONSULTATION_SCRIBE);
    expect(ARCAAI_SCRIBE_CONTEXT_SCHEMA_VERSION_ID).toBe(SEED_ARCAAI_CONTEXT_SCHEMA_VERSION_IDS.CONSULTATION_SCRIBE);
    for (const target of ARCAAI_WORKFLOW_TARGETS) {
      const trigger = target.graph.nodes.find((node) => node.type === 'core.trigger');
      expect(trigger, target.key).toBeDefined();
      expect((trigger!.config as any).contextSchema).toEqual({ contextSchemaId: SEED_ARCAAI_CONTEXT_SCHEMA_IDS.CONSULTATION_SCRIBE, versionNumber: 1 });
      expect(target.contextSchemaVersionId).toBe(SEED_ARCAAI_CONTEXT_SCHEMA_VERSION_IDS.CONSULTATION_SCRIBE);
      // The regen script derives THIS target's payload schema from here; without it the compiled
      // trigger would freeze the note-context payload and reject `encounter` at run time.
      expect(target.contextSchemaDefinition).toBe(ARCAAI_CONSULTATION_SCRIBE_DEFINITION);
    }
  });

  it('the frozen ASR context schema is exactly what a real publish stamps', () => {
    // `AgentService.resolveContextSchema` → `resolveReference`: the four fields, and
    // `userIdentity` OMITTED (never `null`) when the pinned version declares none.
    expect(ARCAAI_REALTIME_TRANSCRIPTION_FROZEN_CONTEXT_SCHEMA).toEqual({
      schemaId: SEED_ARCAAI_CONTEXT_SCHEMA_IDS.REALTIME_TRANSCRIPTION,
      versionNumber: 1,
      versionId: SEED_ARCAAI_CONTEXT_SCHEMA_VERSION_IDS.REALTIME_TRANSCRIPTION,
      payloadSchema: definitionModule.payloadSchemaFromDefinition(ARCAAI_REALTIME_TRANSCRIPTION_DEFINITION),
    });
    expect(Object.keys(ARCAAI_REALTIME_TRANSCRIPTION_FROZEN_CONTEXT_SCHEMA)).not.toContain('userIdentity');
  });
});

// =================================================================================================
// The seed function
// =================================================================================================

interface FakeRow {
  id: string;
  tenantId: string;
  slug: string;
  isDefault: boolean;
  resourceStatus: string;
}

function fakeClient(options: { schemas?: FakeRow[]; agent?: Record<string, any> | null } = {}) {
  const schemas: FakeRow[] = options.schemas ? [...options.schemas] : [];
  const versions: Array<Record<string, any>> = [];
  const agent = options.agent === undefined ? { id: 'agent-1', contextSchemaId: null, compiledConfig: { task: 'SPEECH_TO_TEXT', contextSchema: null } } : options.agent;
  const agentUpdates: Array<Record<string, any>> = [];

  const matches = (row: FakeRow, where: any): boolean => {
    if (where.tenantId !== undefined && row.tenantId !== where.tenantId) return false;
    if (where.isDefault !== undefined && row.isDefault !== where.isDefault) return false;
    if (typeof where.slug === 'string' && row.slug !== where.slug) return false;
    if (where.slug?.in && !where.slug.in.includes(row.slug)) return false;
    if (where.resourceStatus?.not && row.resourceStatus === where.resourceStatus.not) return false;
    if (where.OR && !where.OR.some((clause: any) => (clause.id !== undefined ? row.id === clause.id : row.slug === clause.slug))) return false;
    return true;
  };

  const client: any = {
    consultationContextSchema: {
      findFirst: async ({ where }: any) => schemas.find((row) => matches(row, where)) ?? null,
      create: async ({ data }: any) => {
        schemas.push({ ...data });
        return data;
      },
      updateMany: async ({ where, data }: any) => {
        const hit = schemas.filter((row) => matches(row, where));
        for (const row of hit) Object.assign(row, data);
        return { count: hit.length };
      },
    },
    consultationContextSchemaVersion: { create: async ({ data }: any) => versions.push(data) },
    agent: {
      findFirst: async () => agent,
      update: async ({ data }: any) => {
        agentUpdates.push(data);
        if (agent) Object.assign(agent, { contextSchemaId: data.contextSchemaId, compiledConfig: data.compiledConfig });
        return data;
      },
    },
  };
  return { client, schemas, versions, agent, agentUpdates };
}

const noteContextClone = (): FakeRow => ({ id: 'clone-1', tenantId: ARCAAI, slug: NOTE_CONTEXT_SCHEMA_SLUG, isDefault: true, resourceStatus: 'ENABLED' });
const retiredDepartmentRows = (): FakeRow[] =>
  ARCAAI_RETIRED_DEPARTMENT_SCHEMA_SLUGS.map((slug, index) => ({ id: `dept-${index}`, tenantId: ARCAAI, slug, isDefault: true, resourceStatus: 'ENABLED' }));

describe('TASK-951 — seeding is create-only and the retirement sweep is idempotent', () => {
  it('on a tenant seeded before this ticket: demotes the clone, retires the two department rows, creates two schemas', async () => {
    const fake = fakeClient({ schemas: [noteContextClone(), ...retiredDepartmentRows()] });
    const result = await seedArcaaiTwoContextSchemas(fake.client);

    expect(result).toMatchObject({ created: 2, skipped: 0, demoted: 1, retired: 2, agent: 'bound' });
    expect(fake.versions).toHaveLength(2);

    const bySlug = new Map(fake.schemas.map((row) => [row.slug, row]));
    expect(bySlug.get(NOTE_CONTEXT_SCHEMA_SLUG)!.isDefault).toBe(false);
    for (const slug of ARCAAI_RETIRED_DEPARTMENT_SCHEMA_SLUGS) {
      expect(bySlug.get(slug)!.resourceStatus).toBe('DELETED');
      expect(bySlug.get(slug)!.isDefault).toBe(false);
    }
    // Exactly ONE live TENANT default remains, and it is the scribe.
    const defaults = fake.schemas.filter((row) => row.isDefault && row.resourceStatus !== 'DELETED');
    expect(defaults.map((row) => row.slug)).toEqual([ARCAAI_CONSULTATION_SCRIBE_SLUG]);
  });

  it('a second run writes nothing new and changes nothing', async () => {
    const fake = fakeClient({ schemas: [noteContextClone(), ...retiredDepartmentRows()] });
    await seedArcaaiTwoContextSchemas(fake.client);
    const after = JSON.parse(JSON.stringify(fake.schemas));

    const second = await seedArcaaiTwoContextSchemas(fake.client);
    expect(second).toMatchObject({ created: 0, skipped: 2, demoted: 0, retired: 0, agent: 'already-bound' });
    expect(fake.versions).toHaveLength(2);
    expect(JSON.parse(JSON.stringify(fake.schemas))).toEqual(after);
  });

  it('never creates a row whose slug the tenant already carries (an admin edit survives a re-seed)', async () => {
    const operatorRow: FakeRow = { id: 'operator-authored', tenantId: ARCAAI, slug: ARCAAI_CONSULTATION_SCRIBE_SLUG, isDefault: true, resourceStatus: 'ENABLED' };
    const fake = fakeClient({ schemas: [operatorRow] });
    const result = await seedArcaaiTwoContextSchemas(fake.client);
    expect(result.created).toBe(1);
    expect(result.skipped).toBe(1);
    expect(fake.schemas.find((row) => row.id === 'operator-authored')).toBeDefined();
  });
});

describe('TASK-951 — the ASR agent binding', () => {
  it('binds the transcription schema AND freezes it into the compiled artifact, with a recomputed checksum', async () => {
    const compiled = { task: 'SPEECH_TO_TEXT', service: 'stt', contextSchema: null };
    const fake = fakeClient({ agent: { id: 'agent-1', contextSchemaId: null, compiledConfig: compiled } });
    await seedArcaaiTwoContextSchemas(fake.client);

    expect(fake.agentUpdates).toHaveLength(1);
    const update = fake.agentUpdates[0]!;
    expect(update.contextSchemaId).toBe(SEED_ARCAAI_CONTEXT_SCHEMA_IDS.REALTIME_TRANSCRIPTION);
    expect(update.contextSchemaVersionNumber).toBe(1);
    expect(update.compiledConfig.contextSchema).toEqual(ARCAAI_REALTIME_TRANSCRIPTION_FROZEN_CONTEXT_SCHEMA);
    // The runtime never re-reads the schema row, so the artifact and its checksum must agree.
    expect(update.compiledConfigChecksum).toBe(checksumOf(update.compiledConfig));
    expect(ASR_AGENT_SLUG).toBe('realtime-transcription');
  });

  it('leaves an agent that already pins a schema alone', async () => {
    const fake = fakeClient({ agent: { id: 'agent-1', contextSchemaId: 'an-admins-own-choice', compiledConfig: {} } });
    const result = await seedArcaaiTwoContextSchemas(fake.client);
    expect(result.agent).toBe('already-bound');
    expect(fake.agentUpdates).toHaveLength(0);
  });

  it('reports an absent agent rather than failing the seed', async () => {
    const fake = fakeClient({ agent: null });
    const result = await seedArcaaiTwoContextSchemas(fake.client);
    expect(result.agent).toBe('absent');
  });
});
