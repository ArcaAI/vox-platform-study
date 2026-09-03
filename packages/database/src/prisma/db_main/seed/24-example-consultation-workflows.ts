/**
 * three EXAMPLE consultation workflows, seeded twice: as SYSTEM
 * templates a tenant admin can clone, and as the ArcaAI tenant's own published
 * copies a clinician can select at session-open.
 *
 * ## What these are, and what they are not
 *
 * They are the smallest honest expression of three agent combinations the owner
 * named:
 *
 * | Slug suffix | Grammar fix | Medical NER | Partial summary | Finalization |
 * |--------------------|-------------|-------------|-----------------|--------------|
 * | `grammar-fix` | yes | present, OFF| yes | yes |
 * | `medical-ner` | no | yes | yes | yes |
 * | `ner-grammar-fix` | yes | yes | yes | yes |
 *
 * They are NOT a second SOAP workflow. `23-arcaai-workflow-authoring.ts` owns
 * that: guardrails, evidence retrieval, terminology binding, DNA redaction,
 * suggestions and note corrections. These three carry none of it, and the
 * omission is the owner's scope for this programme rather than an unfinished
 * graph — harness policy and guardrail stay exactly as they are, so no
 * `guard.*` / `guardrail.*` node appears here, and `agent.presummarization` is
 * excluded with them because it `requires: ['guard.groundedness']` and would
 * drag the groundedness guard back in through its publish check.
 *
 * ## Why NER is PRESENT-BUT-DISABLED in the grammar-fix workflow
 *
 * `consultation.extractEntities` is not optional in the way a reader would
 * expect: WF-CONS-012 is an `allPathsPassThrough` rule requiring EVERY route
 * from `captureBinding` to `synthesize` to cross it, so a graph without the
 * node does not validate and cannot be published at all. "Grammar fix, no NER"
 * therefore cannot be expressed by deleting the node.
 *
 * It is expressed by per-node toggle instead: `config.enabled:
 * false`, which BOTH engines honour — `buildRealtimeLane` carries it onto the
 * lane node and the executor skips it, and the durable interpreter skips it
 * too. The node stays structurally present (so the graph is publishable and the
 * mandatory subgraph is intact) and runs for nobody. That is the difference
 * between a rule satisfied on paper and a capability actually switched off.
 *
 * ## Provenance — read before editing any blob below
 *
 * `graph` is AUTHORED. `graphChecksum`, `compiledConfig`, `registryChecksum`
 * and `validationReport` are ENGINE OUTPUT — the literal result of
 * `packages/workflow-contract`'s real `validate()` / `compile()` /
 * `registryChecksum()`, written by
 * `packages/database/scripts/regen-example-consultation-workflow-seed.ts` and
 * committed verbatim. `task-858-example-consultation-workflows.test.ts` re-runs
 * the engine and compares, so none of them can drift or be invented.
 *
 * ## Two seed phases, because the two halves make different claims
 *
 * The SYSTEM rows are platform configuration: SYSTEM-tenant, `createdBy:
 * SYSTEM_USER_ID`, and they assert no human authorship — so they run in `safe`
 * mode like `21-workflow-definition`. The ArcaAI rows carry `createdBy: <the
 * ArcaAI tenant admin>`, which in a real database is a published clinical
 * workflow attributed to a named human who never authored it — so they are on
 * the `safe` deny-list, for the same reason `23-arcaai-workflow-authoring` is.
 * See `seed-mode.ts`.
 *
 * ## No `WorkflowAssignment`
 *
 * These are SELECTABLE, not assigned. The ArcaAI tenant assignment stays
 * `arcaai-consultation-soap`; a clinician picks one of these three at
 * session-open (`workflowDefinitionSlug`) and the realtime lane
 * follows. Assigning one would silently replace the tenant's default SOAP
 * workflow for every consultation, which is not what "here are three examples"
 * means.
 */
import type { CorePrismaClient } from '../../../client';
import { SEED_CUSTOMER_TENANT_IDS, SEED_USER_IDS, SYSTEM_TENANT_ID, SYSTEM_USER_ID } from './00-constants';
import { TEMPLATE_IDS } from './07-prompt-template';
import {
  ARCAAI_GRAMMAR_FIX_COMPILED_CONFIG,
  ARCAAI_MEDICAL_NER_COMPILED_CONFIG,
  ARCAAI_NER_GRAMMAR_FIX_COMPILED_CONFIG,
  GRAMMAR_FIX_GRAPH_CHECKSUM,
  GRAMMAR_FIX_VALIDATION_REPORT,
  MEDICAL_NER_GRAPH_CHECKSUM,
  MEDICAL_NER_VALIDATION_REPORT,
  NER_GRAMMAR_FIX_GRAPH_CHECKSUM,
  NER_GRAMMAR_FIX_VALIDATION_REPORT,
  PLATFORM_GRAMMAR_FIX_COMPILED_CONFIG,
  PLATFORM_MEDICAL_NER_COMPILED_CONFIG,
  PLATFORM_NER_GRAMMAR_FIX_COMPILED_CONFIG,
  REGISTRY_CHECKSUM,
} from './24-example-consultation-workflows.generated';

const ARCAAI = SEED_CUSTOMER_TENANT_IDS.ARCAAI;

/** Pinned so every derived blob is reproducible; a wall-clock value would make them un-diffable. */
export const COMPILED_AT = '2026-09-03T00:00:00.000Z';

// =============================================================================
// The authored graphs (regeneration INPUT — everything below them is derived)
// =============================================================================

type SeedEdge = { id: string; from: string; fromPort: string; to: string; toPort: string };

const edges = (specs: readonly (readonly [string, string, string, string])[]): SeedEdge[] =>
  specs.map(([from, fromPort, to, toPort], index) => ({ id: `e${index + 1}`, from, fromPort, to, toPort }));

export interface ExampleGraphOptions {
  /** Include the realtime `agent.grammar` pass over the partial transcript. */
  readonly grammar: boolean;
  /** `false` seeds `consultation.extractEntities` with `enabled: false` — present, switched off. */
  readonly entities: boolean;
}

/**
 * ONE spine, three option combinations.
 *
 * ```
 * start -> consentGate -> captureBinding ┬-> agent.grammar ──────┐ (grammar only)
 *                                        ├-> realtimeSummary ────┤
 *                                        └-> extractEntities <───┘
 *                                                  |
 *   phiHop -> assemblePrompt -> synthesize -> sensors -> persistDraft
 *          -> finalizeAssurance -> hitlGate -> end
 * ```
 *
 * ## Why the two realtime branches hang off CAPTURE and rejoin at EXTRACTION
 *
 * Neither placement is a preference; two independent constraints force it, and
 * `23-arcaai-workflow-authoring.ts` records both at length for the same nodes:
 *
 *  1. **The rule set.** WF-CONS-012 is an `allPathsPassThrough` check, so a
 *     branch off capture that rejoined anywhere downstream of `extractEntities`
 *     would open a route around it; rejoining after synthesis would skip the
 *     PHI hop (WF-CONS-009) and synthesis itself (WF-CONS-010). Routing INTO
 *     extraction is the one shape that satisfies all three.
 *  2. **Lane filtering.** `buildRealtimeLane` DROPS a binding whose producer is
 *     not itself a `realtime` node, so a transcript sourced from a durable
 *     producer (`consultation.phiHop.out` is also `transcript`-typed) would
 *     compile, validate, and then be silently unbound at flush time.
 *     `consultation.captureBinding` is the palette's only realtime producer of
 *     `transcript`, so it is the only legal source.
 *
 * ## Why three edges into the durable half are ORDERING rather than data
 *
 * `n_entities -> n_phi`, `n_phi -> n_prompt` and `n_assure -> n_gate` carry
 * `next -> after` and no payload:
 *
 *  - `consultation.phiHop.in` is `transcript`, and `extractEntities` produces
 *    `entities`. The SOAP graph bridges that with `bindTerminology`
 *    (`entities -> entities`); these workflows have no terminology node, and
 *    inventing one to carry an ordering dependency would add an outbound
 *    MCP tool call to a graph that needs none. The PHI activity resolves the
 *    consultation transcript server-side from `run_payload`, exactly as it does
 *    in the SOAP graph, where this input is ALSO left unwired.
 *  - `consultation.assemblePrompt` declares no `transcript` input at all
 * (lane A item 18 removed it): the gateway assembles the prompt from
 *    the consultation's own persisted transcript, so a second copy over a port
 *    could only duplicate it. Its remaining `in` is an optional
 *    `context<schemaRef>` fed by evidence retrieval, which these graphs do not
 *    run.
 *  - `consultation.hitlGate` is `gate`-classed: the compiler lifts it out of
 *    `stages` into `gates`, and `CompiledGate` has no `inputs`, so no edge into
 *    it is ever compiled to a binding.
 */
const consultationNodes = (options: ExampleGraphOptions) => [
  { id: 'n_start', type: 'core.start', config: {} },
  // Identity is read from `run_payload`, never from config — a consent decision
  // configured into a graph would be a consent decision made at authoring time
  // for every future patient.
  { id: 'n_consent', type: 'consultation.consentGate', config: {} },
  { id: 'n_capture', type: 'consultation.captureBinding', config: { action: 'start', persistSnapshot: true, onError: 'degrade' } },
  // The GRAMMAR FIX agent. `promptTemplateId` is not optional decoration: the
  // realtime handler resolves its system prompt from this binding and THROWS
  // when it is absent, so an unbound node degrades on every flush. It binds the
  // SYSTEM platform-default instruction; a tenant admin overrides it by binding
  // its own template here, and THAT binding is the tenant -> SYSTEM cascade for
  // this capability.
  //
  // Its `out: edits` is deliberately consumed by NOTHING. Corrections are
  // advisory alongside the raw transcript, and an edge out of `out` would be a
  // second promotion channel beside the accepted-proposal path the clinician
  // actually approves through.
  ...(options.grammar
    ? [
        {
          id: 'n_grammar',
          type: 'agent.grammar',
          config: { promptTemplateId: TEMPLATE_IDS.LIVE_GRAMMAR_SYSTEM, taskKey: 'text.live', onError: 'degrade' },
        },
      ]
    : []),
  // PARTIAL SUMMARIZATION — the running note, regenerated on every flush. In
  // all three workflows: "with realtime transcription, partial summarization
  // and finalization" is the constant across the set, and the three agents are
  // what vary.
  //
  // Its `entities` port stays UNWIRED on purpose: wiring it would make the note
  // wait for NER, serialising two calls that the platform-default lane runs
  // concurrently — and in the grammar-fix workflow NER is switched off, so the
  // note would wait on a node that never runs.
  { id: 'n_realtime', type: 'consultation.realtimeSummary', config: { onError: 'degrade' } },
  // The MEDICAL NER agent (`blaze999/Medical-NER` through `nlp.ner`).
  //
  // `requiresFinalized: true` is WF-CONS-017 — extraction reads the FINALIZED
  // transcript, never a partial one. `enabled` is per-node toggle:
  // omitted (i.e. on) when this workflow includes NER, and explicitly `false`
  // when it does not. It cannot simply be deleted — see the module docstring.
  {
    id: 'n_entities',
    type: 'consultation.extractEntities',
    config: {
      language: 'en',
      persist: true,
      requiresFinalized: true,
      onError: 'degrade',
      ...(options.entities ? {} : { enabled: false }),
    },
  },
  { id: 'n_phi', type: 'consultation.phiHop', config: { mode: 'pseudonymize', onError: 'degrade' } },
  { id: 'n_prompt', type: 'consultation.assemblePrompt', config: { requiresFinalized: true, conversationLanguage: 'en', onError: 'degrade' } },
  // FINALIZATION. `producesCode: false` is WF-CONS-015: only
  // `bindTerminology` may produce a clinical code, and the negative must be
  // STATED rather than merely absent — which matters more here than in the SOAP
  // graph, because these workflows have no terminology node at all.
  { id: 'n_synth', type: 'consultation.synthesize', config: { taskKey: 'text.finalize', producesCode: false, onError: 'degrade' } },
  // The computational verifier. WF-CONS-011 makes it non-bypassable, and it is
  // also the only legal way for the note to REACH persistence: it passes the
  // document through on its `document` socket while its `out` carries the
  // verdict object.
  { id: 'n_sensors', type: 'consultation.sensors', config: { onError: 'degrade' } },
  // `occ: true` is WF-CONS-014 — the authorship protection made structural.
  { id: 'n_persist', type: 'consultation.persistDraft', config: { occ: true, onError: 'degrade' } },
  { id: 'n_assure', type: 'consultation.finalizeAssurance', config: { onError: 'degrade' } },
  // The one durable human wait. Terminal by rule (WF-CONS-004): nothing
  // executes after it, and the substrate has no signing node at all — signing
  // happens outside, by a human.
  {
    id: 'n_gate',
    type: 'consultation.hitlGate',
    config: { gateType: 'clinician_review', blocking: true, timeoutSeconds: 3600, onTimeout: 'TIMED_OUT' },
  },
  { id: 'n_end', type: 'core.end', config: {} },
];

export const buildExampleGraph = (options: ExampleGraphOptions) => ({
  version: 1,
  nodes: consultationNodes(options),
  edges: edges([
    // ---- ordering ------------------------------------------------------------------------
    ['n_start', 'next', 'n_consent', 'after'],
    // The consent gate's `out` IS the authorization signal — a `control` port, not data.
    ['n_consent', 'out', 'n_capture', 'after'],
    ['n_entities', 'next', 'n_phi', 'after'],
    ['n_phi', 'next', 'n_prompt', 'after'],
    ['n_assure', 'next', 'n_gate', 'after'],
    ['n_gate', 'next', 'n_end', 'after'],

    // ---- realtime branches off capture, rejoining at extraction --------------------------
    // ⚠ `captureBinding.out` is DESIGN INTENT (see `node-ports.ts`): the activity
    // starts the live-documentation session and emits `{action, consultationId}`, no
    // transcript yet. The edges are authored because this is the palette's declared
    // transcript path and WF-CONS-012's mandatory hop; until the activity publishes
    // one, the interpreter contributes nothing for it and the consumers degrade.
    ['n_capture', 'out', 'n_entities', 'in'],
    ['n_capture', 'out', 'n_realtime', 'in'],
    ['n_realtime', 'next', 'n_entities', 'after'],
    ...(options.grammar
      ? ([
          ['n_capture', 'out', 'n_grammar', 'in'],
          ['n_grammar', 'next', 'n_entities', 'after'],
        ] as const)
      : []),

    // ---- the durable note chain ----------------------------------------------------------
    ['n_prompt', 'out', 'n_synth', 'in'],
    ['n_synth', 'out', 'n_sensors', 'in'],
    ['n_sensors', 'document', 'n_persist', 'in'],
    ['n_sensors', 'out', 'n_persist', 'verdict'],
    ['n_persist', 'out', 'n_assure', 'in'],
    // `persistDraft` emits the `contextItemId` `finalizeAssurance` must target;
    // it is a SEPARATE socket from `out` so the interpreter's last-write-wins
    // `toPort` binding cannot drop one of the two.
    ['n_persist', 'contextItemId', 'n_assure', 'contextItemId'],
    ['n_sensors', 'out', 'n_assure', 'verdict'],
  ]),
});

/** Grammar fix only — NER present but switched OFF. */
export const GRAMMAR_FIX_GRAPH = buildExampleGraph({ grammar: true, entities: false });
/** Medical NER only — no grammar pass. */
export const MEDICAL_NER_GRAPH = buildExampleGraph({ grammar: false, entities: true });
/** Both agents. */
export const NER_GRAMMAR_FIX_GRAPH = buildExampleGraph({ grammar: true, entities: true });

// =============================================================================
// Derived blobs — GENERATED, never hand-typed. See the module docstring.
// Regenerate: pnpm --filter @arcaai/workflow-contract build
//             pnpm --filter @arcaai/database exec tsx scripts/regen-example-consultation-workflow-seed.ts
// =============================================================================

export {
  ARCAAI_GRAMMAR_FIX_COMPILED_CONFIG,
  ARCAAI_MEDICAL_NER_COMPILED_CONFIG,
  ARCAAI_NER_GRAMMAR_FIX_COMPILED_CONFIG,
  GRAMMAR_FIX_GRAPH_CHECKSUM,
  GRAMMAR_FIX_VALIDATION_REPORT,
  MEDICAL_NER_GRAPH_CHECKSUM,
  MEDICAL_NER_VALIDATION_REPORT,
  NER_GRAMMAR_FIX_GRAPH_CHECKSUM,
  NER_GRAMMAR_FIX_VALIDATION_REPORT,
  PLATFORM_GRAMMAR_FIX_COMPILED_CONFIG,
  PLATFORM_MEDICAL_NER_COMPILED_CONFIG,
  PLATFORM_NER_GRAMMAR_FIX_COMPILED_CONFIG,
  REGISTRY_CHECKSUM,
} from './24-example-consultation-workflows.generated';

// =============================================================================
// Rows
// =============================================================================

/** The three variants, as the regen script and the tests both enumerate them. */
export const EXAMPLE_WORKFLOW_VARIANTS = [
  {
    key: 'GRAMMAR_FIX' as const,
    graph: GRAMMAR_FIX_GRAPH,
    graphChecksum: GRAMMAR_FIX_GRAPH_CHECKSUM,
    validationReport: GRAMMAR_FIX_VALIDATION_REPORT,
    platformSlug: 'platform-consultation-grammar-fix',
    platformName: 'Consultation with Grammar Fix (platform template)',
    arcaaiSlug: 'arcaai-consultation-grammar-fix',
    arcaaiName: 'Consultation with Grammar Fix',
    platformId: '99000000-0000-0000-0003-000000000001',
    arcaaiId: '99000000-0000-0000-0003-000000000011',
    platformCompiledConfig: PLATFORM_GRAMMAR_FIX_COMPILED_CONFIG,
    arcaaiCompiledConfig: ARCAAI_GRAMMAR_FIX_COMPILED_CONFIG,
    description:
      'Realtime transcription, the live grammar/spelling agent over the partial transcript, partial summarization and finalization. The medical NER agent is present but switched OFF (config.enabled: false) — WF-CONS-012 requires the node structurally, so "no NER" is expressed by the per-node toggle rather than by deleting it.',
    tags: ['example', 'consultation', 'grammar-fix'],
  },
  {
    key: 'MEDICAL_NER' as const,
    graph: MEDICAL_NER_GRAPH,
    graphChecksum: MEDICAL_NER_GRAPH_CHECKSUM,
    validationReport: MEDICAL_NER_VALIDATION_REPORT,
    platformSlug: 'platform-consultation-medical-ner',
    platformName: 'Consultation with Medical NER (platform template)',
    arcaaiSlug: 'arcaai-consultation-medical-ner',
    arcaaiName: 'Consultation with Medical NER',
    platformId: '99000000-0000-0000-0003-000000000002',
    arcaaiId: '99000000-0000-0000-0003-000000000012',
    platformCompiledConfig: PLATFORM_MEDICAL_NER_COMPILED_CONFIG,
    arcaaiCompiledConfig: ARCAAI_MEDICAL_NER_COMPILED_CONFIG,
    description:
      'Realtime transcription, the medical NER agent (blaze999/Medical-NER through nlp.ner), partial summarization and finalization. No live grammar pass.',
    tags: ['example', 'consultation', 'medical-ner'],
  },
  {
    key: 'NER_GRAMMAR_FIX' as const,
    graph: NER_GRAMMAR_FIX_GRAPH,
    graphChecksum: NER_GRAMMAR_FIX_GRAPH_CHECKSUM,
    validationReport: NER_GRAMMAR_FIX_VALIDATION_REPORT,
    platformSlug: 'platform-consultation-ner-grammar-fix',
    platformName: 'Consultation with Medical NER and Grammar Fix (platform template)',
    arcaaiSlug: 'arcaai-consultation-ner-grammar-fix',
    arcaaiName: 'Consultation with Medical NER and Grammar Fix',
    platformId: '99000000-0000-0000-0003-000000000003',
    arcaaiId: '99000000-0000-0000-0003-000000000013',
    platformCompiledConfig: PLATFORM_NER_GRAMMAR_FIX_COMPILED_CONFIG,
    arcaaiCompiledConfig: ARCAAI_NER_GRAMMAR_FIX_COMPILED_CONFIG,
    description:
      'Realtime transcription, the medical NER agent and the live grammar/spelling agent running concurrently off the same flush, partial summarization and finalization.',
    tags: ['example', 'consultation', 'medical-ner', 'grammar-fix'],
  },
];

const definitionRow = (
  variant: (typeof EXAMPLE_WORKFLOW_VARIANTS)[number],
  scope: 'platform' | 'arcaai',
): Record<string, unknown> & { id: string; slug: string; tenantId: string } => {
  const platform = scope === 'platform';
  const compiledConfig = platform ? variant.platformCompiledConfig : variant.arcaaiCompiledConfig;
  return {
    id: platform ? variant.platformId : variant.arcaaiId,
    tenantId: platform ? SYSTEM_TENANT_ID : ARCAAI,
    slug: platform ? variant.platformSlug : variant.arcaaiSlug,
    name: platform ? variant.platformName : variant.arcaaiName,
    description: platform ? `${variant.description} Platform template — clone it to author a tenant copy.` : variant.description,
    paletteKey: 'consultation',
    versionNumber: 1,
    parentVersionId: null,
    status: 'PUBLISHED' as const,
    isActive: true,
    graph: variant.graph,
    graphChecksum: variant.graphChecksum,
    compiledConfig,
    compiledConfigChecksum: (compiledConfig as { checksum: string }).checksum,
    registryChecksum: REGISTRY_CHECKSUM,
    validationReport: variant.validationReport,
    needsReview: false,
    validatedAt: new Date(COMPILED_AT),
    publishedAt: new Date(COMPILED_AT),
    tags: platform ? ['platform-template', ...variant.tags] : ['arcaai', 'tenant-authored', ...variant.tags],
    // SYSTEM rows assert no human authorship; the ArcaAI rows assert that a
    // TENANT admin authored them, which is the whole claim of the tenant half.
    createdBy: platform ? SYSTEM_USER_ID : SEED_USER_IDS.ARCAAI_ADMIN,
  };
};

export const PLATFORM_EXAMPLE_WORKFLOW_DEFINITIONS = EXAMPLE_WORKFLOW_VARIANTS.map((variant) => definitionRow(variant, 'platform'));
export const ARCAAI_EXAMPLE_WORKFLOW_DEFINITIONS = EXAMPLE_WORKFLOW_VARIANTS.map((variant) => definitionRow(variant, 'arcaai'));

// =============================================================================
// Seed functions
// =============================================================================

const createDefinitions = async (client: CorePrismaClient, rows: ReadonlyArray<Record<string, unknown> & { id: string; slug: string }>) => {
  let created = 0;
  let skipped = 0;
  for (const row of rows) {
    // CREATE-ONLY. A PUBLISHED WorkflowDefinition is immutable at three
    // application layers AND at a database trigger — an upsert with an `update`
    // branch would raise at the DB.
    const existing = await client.workflowDefinition.findUnique({ where: { id: row.id }, select: { id: true } });
    if (existing) {
      skipped += 1;
      continue;
    }
    await client.workflowDefinition.create({
      data: {
        ...row,
        graph: row.graph as never,
        compiledConfig: row.compiledConfig as never,
        validationReport: row.validationReport as never,
      } as never,
    });
    created += 1;
  }
  return { created, skipped };
};

/** SYSTEM templates — platform configuration, so this phase runs in `safe` too. */
export const seedExampleConsultationWorkflowTemplates = async (client: CorePrismaClient) => {
  console.log('Seeding the three example consultation workflow TEMPLATES ...');
  const { created, skipped } = await createDefinitions(client, PLATFORM_EXAMPLE_WORKFLOW_DEFINITIONS);
  console.log(`  ✓ SYSTEM templates: ${created} created, ${skipped} skipped`);
  return { success: true as const, created, skipped };
};

/** The ArcaAI tenant's own copies — excluded from `safe` (fabricated authorship). */
export const seedArcaaiExampleConsultationWorkflows = async (client: CorePrismaClient) => {
  console.log('Seeding the three example consultation workflows for the ArcaAI tenant ...');
  const { created, skipped } = await createDefinitions(client, ARCAAI_EXAMPLE_WORKFLOW_DEFINITIONS);
  console.log(`  ✓ ArcaAI workflows: ${created} created, ${skipped} skipped (selectable at session-open; NOT assigned)`);
  return { success: true as const, created, skipped };
};
