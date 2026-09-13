/**
 * TASK-930 §8.5 — the ArcaAI tenant's agents and workflows, GENERATED from a table, not hand-written.
 *
 * For each of the 11 ArcaAI clinical departments (`04-department.ts`) × {`new-visit`, `revisit`}:
 * one TEXT_GENERATION agent `arcaai-<dept>-summary-<visit>` on gemma, guards ON, bound to that
 * department's v3 clinical template (`07b`, pinned at `ARCAAI_CLINICAL_APPROVED_VERSION`). For
 * each department: one workflow `arcaai-<dept>-consultation` = the §8.4 consultation graph with
 * the per-turn summary step replaced by a `core.condition` on `{{trigger.context.visit_type}}`
 * fanning out to the department's two agents (`else` → new-visit). DEPARTMENT-scope
 * `WorkflowAssignment` rows for all 11 and a TENANT-scope default → `arcaai-gen-consultation`.
 *
 * ArcaAI additionally receives the SYSTEM set through phase 26 (`realtime-transcription`,
 * `medical-ner`, `casenote-finalization`, `text-to-speech`, `general-medicine-summarization`,
 * the two library workflows, the schema, the templates). The graphs here reference those agents
 * by SLUG only — the lineage key resolves at run time, so seed ORDER is not a dependency.
 *
 * `instruction.variables` is ABSENT on the department agents on purpose: the v3 department bodies
 * declare no variables and carry no `{{…}}` placeholder (`07b-arcaai-clinical-content-v3.ts` —
 * only the pre-summary does), so there is nothing to bind (F6 says "every DECLARED variable").
 *
 * TASK-951 (D-10) — the trigger references `arcaai_consultation_scribe`, the tenant's OWN
 * consultation contract (`07g-arcaai-two-schemas.ts`), not its clone of
 * `consultation_note_context`. The scribe carries that clone's `context` kind verbatim, so every
 * `{{trigger.context.*}}` a graph or prompt reads resolves exactly as before; what it ADDS is the
 * `encounter` / `vitals` / `previous_case_notes` kinds a client states at open. The id is a
 * STATIC seeded constant rather than a derivation, so the reference is stable before `07g` runs
 * — phase 29 runs first, and the compiler freezes the resolved payload schema either way.
 * `createdBy` is the SYSTEM user: these rows assert no human authorship. Still excluded from
 * `safe` (`seed-mode.ts`): one customer's content is not platform configuration.
 *
 * Engine output (`graphChecksum` / `compiledConfig` / `validationReport`) lives in
 * `29-arcaai-agents-and-workflows.generated.ts`, written by `scripts/regen-workflow-seeds.ts`.
 */
import type { CorePrismaClient } from '../../../client';
import {
  SEED_ARCAAI_CONTEXT_SCHEMA_IDS,
  SEED_ARCAAI_CONTEXT_SCHEMA_VERSION_IDS,
  SEED_CUSTOMER_TENANT_IDS,
  SYSTEM_TENANT_ID,
  SYSTEM_USER_ID,
} from './00-constants';
import { ARCAAI_ALL_CLINICAL_DEPARTMENTS } from './04-department';
import { ARCAAI_CLINICAL_APPROVED_VERSION, ARCAAI_CLINICAL_TEMPLATE_IDS } from './07b-arcaai-clinical-templates';
import { noteContextSchemaIdFor, noteContextSchemaVersionIdFor } from './07e-consultation-note-context-schema';
import { ARCAAI_CONSULTATION_SCRIBE_DEFINITION } from './07g-arcaai-two-schemas';
import {
  PRE_SUMMARY_AGENT_SLUG,
  PRE_SUMMARY_PARAMETERS,
  SUMMARIZATION_PARAMETERS,
  arcaaiAgentId,
  preSummaryPromptVariables,
  seedAgentSpecs,
  type SeedAgentSpec,
  type SeedAgentsClient,
} from './25-agents';
import { cloneId } from './26-tenant-reference-set';
import { arcaaiDocumentTemplateSlug, seedArcaaiDepartmentDocumentTemplates } from './27-document-template-library';
import {
  CORE_PALETTE_KEY,
  buildConsultationGraph,
  createWorkflowDefinitions,
  definitionRow,
  generatedFor,
  workflowTargetKey,
  writeWorkflowAssignments,
  type SeedWorkflowsClient,
  type WorkflowSeedTarget,
} from './28-workflow-library';
import { ARCAAI_GENERATED, REGISTRY_CHECKSUM } from './29-arcaai-agents-and-workflows.generated';

const ARCAAI = SEED_CUSTOMER_TENANT_IDS.ARCAAI;

export const VISIT_TYPES = ['new-visit', 'revisit'] as const;
export type VisitType = (typeof VISIT_TYPES)[number];

/**
 * ArcaAI's clone of the SYSTEM `consultation_note_context` — the id phase 26 derives.
 *
 * TASK-951 demoted this row from the tenant default and UNBOUND it from the triggers below; it is
 * still exported because it is still the row `07g`'s retirement sweep demotes, and naming it by
 * derivation is the only way to identify a clone whose id nothing writes down.
 */
export const ARCAAI_NOTE_CONTEXT_SCHEMA_ID = cloneId(ARCAAI, 'context-schema', noteContextSchemaIdFor(SYSTEM_TENANT_ID));
export const ARCAAI_NOTE_CONTEXT_SCHEMA_VERSION_ID = cloneId(ARCAAI, 'context-schema-version', noteContextSchemaVersionIdFor(SYSTEM_TENANT_ID));

/** TASK-951 — what the 11 consultation triggers bind: ArcaAI's own `arcaai_consultation_scribe`. */
export const ARCAAI_SCRIBE_CONTEXT_SCHEMA_ID = SEED_ARCAAI_CONTEXT_SCHEMA_IDS.CONSULTATION_SCRIBE;
export const ARCAAI_SCRIBE_CONTEXT_SCHEMA_VERSION_ID = SEED_ARCAAI_CONTEXT_SCHEMA_VERSION_IDS.CONSULTATION_SCRIBE;

// =============================================================================
// The table
// =============================================================================

export interface ArcaaiDepartmentRow {
  ordinal: number;
  code: string;
  slugPart: string;
  name: string;
  /** The seed-time department id (`SEED_DEPARTMENT_IDS`); the persisted id is resolved by code at seed time. */
  departmentSeedId: string;
  templates: Record<VisitType, string>;
}

/** One row per ArcaAI clinical department, in `04-department.ts` order. */
export const ARCAAI_DEPARTMENT_TABLE: ArcaaiDepartmentRow[] = ARCAAI_ALL_CLINICAL_DEPARTMENTS.map((department, index) => ({
  ordinal: index + 1,
  code: department.code,
  slugPart: department.code.toLowerCase(),
  name: department.name,
  departmentSeedId: department.id,
  templates: { 'new-visit': department.newPatientPromptId, revisit: department.revisitPromptId },
}));

export const arcaaiAgentSlug = (row: ArcaaiDepartmentRow, visit: VisitType): string => `arcaai-${row.slugPart}-summary-${visit}`;
export const arcaaiWorkflowSlug = (row: ArcaaiDepartmentRow): string => `arcaai-${row.slugPart}-consultation`;

// =============================================================================
// Agents — 11 × 2
// =============================================================================

/**
 * TASK-932 D-9 — ArcaAI's OWN warm-start agent.
 *
 * The tenant carries the same lineage key as the platform (`case-notes-pre-summary`) bound to a
 * DIFFERENT body: the v3 corpus' pre-summary, which is the one the customer signed off — dated
 * provenance parentheses, event dates kept inline and unreformatted, one bullet per diagnosis,
 * status-post interventions, English-only output. Seeded HERE rather than left to phase 26,
 * because `copyAgents` skips a slug the tenant already has and this phase runs first: the tenant's
 * own body wins, and the SYSTEM copy is simply not made.
 *
 * `promptVersionNumber` tracks `ARCAAI_CLINICAL_APPROVED_VERSION` like every department agent, so
 * a corpus roll-back is one constant for the whole tenant, warm start included.
 */
export const ARCAAI_PRE_SUMMARY_AGENT_SPEC: SeedAgentSpec = {
  id: arcaaiAgentId(23),
  tenantId: ARCAAI,
  slug: PRE_SUMMARY_AGENT_SLUG,
  name: 'Case-notes pre-summary (warm start)',
  description: `The ArcaAI warm start: one pass over the patient's prior case notes on the department corpus' approved v${ARCAAI_CLINICAL_APPROVED_VERSION} pre-summary body; guardrail screening ON.`,
  task: 'TEXT_GENERATION',
  modelSlug: 'lms-gemma-4-e2b-it-qat',
  fallbackModelSlugs: [],
  instruction: {
    promptTemplateId: ARCAAI_CLINICAL_TEMPLATE_IDS.PRE_SUMMARY,
    promptVersionNumber: ARCAAI_CLINICAL_APPROVED_VERSION,
    variables: preSummaryPromptVariables(),
  },
  parameters: PRE_SUMMARY_PARAMETERS,
  outputSchema: null,
  status: 'PUBLISHED',
  isActive: true,
  tags: ['tier:tenant-authored', 'task:llm', 'capability:pre-summary', 'phase:pre-summary'],
  provenance: null,
};

export const ARCAAI_DEPARTMENT_AGENT_SPECS: SeedAgentSpec[] = ARCAAI_DEPARTMENT_TABLE.flatMap((row) =>
  VISIT_TYPES.map((visit, visitIndex): SeedAgentSpec => ({
    id: arcaaiAgentId((row.ordinal - 1) * VISIT_TYPES.length + visitIndex + 1),
    tenantId: ARCAAI,
    slug: arcaaiAgentSlug(row, visit),
    name: `${row.name} summary (${visit})`,
    description: `The per-turn ${row.name} running note for a ${visit} encounter, bound to the department's approved v${ARCAAI_CLINICAL_APPROVED_VERSION} clinical template; guardrail screening ON.`,
    task: 'TEXT_GENERATION',
    modelSlug: 'lms-gemma-4-e2b-it-qat',
    fallbackModelSlugs: [],
    // The agent's pin outranks the template's `approvedVersionNumber` in the resolver, so it must
    // be the template's OWN approved version (v4 for Breast & Endocrine, v3 elsewhere).
    instruction: { promptTemplateId: row.templates[visit], promptVersionNumber: ARCAAI_CLINICAL_APPROVED_VERSION },
    parameters: SUMMARIZATION_PARAMETERS,
    outputSchema: null,
    status: 'PUBLISHED',
    isActive: true,
    tags: ['tier:tenant-authored', 'task:llm', 'capability:summarization', `specialty:${row.slugPart}`, `visit-type:${visit}`],
    provenance: null,
  })),
);

/** The 22 department agents plus the tenant's own warm start — what phase 29 writes. */
export const ARCAAI_AGENT_SPECS: SeedAgentSpec[] = [...ARCAAI_DEPARTMENT_AGENT_SPECS, ARCAAI_PRE_SUMMARY_AGENT_SPEC];

// =============================================================================
// Workflows — 11
// =============================================================================

const arcaaiWorkflowId = (ordinal: number) => `99000000-0000-0000-0001-${String(ordinal).padStart(12, '0')}`;

export const ARCAAI_WORKFLOW_TARGETS: WorkflowSeedTarget[] = ARCAAI_DEPARTMENT_TABLE.map((row) => ({
  key: workflowTargetKey('ARCAAI', arcaaiWorkflowSlug(row)),
  id: arcaaiWorkflowId(row.ordinal),
  tenantId: ARCAAI,
  slug: arcaaiWorkflowSlug(row),
  name: `${row.name} Consultation`,
  description: `Realtime transcription, medical NER, the ${row.name} running note selected by visit type (new-visit / revisit), case-note finalization, clinician review and the {case_note, redactions} output.`,
  graph: buildConsultationGraph({
    contextSchemaId: ARCAAI_SCRIBE_CONTEXT_SCHEMA_ID,
    summarizer: { kind: 'condition', newVisitSlug: arcaaiAgentSlug(row, 'new-visit'), revisitSlug: arcaaiAgentSlug(row, 'revisit') },
    // TASK-932 §3.7 — the note SHAPE, per department and per visit type. `realtimeDocumentTemplateSlug`
    // reads this off the frozen lane and hands it to `resolveForGeneration`, which is the third
    // wire-up TASK-891 OD-2 named and nothing had ever supplied: a traced session logged
    // `templateId: null` and produced the platform SOAP shape while its governing workflow sat
    // right there on the lane.
    documentTemplateSlugs: {
      n_summary_new: arcaaiDocumentTemplateSlug(row.slugPart, 'new-visit'),
      n_summary_revisit: arcaaiDocumentTemplateSlug(row.slugPart, 'revisit'),
    },
  }),
  contextSchemaVersionId: ARCAAI_SCRIBE_CONTEXT_SCHEMA_VERSION_ID,
  contextSchemaDefinition: ARCAAI_CONSULTATION_SCRIBE_DEFINITION,
  tags: ['palette:core', 'kind:consultation', 'kind:api', 'tenant-authored', `specialty:${row.slugPart}`],
  sourceTemplateSlug: null,
}));

/** LAZY — see `workflowLibraryDefinitions`. */
export const arcaaiWorkflowDefinitions = () => ARCAAI_WORKFLOW_TARGETS.map((target) => definitionRow(target, generatedFor(ARCAAI_GENERATED, target.key), REGISTRY_CHECKSUM));

// =============================================================================
// Assignments — DEPARTMENT scope × 11, TENANT default → the General Medicine workflow
// =============================================================================

const ARCAAI_ASSIGNMENT_SLOT = '0001';
const assignmentIdFor = (n: number) => `9a000000-0000-0000-${ARCAAI_ASSIGNMENT_SLOT}-${String(n).padStart(12, '0')}`;
const assignmentChangeIdFor = (n: number) => `9a000000-0000-0001-${ARCAAI_ASSIGNMENT_SLOT}-${String(n).padStart(12, '0')}`;

const GEN = ARCAAI_DEPARTMENT_TABLE.find((row) => row.code === 'GEN');
if (!GEN) throw new Error('The ArcaAI department table has no GEN (General Medicine) row');
export const ARCAAI_DEFAULT_WORKFLOW_SLUG = arcaaiWorkflowSlug(GEN);

/** `departmentIdByCode` maps a seed-time code to the PERSISTED department id (04 upserts by `(tenantId, code)`). */
export function arcaaiWorkflowAssignments(departmentIdByCode: ReadonlyMap<string, string>) {
  const rows = [
    {
      id: assignmentIdFor(1),
      tenantId: ARCAAI,
      scope: 'TENANT' as const,
      scopeId: null as string | null,
      paletteKey: CORE_PALETTE_KEY,
      workflowDefinitionSlug: ARCAAI_DEFAULT_WORKFLOW_SLUG,
      selectorKey: '',
      createdBy: SYSTEM_USER_ID,
    },
    ...ARCAAI_DEPARTMENT_TABLE.map((row) => {
      const departmentId = departmentIdByCode.get(row.code);
      if (!departmentId) throw new Error(`Missing ArcaAI department for code ${row.code}`);
      return {
        id: assignmentIdFor(row.ordinal + 1),
        tenantId: ARCAAI,
        scope: 'DEPARTMENT' as const,
        scopeId: departmentId as string | null,
        paletteKey: CORE_PALETTE_KEY,
        workflowDefinitionSlug: arcaaiWorkflowSlug(row),
        selectorKey: '',
        createdBy: SYSTEM_USER_ID,
      };
    }),
  ];
  const changes = rows.map((row, index) => ({
    id: assignmentChangeIdFor(index + 1),
    tenantId: ARCAAI,
    scope: row.scope,
    scopeId: row.scopeId,
    paletteKey: CORE_PALETTE_KEY,
    changedBy: SYSTEM_USER_ID,
    assignmentVersion: 1,
    beforeSlug: null as string | null,
    afterSlug: row.workflowDefinitionSlug,
    reason: row.scope === 'TENANT' ? 'Seeded day-1 ArcaAI tenant default consultation workflow (TASK-930 §8.5).' : `Seeded day-1 ArcaAI department consultation workflow (TASK-930 §8.5).`,
  }));
  return { rows, changes };
}

// =============================================================================
// Seeding
// =============================================================================

export interface SeedArcaaiClient extends SeedAgentsClient, SeedWorkflowsClient {
  department: { findMany(args: { where: { tenantId: string; code: { in: string[] } }; select: { id: true; code: true } }): Promise<Array<{ id: string; code: string }>> };
}

/** The 22 ArcaAI department note shapes this phase writes, so a caller can count them without a DB. */
export const ARCAAI_DOCUMENT_TEMPLATE_SLUGS: readonly string[] = ARCAAI_DEPARTMENT_TABLE.flatMap((row) =>
  VISIT_TYPES.map((visit) => arcaaiDocumentTemplateSlug(row.slugPart, visit)),
);

export const seedArcaaiAgentsAndWorkflows = async (client: CorePrismaClient | SeedArcaaiClient) => {
  const typed = client as unknown as SeedArcaaiClient;
  console.log('Seeding the ArcaAI department agents and consultation workflows (11 departments × 2 visit types) ...');

  const agents = await seedAgentSpecs(typed, ARCAAI_AGENT_SPECS, 'ArcaAI department', 200);
  // TASK-932 §3.7 — the department note SHAPES, written HERE and not in phase 27: they are one
  // customer's content, and phase 27 runs in `safe` mode. The definitions below name their slugs,
  // so the rows must exist before a lane resolves one (`resolveForGeneration` falls open to the
  // platform SOAP shape for a slug it cannot find — which is the silent wrong-shape note again).
  const documentTemplates = await seedArcaaiDepartmentDocumentTemplates(typed as unknown as CorePrismaClient, ARCAAI);
  const definitions = await createWorkflowDefinitions(typed, arcaaiWorkflowDefinitions());

  const departments = await typed.department.findMany({
    where: { tenantId: ARCAAI, code: { in: ARCAAI_DEPARTMENT_TABLE.map((row) => row.code) } },
    select: { id: true, code: true },
  });
  const { rows, changes } = arcaaiWorkflowAssignments(new Map(departments.map((department) => [department.code, department.id])));
  const assignments = await writeWorkflowAssignments(typed, rows, changes);

  console.log(
    `  ✓ ArcaAI agents: ${agents.created} created, ${agents.skippedExisting} skipped, ${agents.skippedUnresolvable} unresolvable · document templates: ${documentTemplates} · workflows: ${definitions.created} created, ${definitions.skipped} skipped · assignments: ${assignments}`,
  );
  return { success: true as const, agents, definitions, assignments, documentTemplates };
};
