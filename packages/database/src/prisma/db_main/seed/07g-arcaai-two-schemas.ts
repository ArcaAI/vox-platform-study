/**
 * TASK-951 (R1 / D-10) — ArcaAI carries exactly TWO consultation context schemas.
 *
 * Before this phase the tenant carried three, bound inconsistently: the phase-26 CLONE of
 * `consultation_note_context` (the TENANT default, and what all 11 `arcaai-<dept>-consultation`
 * triggers referenced), plus two DEPARTMENT-scoped rows from `07f-arcaai-department-context-schemas.ts`
 * (`consultation_gen_arcaai`, `consultation_rheum_arcaai`) that NOTHING bound but that discovery
 * nevertheless SERVED for their two departments — so a client's `open.context` was validated
 * against a vocabulary no workflow ever read. The owner's ask ("create 2 schemas") settles it:
 *
 * | Slug | Scope | Default | Bound by |
 * |---|---|---|---|
 * | `arcaai_realtime_transcription` | TENANT | no | ArcaAI's `realtime-transcription` SPEECH_TO_TEXT agent (`Agent.contextSchemaId`) |
 * | `arcaai_consultation_scribe` | TENANT | **yes** | the `core.trigger` of all 11 ArcaAI consultation workflows (`29-arcaai-agents-and-workflows.ts`) |
 *
 * ## Why this phase runs AFTER 26, not beside 07e/07f
 *
 * The retirement half has to act on rows phase 26 writes — ArcaAI's clone of
 * `consultation_note_context` is created there with `isDefault: source.isDefault` (true). A
 * sweep that ran before the clone existed would flip nothing and leave TWO tenant defaults, which
 * is the application-layer invariant `ConsultationContextSchemaService` enforces on every write
 * and which discovery resolves arbitrarily. So: phase 26 clones, THEN this phase demotes the
 * clone and installs the scribe as the tenant's one default.
 *
 * ## What is CREATE-ONLY and what is a SWEEP
 *
 * The two new rows are create-only, guarded on `id` and on `(tenantId, slug)` — the model's own
 * unique key. Deliberately NOT on 07e's "any other TENANT default" condition: for ArcaAI that
 * condition is ALWAYS true (the clone is one), so it would refuse to ever create the scribe.
 *
 * The retirement sweep is idempotent by construction (it narrows on the state it changes, so the
 * second run matches zero rows) and runs on every seed, because an environment seeded before this
 * ticket still carries the rows it retires. It never touches another tenant: every `where` names
 * `tenantId = ARCAAI` and a slug this phase or `07f` authored.
 *
 * The agent re-bind is create-only in spirit: it binds ONLY an agent whose `contextSchemaId` is
 * still NULL, so a tenant admin who has since pinned a schema of their own keeps it.
 *
 * ## No dependency on @arcaai/applications
 *
 * `packages/database` cannot import it (dependency direction), so the checksum and the derived
 * payload schema come from `07e`'s verbatim copies of `computeDefinitionChecksum` /
 * `payloadSchemaFromDefinition`, and `task-951-arcaai-two-schemas.test.ts` asserts both
 * definitions against the REAL `contextSchemaDefinitionProblems()`.
 */
import type { CorePrismaClient } from '../../../client';
import { SEED_ARCAAI_CONTEXT_SCHEMA_IDS, SEED_ARCAAI_CONTEXT_SCHEMA_VERSION_IDS, SEED_CUSTOMER_TENANT_IDS, SYSTEM_USER_ID } from './00-constants';
import {
  NOTE_CONTEXT_PROMPT_KIND,
  NOTE_CONTEXT_SCHEMA_SLUG,
  definitionChecksum,
  payloadSchemaFromDefinition,
} from './07e-consultation-note-context-schema';
import { ASR_AGENT_SLUG, checksumOf } from './25-agents';

const ARCAAI = SEED_CUSTOMER_TENANT_IDS.ARCAAI;

export const ARCAAI_REALTIME_TRANSCRIPTION_SLUG = 'arcaai_realtime_transcription';
export const ARCAAI_CONSULTATION_SCRIBE_SLUG = 'arcaai_consultation_scribe';

/**
 * The two DEPARTMENT-scoped slugs `07f` authored, retired by OD-9.
 *
 * Named here rather than imported because `07f` is DELETED by this ticket: the sweep has to keep
 * working against a database seeded before that deletion, and a retirement that depended on the
 * retired module could never be run.
 */
export const ARCAAI_RETIRED_DEPARTMENT_SCHEMA_SLUGS: readonly string[] = ['consultation_gen_arcaai', 'consultation_rheum_arcaai'];

// =============================================================================
// Schema 1 — `arcaai_realtime_transcription`
// =============================================================================

/**
 * The standalone transcription contract (R2, as the owner clarified it on 2026-09-11).
 *
 * `stream` is the kind that carries whatever the client wants handed back. ALaaS records ONE
 * session and declares ONE microphone at a time — `mic_id` — whenever the live mic changes; a
 * frame that declares nothing inherits the last declaration (sticky), and each transcript comes
 * back with the `mic_id` that was live over its audio. So `mic_id` (one string) is the only
 * required property, and `additionalProperties: true` is deliberate — the echo is "exactly the
 * same metadata things" the client sent, not a platform-curated subset of them. The kind is read
 * in two places: `context.stream` at session create (the initial declaration, validated against
 * the whole payload schema), and every `{ type: 'metadata' }` socket frame afterwards, validated
 * against THIS kind's `fields` and handed back on each transcript as `metadata` (the object in
 * force) plus `metadataSpans` (its exact bounds within the segment). `streamContext: true` is the
 * marker that names this kind for the second use (lane B's grammar; frozen as
 * `openBindings.streamContext.kindKey`).
 */
export const ARCAAI_REALTIME_TRANSCRIPTION_DEFINITION: Record<string, unknown> = {
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
      description: 'The live audio of this stream session, captured by the STT session.',
    },
    {
      key: 'stream',
      label: 'Stream Metadata',
      primitive: 'STRUCTURED',
      phiClass: 'NON_PHI',
      cardinality: 'ONE',
      lifecycle: 'PRE',
      producedBy: ['CLIENT'],
      description:
        'Client-owned identification of the microphone live on this audio stream — one at a time. Declared as `context.stream` at create, re-declared on the socket as a `metadata` frame whenever the live microphone changes (sticky until the next declaration), and handed back VERBATIM on every transcript segment as the object in force over its audio.',
      fields: {
        type: 'object',
        properties: {
          mic_id: { type: 'string', minLength: 1 },
          speaker_label: { type: 'string' },
          channel: { type: 'string' },
          source: { type: 'string' },
        },
        required: ['mic_id'],
        additionalProperties: true,
      },
      streamContext: true,
    },
  ],
  outputs: [
    { key: 'transcript', label: 'Transcript', primitive: 'TEXT', description: 'The running transcript of this stream session.' },
    {
      key: 'transcript_segment',
      label: 'Transcript Segment',
      primitive: 'STRUCTURED',
      description: 'One time-synced segment, carrying the client `stream` metadata back verbatim under `context`.',
      fields: {
        type: 'object',
        properties: {
          text: { type: 'string' },
          isFinal: { type: 'boolean' },
          startTime: { type: 'number' },
          endTime: { type: 'number' },
          utteranceIndex: { type: 'integer' },
          speakerId: { type: 'string' },
          speakerLabel: { type: 'string' },
          words: {
            type: 'array',
            items: { type: 'object', properties: { text: { type: 'string' }, start: { type: 'number' }, end: { type: 'number' } } },
          },
          sessionEpochMs: { type: 'integer' },
          context: { type: 'object' },
        },
      },
    },
  ],
};

// =============================================================================
// Schema 2 — `arcaai_consultation_scribe`
// =============================================================================

/**
 * The consultation contract ALaaS opens against (R3).
 *
 * `encounter` carries all four open-time markers, which is the whole point of the kind: it is the
 * one place a client STATES the facts HOPE otherwise had to infer — the clinician (by staff id,
 * → `UserProfile.staffId`, TASK-950), the department (by CODE: ArcaAI carries two departments
 * named "General Medicine", so `name` is not a key), the visit type (which selects the prompt)
 * and the external event id. A marker is a MAPPING declaration and never an authorization: the
 * caller is still authorized by its own credential.
 *
 * `vitals` is the NORMALISED object shape (OD-4, owner amendment 2026-09-11) rather than an
 * observation list: it is what a tenant admin binds in a prompt, an agent or a workflow node, so
 * it has to have named properties. Every property is optional — a client sends what it has, and
 * the mapping from its own vocabulary is the client's job.
 *
 * `previous_case_notes` carries `materializeAs: 'CASE_NOTE'`, so each entry additionally becomes
 * one `CASE_NOTE` context item and the existing warm-start read (`findCaseNotes()`) sees it
 * without the client having to POST the notes a second time.
 *
 * `context` is the platform-produced prompt kind, REFERENCED from `07e` rather than retyped: the
 * clinical templates bind `{{trigger.context.*}}`, and two copies of that vocabulary would
 * eventually disagree about which names a prompt may use.
 */
export const ARCAAI_CONSULTATION_SCRIBE_DEFINITION: Record<string, unknown> = {
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
      key: 'encounter',
      label: 'Encounter',
      primitive: 'STRUCTURED',
      phiClass: 'NON_PHI',
      cardinality: 'ONE',
      lifecycle: 'PRE',
      producedBy: ['CLIENT'],
      // NOT `required: true` at the KIND level: the derived trigger payload schema would then require
      // `encounter` for EVERY run, and a console-opened consultation sends no authored context at all.
      // Presence of the properties INSIDE the kind is what the client contract enforces.
      description: 'What the client states about this encounter at open: who, where, which visit, and its external id.',
      fields: {
        type: 'object',
        properties: {
          doctor_id: { type: 'string', minLength: 1, description: "The clinician's staff identifier (ALaaS consultantId)." },
          event_id: { type: 'string', minLength: 1, description: 'The external encounter/event id.' },
          department_code: { type: 'string', minLength: 1, description: 'Department code as registered in HOPE (GEN, BREN, …).' },
          department_name: { type: 'string', description: 'Display name; informational.' },
          visit_type: { type: 'string', enum: ['new-visit', 'revisit'] },
        },
        required: ['doctor_id', 'event_id', 'department_code', 'visit_type'],
      },
      userIdentity: { field: 'doctor_id' },
      department: { field: 'department_code', by: 'code' },
      visitType: { field: 'visit_type' },
      externalRef: { field: 'event_id' },
    },
    {
      key: 'vitals',
      label: 'Vitals',
      primitive: 'STRUCTURED',
      phiClass: 'PHI',
      cardinality: 'ONE',
      lifecycle: 'PRE',
      producedBy: ['CLIENT'],
      description: 'Observations recorded before the consultation, normalised. All properties optional; send what you have.',
      fields: {
        type: 'object',
        properties: {
          bloodPressure: { type: 'string', description: 'Systolic/diastolic, e.g. "128/82".' },
          heartRate: { type: 'number', description: 'Beats per minute.' },
          respiratoryRate: { type: 'number', description: 'Breaths per minute.' },
          temperature: { type: 'number', description: 'Degrees Celsius.' },
          oxygenSaturation: { type: 'number', description: 'SpO2 as a percentage.' },
          weightKg: { type: 'number' },
          heightCm: { type: 'number' },
          bmi: { type: 'number' },
          bloodGlucose: { type: 'number', description: 'mg/dL.' },
          painScore: { type: 'integer', description: '0-10.' },
          recordedAt: { type: 'string', description: 'ISO-8601 timestamp of the observation set.' },
          notes: { type: 'string' },
        },
      },
    },
    {
      key: 'previous_case_notes',
      label: 'Previous Case Notes',
      primitive: 'STRUCTURED',
      phiClass: 'PHI',
      cardinality: 'ONE',
      lifecycle: 'PRE',
      producedBy: ['CLIENT'],
      description: "The patient's prior case notes, supplied by the client at open; each entry is also materialized as a CASE_NOTE context item.",
      fields: {
        type: 'object',
        properties: {
          notes: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                date: { type: 'string' },
                department: { type: 'string' },
                doctor: { type: 'string' },
                title: { type: 'string' },
                text: { type: 'string' },
              },
              required: ['text'],
            },
          },
        },
        required: ['notes'],
      },
      materializeAs: 'CASE_NOTE',
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
      description:
        'Clinical case notes contributed during or around the consultation (kept from consultation_note_context so a client naming kindKey case_note stays valid).',
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
  outputs: [
    { key: 'case_note', label: 'Case Note', primitive: 'TEXT', description: 'The finalized case note the consultation workflow produces.' },
    { key: 'soap_note', label: 'SOAP Note', primitive: 'TEXT', description: 'The clinical note produced by the documentation harness.' },
  ],
};

// =============================================================================
// Rows
// =============================================================================

interface ArcaaiSchemaSeed {
  id: string;
  versionId: string;
  slug: string;
  name: string;
  description: string;
  isDefault: boolean;
  definition: Record<string, unknown>;
  changeReason: string;
}

const SCHEMA_SEEDS: ArcaaiSchemaSeed[] = [
  {
    id: SEED_ARCAAI_CONTEXT_SCHEMA_IDS.REALTIME_TRANSCRIPTION,
    versionId: SEED_ARCAAI_CONTEXT_SCHEMA_VERSION_IDS.REALTIME_TRANSCRIPTION,
    slug: ARCAAI_REALTIME_TRANSCRIPTION_SLUG,
    name: 'Realtime Transcription',
    description:
      'The standalone realtime-transcription contract: one audio stream plus the client-owned `stream` metadata (the live microphone id, speaker label) that every time-synced transcript segment of the session hands back verbatim — the object in force over its audio, with its exact bounds.',
    // NOT the tenant default: this schema governs standalone STT sessions, not consultations.
    // A DEFAULT would be what discovery serves for a consultation that names no schema.
    isDefault: false,
    definition: ARCAAI_REALTIME_TRANSCRIPTION_DEFINITION,
    changeReason: 'The ArcaAI standalone realtime-transcription contract (TASK-951 R2).',
  },
  {
    id: SEED_ARCAAI_CONTEXT_SCHEMA_IDS.CONSULTATION_SCRIBE,
    versionId: SEED_ARCAAI_CONTEXT_SCHEMA_VERSION_IDS.CONSULTATION_SCRIBE,
    slug: ARCAAI_CONSULTATION_SCRIBE_SLUG,
    name: 'Consultation Scribe',
    description:
      'The ArcaAI consultation contract: what the client states at open (clinician staff id, external event id, department code, visit type, vitals, previous case notes), the live audio, work notes and attachments, and the platform-produced prompt context the clinical templates bind.',
    isDefault: true,
    definition: ARCAAI_CONSULTATION_SCRIBE_DEFINITION,
    changeReason: 'The ArcaAI consultation scribe contract (TASK-951 R1/R3).',
  },
];

export const ARCAAI_TWO_CONTEXT_SCHEMAS = SCHEMA_SEEDS.map((seed) => ({
  id: seed.id,
  tenantId: ARCAAI,
  slug: seed.slug,
  name: seed.name,
  description: seed.description,
  scope: 'TENANT' as const,
  departmentId: null as string | null,
  status: 'PUBLISHED' as const,
  pinnedVersionNumber: 1,
  isDefault: seed.isDefault,
  // AUTHORED for this tenant, not cloned: no `sourceTemplateSlug`, and never `templateLocked`
  // (a reference-set resync must not overwrite a contract ALaaS integrates against).
  sourceTemplateSlug: null as string | null,
  templateLocked: false,
  resourceStatus: 'ENABLED' as const,
  createdBy: SYSTEM_USER_ID,
}));

export const ARCAAI_TWO_CONTEXT_SCHEMA_VERSIONS = SCHEMA_SEEDS.map((seed) => ({
  id: seed.versionId,
  tenantId: ARCAAI,
  schemaId: seed.id,
  versionNumber: 1,
  definition: seed.definition,
  checksum: definitionChecksum(seed.definition),
  changeReason: seed.changeReason,
  createdBy: SYSTEM_USER_ID,
}));

/**
 * Seed copy of `openBindingsFromDefinition` (`@arcaai/applications`, lane B). The database package
 * cannot import the applications layer, so the open-time ROLE markers are read here the same way
 * — and `task-951-arcaai-two-schemas.test.ts` pins this copy against the real function for both
 * definitions, exactly as it already does for `payloadSchemaFromDefinition`. Keys are ABSENT when
 * unset (never `null`, never `[]`): the result is frozen into a checksummed artifact.
 */
export interface SeedOpenBindings {
  userIdentity?: { kindKey: string; field: string };
  department?: { kindKey: string; field: string; by: 'code' | 'name' };
  visitType?: { kindKey: string; field: string };
  externalRef?: { kindKey: string; field: string };
  streamContext?: { kindKey: string };
  materialize?: { kindKey: string; as: 'CASE_NOTE' }[];
}

const isSeedRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

const seedMarkedField = (marker: unknown): string | null =>
  isSeedRecord(marker) && typeof marker.field === 'string' && marker.field.length > 0 ? marker.field : null;

export function openBindingsFromDefinition(definition: unknown): SeedOpenBindings {
  const bindings: SeedOpenBindings = {};
  if (!isSeedRecord(definition) || !Array.isArray(definition.kinds)) return bindings;

  const materialize: { kindKey: string; as: 'CASE_NOTE' }[] = [];
  for (const kind of definition.kinds) {
    if (!isSeedRecord(kind) || typeof kind.key !== 'string' || kind.key.length === 0) continue;
    const kindKey = kind.key;

    const userIdentityField = seedMarkedField(kind.userIdentity);
    if (userIdentityField !== null && bindings.userIdentity === undefined) bindings.userIdentity = { kindKey, field: userIdentityField };

    const departmentField = seedMarkedField(kind.department);
    const by = isSeedRecord(kind.department) ? kind.department.by : undefined;
    if (departmentField !== null && (by === 'code' || by === 'name') && bindings.department === undefined) {
      bindings.department = { kindKey, field: departmentField, by };
    }

    const visitTypeField = seedMarkedField(kind.visitType);
    if (visitTypeField !== null && bindings.visitType === undefined) bindings.visitType = { kindKey, field: visitTypeField };

    const externalRefField = seedMarkedField(kind.externalRef);
    if (externalRefField !== null && bindings.externalRef === undefined) bindings.externalRef = { kindKey, field: externalRefField };

    if (kind.streamContext === true && bindings.streamContext === undefined) bindings.streamContext = { kindKey };

    if (kind.materializeAs === 'CASE_NOTE') materialize.push({ kindKey, as: 'CASE_NOTE' });
  }
  if (materialize.length > 0) bindings.materialize = materialize;
  return bindings;
}

/** Key-order-independent JSON, so a blob read back from `jsonb` (which reorders keys) compares by CONTENT. */
const stableJson = (value: unknown): string =>
  JSON.stringify(value, (_key, inner: unknown) =>
    isSeedRecord(inner)
      ? Object.fromEntries(
          Object.keys(inner)
            .sort()
            .map((k) => [k, inner[k]]),
        )
      : inner,
  );

/**
 * What `AgentService.resolveContextSchema` freezes into `compiledConfig.contextSchema` at publish,
 * reproduced for the seeded ASR agent.
 *
 * The runtime NEVER re-reads the schema row (TASK-859 invariant 4), so a seeded binding that set
 * only `Agent.contextSchemaId` would leave the agent pinning a schema its compiled artifact does
 * not carry — which is exactly the state a publish exists to prevent. `userIdentity` is OMITTED
 * because `arcaai_realtime_transcription` declares no identity field; `resolveReference` omits the
 * key in that case rather than stamping `null`, so the frozen bytes match a real publish.
 * `openBindings` is PRESENT for the same reason in reverse: the definition declares a
 * `streamContext` kind, and a publish freezes every declared open-time role.
 */
export const ARCAAI_REALTIME_TRANSCRIPTION_FROZEN_CONTEXT_SCHEMA: Record<string, unknown> = {
  schemaId: SEED_ARCAAI_CONTEXT_SCHEMA_IDS.REALTIME_TRANSCRIPTION,
  versionNumber: 1,
  versionId: SEED_ARCAAI_CONTEXT_SCHEMA_VERSION_IDS.REALTIME_TRANSCRIPTION,
  payloadSchema: payloadSchemaFromDefinition(ARCAAI_REALTIME_TRANSCRIPTION_DEFINITION),
  // Present ONLY when non-empty, exactly as `ConsultationContextSchemaService.resolveReference`
  // spreads it. For this schema it is never empty: the `stream` kind carries `streamContext: true`,
  // and this key is how that marker reaches the runtime — `resolveStreamMetadataSchema` reads
  // `openBindings.streamContext.kindKey` off the FROZEN artifact to find the schema a `metadata`
  // frame is validated against. A blob without it leaves the gate accepting any object.
  ...(Object.keys(openBindingsFromDefinition(ARCAAI_REALTIME_TRANSCRIPTION_DEFINITION)).length > 0
    ? { openBindings: openBindingsFromDefinition(ARCAAI_REALTIME_TRANSCRIPTION_DEFINITION) }
    : {}),
};

// =============================================================================
// Seeding
// =============================================================================

/** Demote ArcaAI's phase-26 clone of `consultation_note_context` so the scribe is the one default. */
async function demoteNoteContextClone(client: CorePrismaClient): Promise<number> {
  const { count } = await client.consultationContextSchema.updateMany({
    where: { tenantId: ARCAAI, slug: NOTE_CONTEXT_SCHEMA_SLUG, isDefault: true },
    data: { isDefault: false, updatedBy: SYSTEM_USER_ID },
  });
  return count;
}

/** Soft-retire the two `07f` DEPARTMENT-scoped rows (OD-9). Never hard-deleted: a version row is history. */
async function retireDepartmentSchemas(client: CorePrismaClient): Promise<number> {
  const { count } = await client.consultationContextSchema.updateMany({
    where: { tenantId: ARCAAI, slug: { in: [...ARCAAI_RETIRED_DEPARTMENT_SCHEMA_SLUGS] }, resourceStatus: { not: 'DELETED' } },
    data: {
      resourceStatus: 'DELETED',
      isDefault: false,
      resourceStatusUpdatedAt: new Date(),
      resourceStatusUpdatedBy: SYSTEM_USER_ID,
      updatedBy: SYSTEM_USER_ID,
    },
  });
  return count;
}

/**
 * Bind ArcaAI's `realtime-transcription` agent to the transcription schema, and freeze the
 * resolution into its compiled artifact.
 *
 * An agent whose `contextSchemaId` is still NULL is bound — phase 26 clones it that way
 * deliberately ("a context pin cannot travel by id"). A tenant admin who has since pinned
 * something ELSE keeps their choice. An agent pinning THIS seed's schema is RE-FROZEN when the
 * seed's blob no longer matches the artifact: the runtime never re-reads the schema row
 * (TASK-859 invariant 4), so a definition change under this ticket that stopped at the version
 * row would leave the gateway validating `metadata` frames against the shape it replaced.
 */
async function bindTranscriptionAgent(client: CorePrismaClient): Promise<'bound' | 'refrozen' | 'already-bound' | 'absent'> {
  // The SERVABLE row, resolved the way `AgentAssignmentService` resolves it (slug + task +
  // PUBLISHED + active), newest version first — not merely "a row with this slug".
  const agent = await client.agent.findFirst({
    where: { tenantId: ARCAAI, slug: ASR_AGENT_SLUG, task: 'SPEECH_TO_TEXT', status: 'PUBLISHED', isActive: true, resourceStatus: 'ENABLED' },
    orderBy: { versionNumber: 'desc' },
    select: { id: true, contextSchemaId: true, compiledConfig: true },
  });
  if (!agent) return 'absent';

  const compiled = (agent.compiledConfig ?? null) as unknown as Record<string, unknown> | null;
  const nextCompiled = compiled === null ? null : { ...compiled, contextSchema: ARCAAI_REALTIME_TRANSCRIPTION_FROZEN_CONTEXT_SCHEMA };

  if (agent.contextSchemaId !== null) {
    const ours = agent.contextSchemaId === SEED_ARCAAI_CONTEXT_SCHEMA_IDS.REALTIME_TRANSCRIPTION;
    if (!ours || compiled === null || nextCompiled === null) return 'already-bound';
    if (stableJson(compiled.contextSchema) === stableJson(ARCAAI_REALTIME_TRANSCRIPTION_FROZEN_CONTEXT_SCHEMA)) return 'already-bound';
    await client.agent.update({
      where: { id: agent.id },
      data: { compiledConfig: nextCompiled as never, compiledConfigChecksum: checksumOf(nextCompiled), updatedBy: SYSTEM_USER_ID },
    });
    return 'refrozen';
  }

  await client.agent.update({
    where: { id: agent.id },
    data: {
      contextSchemaId: SEED_ARCAAI_CONTEXT_SCHEMA_IDS.REALTIME_TRANSCRIPTION,
      contextSchemaVersionNumber: 1,
      ...(nextCompiled === null ? {} : { compiledConfig: nextCompiled as never, compiledConfigChecksum: checksumOf(nextCompiled) }),
      updatedBy: SYSTEM_USER_ID,
    },
  });
  return 'bound';
}

export const seedArcaaiTwoContextSchemas = async (client: CorePrismaClient) => {
  console.log('Seeding the two ArcaAI consultation context schemas (TASK-951) ...');

  // SWEEP FIRST, then create: the scribe is written `isDefault: true`, and ArcaAI's clone of
  // `consultation_note_context` holds that flag until it is demoted. Doing it the other way round
  // leaves two tenant defaults for the length of one statement, and discovery would resolve
  // whichever the query happened to order first.
  const demoted = await demoteNoteContextClone(client);
  const retired = await retireDepartmentSchemas(client);

  let created = 0;
  let skipped = 0;
  let refreshed = 0;
  for (const [index, schema] of ARCAAI_TWO_CONTEXT_SCHEMAS.entries()) {
    const version = ARCAAI_TWO_CONTEXT_SCHEMA_VERSIONS[index];
    if (!version) throw new Error(`Missing ArcaAI context schema version for ${schema.id}`);

    // CREATE-ONLY on the row's own id and on the model's unique `(tenantId, slug)`. NOT on
    // "any other TENANT default" (07e's second condition): for ArcaAI that is always true, so it
    // would refuse to ever create the scribe. See the module docstring.
    const existing = await client.consultationContextSchema.findFirst({
      where: { tenantId: schema.tenantId, OR: [{ id: schema.id }, { slug: schema.slug }] },
      select: { id: true },
    });
    if (existing) {
      skipped += 1;
      // A row the SEED owns (matched by our id, not merely by slug) keeps its v1 definition in step
      // with this file: the contract is what this ticket ships, and a dev database seeded before a
      // definition change would otherwise advertise one shape while the agent enforces another.
      // An operator-authored row with our slug is never touched.
      if (existing.id === schema.id) {
        const current = await client.consultationContextSchemaVersion.findFirst({
          where: { schemaId: schema.id, versionNumber: 1 },
          select: { id: true, checksum: true },
        });
        if (current && current.checksum !== version.checksum) {
          await client.consultationContextSchemaVersion.updateMany({
            where: { id: current.id },
            // An immutable-by-design row (no `updatedBy`/`updatedAt`): the rewrite is a seed-owned correction, and
            // `_version` is bumped so an OCC reader sees that the content moved.
            data: { definition: version.definition as never, checksum: version.checksum, version: { increment: 1 } },
          });
          refreshed += 1;
        }
      }
      continue;
    }

    await client.consultationContextSchema.create({ data: schema });
    await client.consultationContextSchemaVersion.create({ data: { ...version, definition: version.definition as never } });
    created += 1;
  }

  const agent = await bindTranscriptionAgent(client);

  console.log(`  ✓ ArcaAI context schemas: ${created} created, ${skipped} already present (${refreshed} v1 definition(s) refreshed)`);
  console.log(`  ✓ Retirement sweep: ${demoted} note-context clone demoted, ${retired} department schema(s) soft-retired`);
  console.log(`  ✓ ${ASR_AGENT_SLUG} agent: ${agent}`);

  return { created, skipped, refreshed, demoted, retired, agent };
};
