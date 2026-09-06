/**
 * TASK-890 §3.4 — the LEGACY BRIDGE: the SYSTEM reference schema that gives the v1
 * consultation prompt vocabulary a real, tenant-owned declaration.
 *
 * ## What this fixes
 *
 * `PromptAssemblyService.buildVariables` populates a fixed set of names — the five
 * consultation variables, v1's nine pre-summary placeholders, the carried pre-summary and
 * prior-visit text, and the doctor's DNA writing style — and until now that set existed ONLY
 * as a list in TypeScript. Nothing declared it, so nothing could check a prompt against it:
 * `{{context.clinician_notes}}` and `{{context.clinician_note}}` were equally valid at
 * authoring time and differently valid at 3am in a live consultation.
 *
 * Declaring the same names as a context schema makes them checkable at PUBLISH time by the
 * one gate that decides (`publishFindings`), and — because the derived payload schema is
 * frozen into the compiled artifact — validatable at run time without a database read.
 *
 * ## Why it is a SYSTEM row that gets CLONED, not a shared one (OD-H)
 *
 * Context schemas are CONTENT: they are cloned into a tenant at provisioning and are never
 * read from SYSTEM at run time (`ConsultationContextSchema` is deliberately absent from
 * `SYSTEM_SHARED_READ_MODELS`). This row is therefore a REFERENCE row — the source
 * `TenantReferenceSetService.provision` copies — and no tenant ever resolves it directly.
 * `PromptAssemblyService` reads the TENANT's clone, found by `sourceTemplateSlug`.
 *
 * ## Two deliberate choices worth reading
 *
 * `isDefault: false`. This is a COMPATIBILITY vocabulary for the legacy prompt path, not the
 * consultation vocabulary a tenant's clinicians work in — `07e`'s `consultation_default` is
 * that. Cloning it as a default would silently demote whatever default the tenant already
 * has (the clone path honours the one-default rule by demoting), which is a real change to a
 * live tenant made as a side effect of a compatibility bridge.
 *
 * The kind's `fields` is deliberately OPEN (no `additionalProperties: false`). The VALUES are
 * produced by code (`buildVariables`), so a closed schema would turn the next variable that
 * code learns to populate into a validation failure inside a consultation — the bridge would
 * become a second gate that can fail the thing it exists to support.
 *
 * ## Idempotency
 *
 * CREATE-ONLY on the row's own id, like every sibling in this phase. A re-seed never reverts
 * a deliberate platform-admin edit.
 */
import type { CorePrismaClient } from '../../../client';
import { SYSTEM_TENANT_ID, SYSTEM_USER_ID } from './00-constants';
import { definitionChecksum } from './07e-consultation-loop-defaults';

/**
 * The bridge schema's slug.
 *
 * UNDERSCORES, not hyphens: a context-schema slug is validated against
 * `CONTEXT_KIND_KEY_PATTERN` (`^[a-z0-9_]{2,48}$`) by the create DTO, so a hyphenated slug
 * could not be authored through the API and the clone path — which goes through `create()` —
 * would refuse it. The mirror constant consumers should import is
 * `LEGACY_CONTEXT_SCHEMA_SLUG` in
 * `packages/applications/src/services/consultation-context-schema/context-schema-definition.ts`;
 * it is re-declared here only because `packages/database` does not depend on that package.
 */
export const LEGACY_CONTEXT_SCHEMA_SLUG = 'consultation_legacy_v1';

/** The kind key the legacy variables live under. */
export const LEGACY_CONTEXT_KIND_KEY = 'context';

/**
 * Every name `PromptAssemblyService.buildVariables` can populate, in the order that method
 * builds them: the five always-defined consultation variables, v1's nine pre-summary
 * placeholders (`PRE_SUMMARY_TEMPLATE_VARIABLES`), the two carried texts, the resolved DNA
 * style, and the eleven per-department `style_DNA_*` slots a template may declare.
 *
 * All strings: the value builders serialise entities, note blocks and attachments to text
 * before they reach a prompt.
 */
export const LEGACY_CONTEXT_VARIABLE_NAMES: readonly string[] = [
  'conversation_language',
  'ner_entities',
  'clinician_notes',
  'attachments',
  'doctor_highlights',
  'current_department',
  'visit_type',
  'safe_age',
  'safe_dob',
  'safe_gender',
  'safe_vitals',
  'formatted_test_results',
  'formatted_previous_visits',
  'language_name',
  'pre_summary_text',
  'prior_visit_summary',
  'dna_style_text',
  'style_DNA_doctor_department_surgery',
  'style_DNA_doctor_department_medicine',
  'style_DNA_doctor_department_neurology',
  'style_DNA_doctor_department_orthopedics',
  'style_DNA_doctor_department_hematology',
  'style_DNA_doctor_department_rheumatology',
  'style_DNA_doctor_department_dermatology',
  'style_DNA_doctor_department_dietetics',
  'style_DNA_doctor_department_nephrology',
  'style_DNA_doctor_department_surgical_oncology',
  'style_DNA_doctor_department_breast_endocrine',
];

const LEGACY_FIELD_PROPERTIES: Record<string, { type: 'string'; description: string }> = Object.fromEntries(
  LEGACY_CONTEXT_VARIABLE_NAMES.map((name) => [name, { type: 'string' as const, description: describe(name) }]),
);

export const LEGACY_CONTEXT_SCHEMA_DEFINITION: Record<string, unknown> = {
  schemaVersion: '1.0',
  kinds: [
    {
      key: LEGACY_CONTEXT_KIND_KEY,
      label: 'Legacy Prompt Context',
      primitive: 'STRUCTURED',
      phiClass: 'PHI',
      cardinality: 'ONE',
      lifecycle: 'ANY',
      producedBy: ['SYSTEM'],
      description:
        'The v1 consultation prompt vocabulary, declared so a prompt referencing it can be checked at publish time. Populated by the platform from the consultation, never supplied by a client.',
      fields: {
        type: 'object',
        properties: LEGACY_FIELD_PROPERTIES,
      },
    },
  ],
};

const LEGACY_SCHEMA_ID = '79000000-0000-0000-0000-000000000090';
const LEGACY_VERSION_ID = '89000000-0000-0000-0000-000000000090';

export const LEGACY_CONTEXT_SCHEMA = {
  id: LEGACY_SCHEMA_ID,
  tenantId: SYSTEM_TENANT_ID,
  slug: LEGACY_CONTEXT_SCHEMA_SLUG,
  name: 'Legacy consultation prompt context',
  description:
    "The v1 consultation prompt vocabulary as a declared context schema. Cloned into every tenant by the reference set; the tenant's own copy is what the prompt path resolves.",
  scope: 'TENANT' as const,
  departmentId: null,
  status: 'PUBLISHED' as const,
  pinnedVersionNumber: 1,
  // NOT the tenant's default — see the module docstring.
  isDefault: false,
  sourceTemplateSlug: null as string | null,
  templateLocked: false,
  resourceStatus: 'ENABLED' as const,
  createdBy: SYSTEM_USER_ID,
};

export const LEGACY_CONTEXT_SCHEMA_VERSION = {
  id: LEGACY_VERSION_ID,
  tenantId: SYSTEM_TENANT_ID,
  schemaId: LEGACY_SCHEMA_ID,
  versionNumber: 1,
  definition: LEGACY_CONTEXT_SCHEMA_DEFINITION,
  checksum: definitionChecksum(LEGACY_CONTEXT_SCHEMA_DEFINITION),
  changeReason: 'The v1 consultation prompt vocabulary, declared (TASK-890 §3.4)',
  createdBy: SYSTEM_USER_ID,
};

export const seedConsultationLegacyContextSchema = async (client: CorePrismaClient) => {
  console.log('Seeding the legacy consultation context schema (SYSTEM reference) ...');

  const existing = await client.consultationContextSchema.findFirst({
    where: { id: LEGACY_SCHEMA_ID },
    select: { id: true },
  });
  if (existing) {
    console.log('  ✓ Legacy consultation context schema: already present, left untouched');
    return;
  }

  await client.consultationContextSchema.create({ data: LEGACY_CONTEXT_SCHEMA });
  await client.consultationContextSchemaVersion.create({
    data: { ...LEGACY_CONTEXT_SCHEMA_VERSION, definition: LEGACY_CONTEXT_SCHEMA_VERSION.definition as never },
  });

  console.log(`  ✓ Legacy consultation context schema: created with ${LEGACY_CONTEXT_VARIABLE_NAMES.length} declared variables`);
};

/** One sentence per variable, so the console's picker is legible without reading this file. */
function describe(name: string): string {
  if (name.startsWith('style_DNA_doctor_department_')) {
    const department = name.slice('style_DNA_doctor_department_'.length).replace(/_/g, ' ');
    return `The doctor's DNA writing style, substituted into the ${department} slot when the template declares it.`;
  }
  const descriptions: Record<string, string> = {
    conversation_language: 'The consultation language code (`en`, `ml`).',
    ner_entities: 'Medical entities extracted from the transcript, serialised; empty when none.',
    clinician_notes: "The clinician's own working notes for this consultation.",
    attachments: 'Text extracted from the consultation attachments.',
    doctor_highlights: 'Passages the clinician highlighted during the consultation.',
    current_department: "The consultation's department name; `General` when unknown.",
    visit_type: 'The visit type; `Medical examination` when unknown.',
    safe_age: 'Patient age, or `Unknown`.',
    safe_dob: 'Patient date of birth, or `Unknown`.',
    safe_gender: 'Patient gender, or `Unknown`.',
    safe_vitals: 'Recorded vitals, or `Not available`.',
    formatted_test_results: 'Test results as text; empty when none.',
    formatted_previous_visits: 'Previous-visit summaries as text; empty when none.',
    language_name: 'The consultation language by NAME (`English`, `Malayalam`).',
    pre_summary_text: 'The pre-summary this generation builds on.',
    prior_visit_summary: "The carried summary of the patient's previous visit, bounded.",
    dna_style_text: "The doctor's resolved DNA writing style.",
  };
  return descriptions[name] ?? 'A legacy consultation prompt variable.';
}
