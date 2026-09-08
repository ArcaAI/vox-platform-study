/**
 * TASK-930 §8.4 — the workflow library, in the `core` vocabulary.
 *
 * Two workflows, each seeded for Global (the authoring playground) AND SYSTEM (the promoted copy,
 * `sourceTemplateSlug` = its own slug — the same provenance `WorkflowDefinitionService.cloneFromSystem`
 * stamps), both PUBLISHED and active, palette `core`, `kinds: ['consultation', 'api']`:
 *
 *   general-medicine-consultation     ① trigger → ② realtime-transcription (realtime, perTurn) →
 *                                     ③ medical-ner (realtime, perTurn) → ④ general-medicine-summarization
 *                                     (realtime, perTurn) → ⑤ casenote-finalization (durable, onEnd) →
 *                                     ⑥ humanReview clinical_finalization → ⑦ output {case_note, redactions}
 *   platform-default-summarization    trigger [api] → general-medicine-summarization (durable, once) → output
 *
 * The consultation graph is a BUILDER shared with phase 29: ArcaAI replaces ④ with a
 * `core.condition` on `{{trigger.context.visit_type}}` fanning out to its two department agents.
 *
 * ## Provenance — read before editing any blob
 *
 * `graph` is AUTHORED (here). `graphChecksum`, `compiledConfig`, `registryChecksum` and
 * `validationReport` are ENGINE OUTPUT — the literal result of `@arcaai/workflow-contract`'s real
 * `validate()` / `compile()` / `registryChecksum()` / `publishFindings()`, written by
 * `scripts/regen-workflow-seeds.ts` (`pnpm --filter @arcaai/database seed:regen:workflows`) into
 * `28-workflow-library.generated.ts` and committed verbatim; `task-930-workflow-seeds.test.ts`
 * re-runs the engine and compares, so none of them can drift or be invented.
 *
 * The graphs differ per tenant in ONE value: `core.trigger.contextSchema.contextSchemaId`, a ROW
 * REFERENCE to that tenant's own `consultation_note_context` (schemas are CONTENT, cloned per
 * tenant — never shared from SYSTEM). The compiler freezes the resolved payload schema on the
 * trigger, so the interpreter validates without a database read.
 *
 * `WorkflowAssignment` (TENANT scope, palette `core`) in both tenants → `general-medicine-consultation`,
 * with its WORM `WorkflowAssignmentChange` row. The retired substrate-exclusivity gate that used
 * to withhold the ArcaAI assignment guarded a legacy dual-writer path (`consultation.persistDraft`)
 * that TASK-893 deletes with the vocabulary; a `core` graph has one writer.
 */
import type { CorePrismaClient } from '../../../client';
import { SEED_TENANT_ID, SEED_WORKFLOW_DEFINITION_IDS, SYSTEM_TENANT_ID, SYSTEM_USER_ID } from './00-constants';
import { NOTE_CONTEXT_SCHEMA_SLUG, noteContextSchemaIdFor, noteContextSchemaVersionIdFor } from './07e-consultation-note-context-schema';
import { REGISTRY_CHECKSUM, WORKFLOW_LIBRARY_GENERATED, type GeneratedWorkflowBlob } from './28-workflow-library.generated';

/** Pinned so every derived blob is reproducible; a wall-clock value would make them un-diffable. */
export const COMPILED_AT = '2026-09-08T00:00:00.000Z';

export const CORE_PALETTE_KEY = 'core';
export const CONSULTATION_WORKFLOW_SLUG = 'general-medicine-consultation';
export const SUMMARIZATION_WORKFLOW_SLUG = 'platform-default-summarization';

// =============================================================================
// The authored graphs (regeneration INPUT — everything derived from them is generated output)
// =============================================================================

export type SeedEdge = { id: string; from: string; fromPort: string; to: string; toPort: string };
export type SeedNode = { id: string; type: string; config: Record<string, unknown> };
export type SeedGraph = { version: 1; nodes: SeedNode[]; edges: SeedEdge[] };

const edges = (specs: ReadonlyArray<readonly [string, string, string, string]>): SeedEdge[] =>
  specs.map(([from, fromPort, to, toPort], index) => ({ id: `e${index + 1}`, from, fromPort, to, toPort }));

/** How the per-turn summary step is authored: ONE agent (Global / SYSTEM) or a visit-type split (ArcaAI). */
export type SummarizerSpec = { kind: 'agent'; slug: string } | { kind: 'condition'; newVisitSlug: string; revisitSlug: string };

export interface ConsultationGraphOptions {
  /** The tenant's own `consultation_note_context` row — a REFERENCE, resolved at compile time. */
  contextSchemaId: string;
  summarizer: SummarizerSpec;
}

const REALTIME_PER_TURN = { lane: 'realtime', cadence: 'perTurn' };

/** The §8.4 consultation graph. Node ids are stable across variants so the tests can address them. */
export function buildConsultationGraph(options: ConsultationGraphOptions): SeedGraph {
  const summaryNodes: SeedNode[] =
    options.summarizer.kind === 'agent'
      ? [
          {
            id: 'n_summary',
            type: 'core.agent',
            config: { agentRef: { slug: options.summarizer.slug }, execution: REALTIME_PER_TURN, guardrail: { enabled: true }, onError: 'degrade' },
          },
        ]
      : [
          {
            id: 'n_visit',
            type: 'core.condition',
            // KEY_PATTERN forbids a hyphen in a branch key, so the handles are `new_visit` / `revisit`
            // while the VALUE compared is the schema's `new-visit` / `revisit` enum.
            config: {
              branches: [
                { key: 'new_visit', label: 'New / referral visit', when: "trigger.context.visit_type == 'new-visit'" },
                { key: 'revisit', label: 'Follow-up visit', when: "trigger.context.visit_type == 'revisit'" },
              ],
            },
          },
          {
            id: 'n_summary_new',
            type: 'core.agent',
            config: { agentRef: { slug: options.summarizer.newVisitSlug }, execution: REALTIME_PER_TURN, guardrail: { enabled: true }, onError: 'degrade' },
          },
          {
            id: 'n_summary_revisit',
            type: 'core.agent',
            config: { agentRef: { slug: options.summarizer.revisitSlug }, execution: REALTIME_PER_TURN, guardrail: { enabled: true }, onError: 'degrade' },
          },
        ];
  const summaryIds = options.summarizer.kind === 'agent' ? ['n_summary'] : ['n_summary_new', 'n_summary_revisit'];

  return {
    version: 1,
    nodes: [
      {
        id: 'n_trigger',
        type: 'core.trigger',
        config: { kinds: ['consultation', 'api'], contextSchema: { contextSchemaId: options.contextSchemaId, versionNumber: 1 }, guardrail: { enabled: true } },
      },
      { id: 'n_asr', type: 'core.agent', config: { agentRef: { slug: 'realtime-transcription' }, execution: REALTIME_PER_TURN, onError: 'fail' } },
      { id: 'n_ner', type: 'core.agent', config: { agentRef: { slug: 'medical-ner' }, execution: REALTIME_PER_TURN, onError: 'degrade' } },
      ...summaryNodes,
      {
        id: 'n_finalize',
        type: 'core.agent',
        config: { agentRef: { slug: 'casenote-finalization' }, execution: { lane: 'durable', cadence: 'onEnd' }, guardrail: { enabled: true }, onError: 'fail' },
      },
      {
        id: 'n_review',
        type: 'core.humanReview',
        config: {
          reviewType: 'clinical_finalization',
          instructions: 'Review the finalized case note. Approve to sign it off, or edit it and approve; reject to discard this finalization.',
          assignRole: 'DOCTOR',
          timeoutSeconds: 3600,
          allowEdit: true,
        },
      },
      {
        id: 'n_output',
        type: 'core.output',
        // TASK-930 D-1. The published result is the FINALIZER's own contract
        // (`casenote-finalization.outputSchema` = `{ case_note, redactions }`), because that is
        // the node this output is fed from. Two corrections are folded in here:
        //
        //  - `entities` is no longer REQUIRED. NER consumes a `transcript`, and the port lattice
        //    refuses to feed it anything else on purpose (`port-model.ts`: "`document -> ner` is
        //    a type error … the anti-hallucination-laundering rule made structural"). Only live
        //    audio produces a transcript, so an API-plane run legitimately has no entities — and
        //    on the consultation plane they are written by the realtime lane onto the
        //    consultation, not carried out through this port. Requiring them made every API-plane
        //    run FAIL on its own schema (§6.9 D-1).
        //  - the run's ENTITIES are therefore not claimed at all rather than declared and never
        //    populated; `redactions` is, because the finalizer really does return it.
        config: {
          protocols: ['http', 'http-sse', 'socket'],
          outputSchema: {
            type: 'object',
            required: ['case_note'],
            properties: {
              case_note: { type: 'string' },
              redactions: { type: 'array', items: { type: 'object', required: ['text', 'label'], properties: { text: { type: 'string' }, label: { type: 'string' } } } },
            },
          },
          onSchemaViolation: 'fail',
        },
      },
    ],
    edges: edges([
      ['n_trigger', 'next', 'n_asr', 'after'],
      ['n_asr', 'transcript', 'n_ner', 'in'],
      ...(options.summarizer.kind === 'agent'
        ? ([
            ['n_trigger', 'out', 'n_summary', 'context'],
            ['n_ner', 'out', 'n_summary', 'in'],
          ] as const)
        : ([
            ['n_ner', 'out', 'n_visit', 'in'],
            ['n_visit', 'new_visit', 'n_summary_new', 'after'],
            ['n_visit', 'revisit', 'n_summary_revisit', 'after'],
            // `else` → the new-visit agent (§8.5): an unknown visit type is documented as a first visit.
            ['n_visit', 'else', 'n_summary_new', 'after'],
            ['n_trigger', 'out', 'n_summary_new', 'context'],
            ['n_trigger', 'out', 'n_summary_revisit', 'context'],
            ['n_ner', 'out', 'n_summary_new', 'in'],
            ['n_ner', 'out', 'n_summary_revisit', 'in'],
          ] as const)),
      ...summaryIds.map((id) => [id, 'out', 'n_finalize', 'in'] as const),
      ['n_finalize', 'out', 'n_review', 'in'],
      // TASK-930 D-1. The OUTPUT is fed by the finalizer, not by the review.
      // `core.humanReview.out` carries the review DECISION (`{outcome, reviewerId, comment,
      // editedPayload, escalations}`) — handing that to `core.output` made the declared
      // `{case_note, …}` contract unreachable on EVERY plane, whatever ran upstream. The review
      // still gates the publish, through the ORDERING edge a review handle is meant to carry.
      ['n_finalize', 'data', 'n_output', 'in'],
      ['n_review', 'next', 'n_output', 'after'],
    ]),
  };
}

/** The §8.4 summarization graph: the reference workflow for the summarization API. */
export function buildSummarizationGraph(options: { contextSchemaId: string }): SeedGraph {
  return {
    version: 1,
    nodes: [
      { id: 'n_trigger', type: 'core.trigger', config: { kinds: ['api'], contextSchema: { contextSchemaId: options.contextSchemaId, versionNumber: 1 }, guardrail: { enabled: true } } },
      {
        id: 'n_summary',
        type: 'core.agent',
        config: { agentRef: { slug: 'general-medicine-summarization' }, execution: { lane: 'durable', cadence: 'once' }, guardrail: { enabled: true }, onError: 'fail' },
      },
      { id: 'n_output', type: 'core.output', config: { protocols: ['http', 'http-sse'], onSchemaViolation: 'fail' } },
    ],
    edges: edges([
      ['n_trigger', 'out', 'n_summary', 'context'],
      ['n_summary', 'out', 'n_output', 'in'],
    ]),
  };
}

// =============================================================================
// Targets — one (tenant, slug) per row the seed writes; the regen script compiles each
// =============================================================================

export interface WorkflowSeedTarget {
  /** `${tenantKey}:${slug}` — the key of the generated blob. */
  key: string;
  id: string;
  tenantId: string;
  slug: string;
  name: string;
  description: string;
  graph: SeedGraph;
  /** The tenant's `consultation_note_context` version row (frozen into `policyBindings`). */
  contextSchemaVersionId: string;
  tags: string[];
  /** `null` on the authored (Global) row; the slug on the promoted (SYSTEM) copy. */
  sourceTemplateSlug: string | null;
}

/** Id blocks: `99000000-…-0000-…` SYSTEM (…001 = the pre-existing platform-default-summarization id), `…-0002-…` Global. */
const LIBRARY_IDS = {
  SYSTEM: { [SUMMARIZATION_WORKFLOW_SLUG]: SEED_WORKFLOW_DEFINITION_IDS.PLATFORM_DEFAULT_SUMMARIZATION, [CONSULTATION_WORKFLOW_SLUG]: '99000000-0000-0000-0000-000000000002' },
  GLOBAL: { [SUMMARIZATION_WORKFLOW_SLUG]: '99000000-0000-0000-0002-000000000001', [CONSULTATION_WORKFLOW_SLUG]: '99000000-0000-0000-0002-000000000002' },
} as const;

export const workflowTargetKey = (tenantKey: string, slug: string): string => `${tenantKey}:${slug}`;

function libraryTargets(tenantKey: 'GLOBAL' | 'SYSTEM', tenantId: string): WorkflowSeedTarget[] {
  const contextSchemaId = noteContextSchemaIdFor(tenantId);
  const contextSchemaVersionId = noteContextSchemaVersionIdFor(tenantId);
  const sourceTemplateSlug = (slug: string) => (tenantKey === 'SYSTEM' ? slug : null);
  return [
    {
      key: workflowTargetKey(tenantKey, CONSULTATION_WORKFLOW_SLUG),
      id: LIBRARY_IDS[tenantKey][CONSULTATION_WORKFLOW_SLUG],
      tenantId,
      slug: CONSULTATION_WORKFLOW_SLUG,
      name: 'General Medicine Consultation',
      description:
        'Realtime transcription, medical NER and the per-turn General Medicine running note; case-note finalization at the close, a clinician review, and the {case_note, redactions} output. Governs consultations and is exposed on the API plane.',
      graph: buildConsultationGraph({ contextSchemaId, summarizer: { kind: 'agent', slug: 'general-medicine-summarization' } }),
      contextSchemaVersionId,
      tags: ['palette:core', 'kind:consultation', 'kind:api', 'specialty:general-medicine'],
      sourceTemplateSlug: sourceTemplateSlug(CONSULTATION_WORKFLOW_SLUG),
    },
    {
      key: workflowTargetKey(tenantKey, SUMMARIZATION_WORKFLOW_SLUG),
      id: LIBRARY_IDS[tenantKey][SUMMARIZATION_WORKFLOW_SLUG],
      tenantId,
      slug: SUMMARIZATION_WORKFLOW_SLUG,
      name: 'Platform Default — Summarization',
      description: 'The reference workflow for the summarization API: one General Medicine summarization pass over the supplied text, guardrail on.',
      graph: buildSummarizationGraph({ contextSchemaId }),
      contextSchemaVersionId,
      tags: ['palette:core', 'kind:api', 'platform-default', 'summarization'],
      sourceTemplateSlug: sourceTemplateSlug(SUMMARIZATION_WORKFLOW_SLUG),
    },
  ];
}

/** Global authors, SYSTEM is the promoted copy — the same two slugs in each. */
export const WORKFLOW_LIBRARY_TARGETS: WorkflowSeedTarget[] = [...libraryTargets('GLOBAL', SEED_TENANT_ID), ...libraryTargets('SYSTEM', SYSTEM_TENANT_ID)];

// =============================================================================
// Rows
// =============================================================================

/** The generated blob for a target, or a loud failure — a row without its engine output is not seedable. */
export function generatedFor(generated: Readonly<Record<string, GeneratedWorkflowBlob>>, key: string): GeneratedWorkflowBlob {
  const blob = generated[key];
  if (!blob) throw new Error(`No generated workflow blob for '${key}' — run \`pnpm --filter @arcaai/database seed:regen:workflows\``);
  return blob;
}

export function definitionRow(target: WorkflowSeedTarget, blob: GeneratedWorkflowBlob, registryChecksum: string) {
  return {
    id: target.id,
    tenantId: target.tenantId,
    slug: target.slug,
    name: target.name,
    description: target.description,
    paletteKey: CORE_PALETTE_KEY,
    versionNumber: 1,
    parentVersionId: null,
    status: 'PUBLISHED' as const,
    isActive: true,
    sourceTemplateSlug: target.sourceTemplateSlug,
    templateLocked: false,
    graph: target.graph,
    graphChecksum: blob.graphChecksum,
    compiledConfig: blob.compiledConfig,
    compiledConfigChecksum: (blob.compiledConfig as { checksum: string }).checksum,
    registryChecksum,
    validationReport: blob.validationReport,
    needsReview: false,
    validatedAt: new Date(COMPILED_AT),
    publishedAt: new Date(COMPILED_AT),
    tags: target.tags,
    createdBy: SYSTEM_USER_ID,
  };
}

/** LAZY: the regen script imports this module for the GRAPHS before the generated blobs exist. */
export const workflowLibraryDefinitions = () => WORKFLOW_LIBRARY_TARGETS.map((target) => definitionRow(target, generatedFor(WORKFLOW_LIBRARY_GENERATED, target.key), REGISTRY_CHECKSUM));

/**
 * `9A000000` block: `…-0000-<slot>-…` assignment rows, `…-0001-<slot>-…` their WORM change rows;
 * slot 0000 = SYSTEM, 0002 = Global (0001 is ArcaAI's, phase 29).
 */
const assignmentRow = (slot: string, tenantId: string) => ({
  id: `9a000000-0000-0000-${slot}-000000000001`,
  tenantId,
  scope: 'TENANT' as const,
  scopeId: null as string | null,
  paletteKey: CORE_PALETTE_KEY,
  workflowDefinitionSlug: CONSULTATION_WORKFLOW_SLUG,
  selectorKey: '',
  createdBy: SYSTEM_USER_ID,
});
const assignmentChangeRow = (slot: string, tenantId: string) => ({
  id: `9a000000-0000-0001-${slot}-000000000001`,
  tenantId,
  scope: 'TENANT' as const,
  scopeId: null as string | null,
  paletteKey: CORE_PALETTE_KEY,
  changedBy: SYSTEM_USER_ID,
  assignmentVersion: 1,
  beforeSlug: null as string | null,
  afterSlug: CONSULTATION_WORKFLOW_SLUG,
  reason: 'Seeded day-1 core-palette consultation workflow assignment (TASK-930 §8.4).',
});

export const WORKFLOW_LIBRARY_ASSIGNMENTS = [assignmentRow('0002', SEED_TENANT_ID), assignmentRow('0000', SYSTEM_TENANT_ID)];
export const WORKFLOW_LIBRARY_ASSIGNMENT_CHANGES = [assignmentChangeRow('0002', SEED_TENANT_ID), assignmentChangeRow('0000', SYSTEM_TENANT_ID)];

// =============================================================================
// Seeding (shared with phase 29)
// =============================================================================

/** The slice of the client the two workflow phases touch — narrow so a test can hand in a fake. */
export interface SeedWorkflowsClient {
  workflowDefinition: { findUnique(args: { where: { id: string }; select?: { id: true } }): Promise<{ id: string } | null>; create(args: { data: unknown }): Promise<unknown> };
  workflowAssignment: { upsert(args: { where: { id: string }; create: unknown; update: unknown }): Promise<unknown> };
  workflowAssignmentChange: { findUnique(args: { where: { id: string }; select?: { id: true } }): Promise<{ id: string } | null>; create(args: { data: unknown }): Promise<unknown> };
}

export async function createWorkflowDefinitions(client: SeedWorkflowsClient, rows: ReadonlyArray<ReturnType<typeof definitionRow>>): Promise<{ created: number; skipped: number }> {
  let created = 0;
  let skipped = 0;
  for (const row of rows) {
    // CREATE-ONLY. A PUBLISHED WorkflowDefinition is immutable at three application layers AND
    // at a database trigger — an upsert with an `update` branch would raise at the DB.
    const existing = await client.workflowDefinition.findUnique({ where: { id: row.id }, select: { id: true } });
    if (existing) {
      skipped += 1;
      continue;
    }
    await client.workflowDefinition.create({ data: row });
    created += 1;
  }
  return { created, skipped };
}

export async function writeWorkflowAssignments(
  client: SeedWorkflowsClient,
  assignments: ReadonlyArray<Record<string, unknown> & { id: string }>,
  changes: ReadonlyArray<Record<string, unknown> & { id: string }>,
): Promise<number> {
  let written = 0;
  for (const assignment of assignments) {
    // Upsert by `id`, not by the compound unique: `scopeId` is NULL on a TENANT row and PostgreSQL
    // treats NULLs in a unique index as distinct, so the compound key cannot address it.
    await client.workflowAssignment.upsert({ where: { id: assignment.id }, create: assignment, update: assignment });
    written += 1;
  }
  for (const change of changes) {
    // CREATE-ONLY: append-only WORM table, UPDATE/DELETE revoked for the app role.
    const existing = await client.workflowAssignmentChange.findUnique({ where: { id: change.id }, select: { id: true } });
    if (!existing) await client.workflowAssignmentChange.create({ data: change });
  }
  return written;
}

/** Global + SYSTEM: the two workflows each, and the TENANT assignment to the consultation workflow. */
export const seedWorkflowLibrary = async (client: CorePrismaClient | SeedWorkflowsClient) => {
  const typed = client as unknown as SeedWorkflowsClient;
  console.log(`Seeding the core-palette workflow library (Global + SYSTEM; trigger context ${NOTE_CONTEXT_SCHEMA_SLUG}) ...`);
  const { created, skipped } = await createWorkflowDefinitions(typed, workflowLibraryDefinitions());
  const assignments = await writeWorkflowAssignments(typed, WORKFLOW_LIBRARY_ASSIGNMENTS, WORKFLOW_LIBRARY_ASSIGNMENT_CHANGES);
  console.log(`  ✓ Workflow definitions: ${created} created, ${skipped} skipped · assignments: ${assignments}`);
  return { success: true as const, created, skipped, assignments };
};
