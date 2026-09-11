/**
 * TASK-930 §8.2 — the ONE trigger context schema: `consultation_note_context`.
 *
 * Replaces two files. `07e-consultation-loop-defaults.ts` seeded the day-1 item vocabulary
 * (`audio_stream`, `work_note`, `case_note`, `attachment`) as `consultation_default`, and
 * `07g-consultation-legacy-context-schema.ts` declared the v1 prompt variable names as the
 * `consultation_legacy_v1` bridge. Nothing at run time resolves the day-1 slug (`LoopConfigService`
 * reads the tenant DEFAULT through `findDefaultForScope`, never by slug), so both fold into this
 * one schema: the item kinds stay as they were, and the prompt vocabulary — the §8.2 fields every
 * clinical prompt binds through `{{trigger.context.*}}`, plus the legacy names
 * `PromptAssemblyService.buildVariables` still populates — lives under ONE `STRUCTURED` kind keyed
 * `context`.
 *
 * (The `07g-` stem named above is the RETIRED legacy-bridge file. It now belongs to
 * `07g-arcaai-two-schemas.ts`, a different seed entirely — TASK-951's two ArcaAI schemas, one of
 * which REFERENCES `NOTE_CONTEXT_PROMPT_KIND` below rather than retyping it.)
 *
 * ## Who owns which row
 *
 * Global (the platform-admin playground) AUTHORS it; SYSTEM carries the promoted copy — the
 * reference row `TenantReferenceSetService` / phase 26 clone into every other tenant (ArcaAI
 * receives it that way, never directly). Both are the tenant DEFAULT (`isDefault: true`): that is
 * what makes `LoopConfigService` resolve `enabled: true` on a fresh install, which was `07e`'s
 * whole job.
 *
 * ## Why `fields` is OPEN
 *
 * The VALUES are produced by code (`buildVariables`), so a closed schema would turn the next
 * variable that code learns to populate into a validation failure inside a consultation. Same
 * reasoning `07g` recorded; unchanged.
 *
 * ## No dependency on @arcaai/applications
 *
 * `packages/database` cannot import `@arcaai/applications` (dependency direction). The three
 * canonicalisers below are verbatim copies of `canonicalJson` / `computeDefinitionChecksum` /
 * `payloadSchemaFromDefinition` (`consultation-context-schema/context-schema-definition.ts`);
 * `task-930-consultation-note-context-schema.test.ts` asserts parity against the real ones.
 *
 * ID blocks (00-constants.ts): `79000000-…-<slot>-…000001` schemas / `89000000-…-<slot>-…000001`
 * versions, slot 0002 = SYSTEM, 0000 = Global (the slots `07e` used, kept so a re-seed of an
 * environment that already carries the row is a no-op).
 */
import { createHash } from 'node:crypto';

import type { CorePrismaClient } from '../../../client';
import { SEED_TENANT_ID, SYSTEM_TENANT_ID, SYSTEM_USER_ID } from './00-constants';

// =============================================================================
// Canonicalisers — verbatim copies (see the file header)
// =============================================================================

const isPlainObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** Copy of `canonicalJson` — object keys sorted, array order preserved. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isPlainObject(value)) {
    const entries = Object.keys(value)
      .sort()
      .filter((key) => value[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

/** Copy of `computeDefinitionChecksum`. */
export const definitionChecksum = (definition: unknown): string => createHash('sha256').update(canonicalJson(definition)).digest('hex');

/** Copy of `payloadSchemaFromDefinition` — what the compiler freezes as the trigger's `resolved` schema. */
export function payloadSchemaFromDefinition(definition: unknown): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  if (isPlainObject(definition) && Array.isArray(definition.kinds)) {
    for (const kind of definition.kinds) {
      if (!isPlainObject(kind) || typeof kind.key !== 'string' || kind.key.length === 0) continue;
      properties[kind.key] = kind.primitive === 'STRUCTURED' && isPlainObject(kind.fields) ? kind.fields : { type: 'object' };
      if (kind.required === true) required.push(kind.key);
    }
  }
  return { type: 'object', additionalProperties: false, properties, ...(required.length > 0 ? { required } : {}) };
}

// =============================================================================
// The definition
// =============================================================================

/**
 * UNDERSCORES, not hyphens: a context-schema slug is validated against `CONTEXT_KIND_KEY_PATTERN`
 * (`^[a-z0-9_]{2,48}$`) by the create DTO, so a hyphenated slug could not be authored through the
 * API and the clone path — which goes through `create()` — would refuse it.
 */
export const NOTE_CONTEXT_SCHEMA_SLUG = 'consultation_note_context';

/** The kind the prompt fields live under — `{{trigger.context.<field>}}` in every seeded graph. */
export const NOTE_CONTEXT_KIND_KEY = 'context';

/** The §8.2 fields, in the order the clinical templates read them. */
export const NOTE_CONTEXT_FIELDS: Record<string, Record<string, unknown>> = {
  visit_type: { type: 'string', enum: ['new-visit', 'revisit'], description: 'Whether this is a new / referral visit or a follow-up (revisit).' },
  current_department: { type: 'string', description: "The consultation's department name; `General` when unknown." },
  language: { type: 'string', description: 'The consultation language code (`en`, `ml`).' },
  safe_age: { type: 'string', description: 'Patient age, or `Unknown`.' },
  safe_dob: { type: 'string', description: 'Patient date of birth, or `Unknown`.' },
  safe_gender: { type: 'string', description: 'Patient gender, or `Unknown`.' },
  formatted_previous_visits: { type: 'string', description: 'Previous-visit summaries as text; empty when none.' },
  formatted_vitals: { type: 'string', description: 'Recorded vitals as text, or `Not available`.' },
  chief_complaint: { type: 'string', description: 'The presenting complaint, when the client supplies one.' },
};

/** The §8.2 fields that are always populated; `chief_complaint` is optional. */
export const NOTE_CONTEXT_REQUIRED_FIELDS = Object.keys(NOTE_CONTEXT_FIELDS).filter((name) => name !== 'chief_complaint');

/**
 * The v1 prompt vocabulary folded in from the retired `consultation_legacy_v1` bridge — every
 * name `PromptAssemblyService.buildVariables` can populate that is not already a §8.2 field.
 * All strings: the value builders serialise entities, note blocks and attachments to text.
 */
export const LEGACY_CONTEXT_FIELDS: Record<string, Record<string, unknown>> = {
  conversation_language: { type: 'string', description: 'The consultation language code (`en`, `ml`) — the v1 name of `language`.' },
  ner_entities: { type: 'string', description: 'Medical entities extracted from the transcript, serialised; empty when none.' },
  clinician_notes: { type: 'string', description: "The clinician's own working notes for this consultation." },
  attachments: { type: 'string', description: 'Text extracted from the consultation attachments.' },
  doctor_highlights: { type: 'string', description: 'Passages the clinician highlighted during the consultation.' },
  safe_vitals: { type: 'string', description: 'Recorded vitals, or `Not available` — the v1 name of `formatted_vitals`.' },
  formatted_test_results: { type: 'string', description: 'Test results as text; empty when none.' },
  language_name: { type: 'string', description: 'The consultation language by NAME (`English`, `Malayalam`).' },
  pre_summary_text: { type: 'string', description: 'The pre-summary this generation builds on.' },
  prior_visit_summary: { type: 'string', description: "The carried summary of the patient's previous visit, bounded." },
  dna_style_text: { type: 'string', description: "The doctor's resolved DNA writing style." },
  ...Object.fromEntries(
    [
      'surgery',
      'medicine',
      'neurology',
      'orthopedics',
      'hematology',
      'rheumatology',
      'dermatology',
      'dietetics',
      'nephrology',
      'surgical_oncology',
      'breast_endocrine',
    ].map((department) => [
      `style_DNA_doctor_department_${department}`,
      { type: 'string', description: `The doctor's DNA writing style, substituted into the ${department.replace(/_/g, ' ')} slot when the template declares it.` },
    ]),
  ),
};

/** Every declared name under the `context` kind — the §8.2 fields first, the folded-in v1 names after. */
export const NOTE_CONTEXT_FIELD_NAMES: readonly string[] = [...Object.keys(NOTE_CONTEXT_FIELDS), ...Object.keys(LEGACY_CONTEXT_FIELDS)];

/**
 * The platform-produced prompt-context kind, as ONE exported object.
 *
 * TASK-951 — extracted from the definition literal below (byte-identical content, so the
 * checksum this file publishes is unchanged) because a SECOND ArcaAI schema now has to carry
 * exactly this kind: `07g-arcaai-two-schemas.ts` REFERENCES it rather than retyping it, so the
 * two definitions cannot drift into disagreeing about what `{{trigger.context.*}}` declares.
 * Treat it as frozen: nothing may mutate it in place.
 */
export const NOTE_CONTEXT_PROMPT_KIND: Record<string, unknown> = {
  key: NOTE_CONTEXT_KIND_KEY,
  label: 'Consultation Prompt Context',
  primitive: 'STRUCTURED',
  phiClass: 'PHI',
  cardinality: 'ONE',
  lifecycle: 'ANY',
  producedBy: ['SYSTEM', 'CLIENT'],
  description:
    'The fields the clinical prompts bind (`{{trigger.context.*}}`): visit type, department, language, the safe patient facts, prior visits and vitals — plus the v1 prompt vocabulary, so every variable the platform populates is declared.',
  fields: {
    type: 'object',
    properties: { ...NOTE_CONTEXT_FIELDS, ...LEGACY_CONTEXT_FIELDS },
    required: NOTE_CONTEXT_REQUIRED_FIELDS,
  },
};

export const NOTE_CONTEXT_SCHEMA_DEFINITION: Record<string, unknown> = {
  schemaVersion: '1.0',
  kinds: [
    {
      key: 'audio_stream',
      label: 'Audio Stream',
      primitive: 'STREAM_AUDIO',
      phiClass: 'PHI',
      cardinality: 'ONE',
      lifecycle: 'DURING',
      producedBy: ['CLIENT'],
      description: 'The live consultation recording, captured by the STT session.',
    },
    {
      key: 'work_note',
      label: 'Work Note',
      primitive: 'TEXT',
      phiClass: 'PHI',
      cardinality: 'MANY',
      lifecycle: 'ANY',
      producedBy: ['CLIENT'],
      description: "The clinician's own working notes for this consultation.",
    },
    {
      key: 'case_note',
      label: 'Case Note',
      primitive: 'TEXT',
      phiClass: 'PHI',
      cardinality: 'MANY',
      lifecycle: 'ANY',
      producedBy: ['CLIENT'],
      description: 'Clinical case notes contributed during or around the consultation.',
    },
    {
      key: 'attachment',
      label: 'Attachment',
      primitive: 'DOCUMENT',
      phiClass: 'PHI',
      cardinality: 'MANY',
      lifecycle: 'ANY',
      producedBy: ['CLIENT'],
      description: 'A document attached to the consultation; its text is extracted before use.',
    },
    NOTE_CONTEXT_PROMPT_KIND,
  ],
  outputs: [{ key: 'case_note', label: 'Case Note', primitive: 'TEXT', description: 'The finalized case note the consultation workflow produces.' }],
};

// =============================================================================
// Rows — Global authors (slot 0000), SYSTEM is the promoted copy (slot 0002)
// =============================================================================

const TENANT_ID_SLOTS: Array<{ tenantId: string; slot: string }> = [
  { tenantId: SEED_TENANT_ID, slot: '0000' },
  { tenantId: SYSTEM_TENANT_ID, slot: '0002' },
];

export const noteContextSchemaIdFor = (tenantId: string): string => {
  const slot = TENANT_ID_SLOTS.find((entry) => entry.tenantId === tenantId)?.slot;
  if (!slot) throw new Error(`No seeded consultation_note_context slot for tenant ${tenantId}`);
  return `79000000-0000-0000-${slot}-000000000001`;
};

export const noteContextSchemaVersionIdFor = (tenantId: string): string => `89${noteContextSchemaIdFor(tenantId).slice(2)}`;

export const NOTE_CONTEXT_SCHEMAS = TENANT_ID_SLOTS.map(({ tenantId }) => ({
  id: noteContextSchemaIdFor(tenantId),
  tenantId,
  slug: NOTE_CONTEXT_SCHEMA_SLUG,
  name: 'Consultation Note Context',
  description:
    'The consultation context every seeded workflow triggers on: the live audio stream, work notes, case notes and attachments, plus the structured prompt context (visit type, department, language, safe patient facts, prior visits, vitals) the clinical templates bind. Editable by a tenant admin; a re-seed never overwrites it.',
  scope: 'TENANT' as const,
  departmentId: null as string | null,
  status: 'PUBLISHED' as const,
  pinnedVersionNumber: 1,
  isDefault: true,
  sourceTemplateSlug: null as string | null,
  templateLocked: false,
  resourceStatus: 'ENABLED' as const,
  createdBy: SYSTEM_USER_ID,
}));

export const NOTE_CONTEXT_SCHEMA_VERSIONS = TENANT_ID_SLOTS.map(({ tenantId }) => ({
  id: noteContextSchemaVersionIdFor(tenantId),
  tenantId,
  schemaId: noteContextSchemaIdFor(tenantId),
  versionNumber: 1,
  definition: NOTE_CONTEXT_SCHEMA_DEFINITION,
  checksum: definitionChecksum(NOTE_CONTEXT_SCHEMA_DEFINITION),
  changeReason: 'The consultation note context: day-1 item kinds + the clinical prompt fields (TASK-930 §8.2)',
  createdBy: SYSTEM_USER_ID,
}));

// =============================================================================
// Seed function
// =============================================================================

export const seedConsultationNoteContextSchema = async (client: CorePrismaClient) => {
  console.log('Seeding the consultation note context schema (Global + SYSTEM) ...');

  let created = 0;
  let skipped = 0;

  for (const [index, schema] of NOTE_CONTEXT_SCHEMAS.entries()) {
    const version = NOTE_CONTEXT_SCHEMA_VERSIONS[index];
    if (!version) throw new Error(`Missing consultation_note_context version for ${schema.id}`);

    // CREATE-ONLY, on TWO conditions: the seeded row itself, and any OTHER default TENANT-scoped
    // schema the tenant may already own — the application-layer "at most one default per
    // (tenant, scope, departmentId)" rule, which the DB cannot express.
    const existing = await client.consultationContextSchema.findFirst({
      where: {
        tenantId: schema.tenantId,
        OR: [{ id: schema.id }, { scope: 'TENANT', departmentId: null, isDefault: true, resourceStatus: 'ENABLED' }],
      },
      select: { id: true },
    });
    if (existing) {
      skipped += 1;
      continue;
    }

    await client.consultationContextSchema.create({ data: schema });
    await client.consultationContextSchemaVersion.create({ data: { ...version, definition: version.definition as never } });
    created += 1;
  }

  console.log(`  ✓ ${NOTE_CONTEXT_SCHEMA_SLUG}: ${created} created, ${skipped} left untouched (already present or tenant-configured)`);
};
