/**
 * TASK-798 W3 — per-department consultation context vocabularies for ArcaAI.
 *
 * ## What was missing, and why it mattered
 *
 * "The department and the clinician's writing style change the output" is a requirement, and three
 * of the four axes that decide it were already seeded:
 *
 *   - per-department `PromptTemplate` + approved `PromptVersion` (v3) — `07b`;
 *   - per-doctor `DnaWritingStyleReport` + version — `08`;
 *   - a `DepartmentAgent` per department binding them — `07a`.
 *
 * The fourth was not. `07e` seeds exactly ONE TENANT-scoped `ConsultationContextSchema` per tenant,
 * so every ArcaAI department shared a single vocabulary — audio, work note, case note, attachment,
 * out to one SOAP note. With nothing varying per department, "the department changes the note" was
 * a claim with no row behind it.
 *
 * These two DEPARTMENT-scoped schemas supply the contrast, and it is a clinically real one rather
 * than a renamed field: General Medicine anchors on VITALS and emits a problem list; Rheumatology
 * anchors on JOINT COUNTS and INFLAMMATORY MARKERS and emits a disease-activity summary. Both are
 * visible in `/context-schemas` and in the section headings of the note each department produces.
 *
 * ## Scope interaction — why `isDefault: true` on both is correct
 *
 * `isDefault` is unique per `(tenantId, scope, departmentId)`, not per tenant. A DEPARTMENT-scoped
 * default therefore does not collide with the TENANT-scoped default `07e` seeds; it SHADOWS it for
 * that department, which is exactly the discovery behaviour the model documents. The tenant default
 * keeps serving every department that has no schema of its own.
 *
 * ## Idempotency
 *
 * CREATE-ONLY on two conditions — the row's own id, and any OTHER default at the same
 * `(tenant, scope, departmentId)`. The second check is the application-layer "at most one default"
 * rule, which the database cannot express (it needs a partial unique index over ENABLED rows only),
 * so the seed honours it explicitly. Generalised unchanged from `07e`'s guard, which applies the
 * same rule at TENANT scope. A re-seed never reverts a tenant admin's own edit.
 */
import type { CorePrismaClient } from '../../../client';
import { SEED_CUSTOMER_TENANT_IDS, SEED_DEPARTMENT_IDS, SEED_USER_IDS } from './00-constants';
import { definitionChecksum } from './07e-consultation-loop-defaults';

const ARCAAI = SEED_CUSTOMER_TENANT_IDS.ARCAAI;

/**
 * Shared kinds. Every department still captures audio, working notes and attachments — the
 * contrast between the two vocabularies must be the CLINICAL part, not an arbitrary reshuffle of
 * the plumbing.
 */
const COMMON_KINDS = [
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
    key: 'attachment',
    label: 'Attachment',
    primitive: 'DOCUMENT',
    phiClass: 'PHI',
    cardinality: 'MANY',
    lifecycle: 'ANY',
    producedBy: ['CLIENT'],
    description: 'A document attached to the consultation; its text is extracted before use.',
  },
];

/**
 * `fields` on a STRUCTURED kind is an AUTHORABLE JSON SCHEMA (validated by
 * `authorableJsonSchemaProblems`), not a flat `name -> type` map. Getting that wrong produces a
 * definition the service would reject at publish — i.e. a row no tenant admin could have authored.
 */
const GEN_DEFINITION: Record<string, unknown> = {
  schemaVersion: '1.0',
  kinds: [
    ...COMMON_KINDS,
    {
      key: 'vitals',
      label: 'Vitals',
      primitive: 'STRUCTURED',
      phiClass: 'PHI',
      cardinality: 'ONE',
      lifecycle: 'PRE',
      producedBy: ['CLIENT'],
      description: 'Observations recorded before the consultation begins.',
      fields: {
        type: 'object',
        properties: {
          bloodPressure: { type: 'string', description: 'Systolic/diastolic, e.g. "128/82".' },
          heartRate: { type: 'number', description: 'Beats per minute.' },
          temperature: { type: 'number', description: 'Degrees Celsius.' },
          oxygenSaturation: { type: 'number', description: 'SpO2 as a percentage.' },
        },
        required: ['bloodPressure', 'heartRate'],
      },
    },
  ],
  outputs: [
    { key: 'soap_note', label: 'SOAP Note', primitive: 'TEXT', description: 'The clinical note produced by the documentation harness.' },
    { key: 'problem_list', label: 'Problem List', primitive: 'TEXT', description: 'Active problems identified during the consultation.' },
  ],
};

const RHEUM_DEFINITION: Record<string, unknown> = {
  schemaVersion: '1.0',
  kinds: [
    ...COMMON_KINDS,
    {
      key: 'joint_count',
      label: 'Joint Count',
      primitive: 'STRUCTURED',
      phiClass: 'PHI',
      cardinality: 'ONE',
      lifecycle: 'PRE',
      producedBy: ['CLIENT'],
      description: 'Tender and swollen joint counts, and the composite disease-activity score.',
      fields: {
        type: 'object',
        properties: {
          tenderJoints: { type: 'number', description: 'Tender joint count (0-28).' },
          swollenJoints: { type: 'number', description: 'Swollen joint count (0-28).' },
          das28: { type: 'number', description: 'DAS28 composite disease-activity score.' },
        },
        required: ['tenderJoints', 'swollenJoints'],
      },
    },
    {
      key: 'inflammatory_markers',
      label: 'Inflammatory Markers',
      primitive: 'STRUCTURED',
      phiClass: 'PHI',
      cardinality: 'ONE',
      lifecycle: 'PRE',
      producedBy: ['CLIENT'],
      description: 'Laboratory inflammatory markers available at the time of the consultation.',
      fields: {
        type: 'object',
        properties: {
          esr: { type: 'number', description: 'Erythrocyte sedimentation rate, mm/hr.' },
          crp: { type: 'number', description: 'C-reactive protein, mg/L.' },
        },
      },
    },
  ],
  outputs: [
    { key: 'soap_note', label: 'SOAP Note', primitive: 'TEXT', description: 'The clinical note produced by the documentation harness.' },
    {
      key: 'disease_activity',
      label: 'Disease Activity',
      primitive: 'TEXT',
      description: 'The disease-activity assessment and its trajectory since the last visit.',
    },
  ],
};

interface DepartmentSchemaSeed {
  id: string;
  versionId: string;
  slug: string;
  name: string;
  description: string;
  departmentId: string;
  definition: Record<string, unknown>;
  changeReason: string;
}

const DEPARTMENT_SCHEMAS: DepartmentSchemaSeed[] = [
  {
    id: '79000000-0000-0000-0001-000000000010',
    versionId: '89000000-0000-0000-0001-000000000010',
    slug: 'consultation_gen_arcaai',
    name: 'General Medicine Consultation Context',
    description: 'General Medicine consultation vocabulary: audio, working notes, attachments and pre-visit vitals, producing a SOAP note and a problem list.',
    departmentId: SEED_DEPARTMENT_IDS.GEN_ARCAAI,
    definition: GEN_DEFINITION,
    changeReason: 'Department-scoped consultation context vocabulary for General Medicine (TASK-798).',
  },
  {
    id: '79000000-0000-0000-0001-000000000011',
    versionId: '89000000-0000-0000-0001-000000000011',
    slug: 'consultation_rheum_arcaai',
    name: 'Rheumatology Consultation Context',
    description:
      'Rheumatology consultation vocabulary: audio, working notes, attachments, joint counts and inflammatory markers, producing a SOAP note and a disease-activity assessment.',
    departmentId: SEED_DEPARTMENT_IDS.RHEUM_ARCAAI,
    definition: RHEUM_DEFINITION,
    changeReason: 'Department-scoped consultation context vocabulary for Rheumatology (TASK-798).',
  },
];

export const ARCAAI_DEPARTMENT_CONTEXT_SCHEMAS = DEPARTMENT_SCHEMAS.map((schema) => ({
  id: schema.id,
  tenantId: ARCAAI,
  slug: schema.slug,
  name: schema.name,
  description: schema.description,
  scope: 'DEPARTMENT' as const,
  departmentId: schema.departmentId,
  status: 'PUBLISHED' as const,
  pinnedVersionNumber: 1,
  isDefault: true,
  sourceTemplateSlug: null as string | null,
  templateLocked: false,
  resourceStatus: 'ENABLED' as const,
  definition: schema.definition,
  createdBy: SEED_USER_IDS.ARCAAI_ADMIN,
}));

export const ARCAAI_DEPARTMENT_CONTEXT_SCHEMA_VERSIONS = DEPARTMENT_SCHEMAS.map((schema) => ({
  id: schema.versionId,
  tenantId: ARCAAI,
  schemaId: schema.id,
  versionNumber: 1,
  definition: schema.definition,
  checksum: definitionChecksum(schema.definition),
  changeReason: schema.changeReason,
  createdBy: SEED_USER_IDS.ARCAAI_ADMIN,
}));

export const seedArcaaiDepartmentContextSchemas = async (client: CorePrismaClient) => {
  console.log('Seeding ArcaAI department consultation context schemas (TASK-798)...');

  let created = 0;
  let skipped = 0;

  for (const [index, schema] of ARCAAI_DEPARTMENT_CONTEXT_SCHEMAS.entries()) {
    const version = ARCAAI_DEPARTMENT_CONTEXT_SCHEMA_VERSIONS[index];
    if (!version) throw new Error(`Missing context schema version for ${schema.id}`);

    // CREATE-ONLY on TWO conditions — see the module docstring.
    const existing = await client.consultationContextSchema.findFirst({
      where: {
        tenantId: schema.tenantId,
        OR: [{ id: schema.id }, { scope: 'DEPARTMENT', departmentId: schema.departmentId, isDefault: true, resourceStatus: 'ENABLED' }],
      },
      select: { id: true },
    });
    if (existing) {
      skipped += 1;
      continue;
    }

    // `definition` lives on the VERSION, not the schema row; it travels on the seed object only so
    // the two stay legibly together in this file.
    const { definition: _definition, ...schemaRow } = schema;
    await client.consultationContextSchema.create({ data: schemaRow });
    await client.consultationContextSchemaVersion.create({ data: { ...version, definition: version.definition as never } });
    created += 1;
  }

  console.log(`  ✓ Department context schemas: ${created} created, ${skipped} skipped`);
};
