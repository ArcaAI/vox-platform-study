/**
 * TASK-798 — the tenant-authored consultation workflow (R1), and the fixtures that let it be
 * tested (R2).
 *
 * ## What was missing
 *
 * The requirement is "the harness agentic loop workflows are defined by tenant admin". The
 * machinery for that exists end to end: Workflow Studio authors a `consultation`-palette graph,
 * `WorkflowDefinitionService` validates and compiles it at publish, `WorkflowAssignment` binds it
 * to a scope, and `ConsultationWorkflowDispatchService` resolves the cascade at consultation open.
 *
 * The DATABASE, however, contained zero consultation-palette definitions and zero assignments —
 * 153 `summarization` rows and one `test` row, all but one of them DRAFT. So every consultation
 * resolved `platform-default` and the default engine ran. The requirement was true in code and
 * false in practice. This file is the row that closes that gap.
 *
 * ## Provenance — read before editing any blob below
 *
 * `graph` is AUTHORED. `graphChecksum`, `compiledConfig`, `compiledConfigChecksum`,
 * `registryChecksum` and `validationReport` are ENGINE OUTPUT: the literal result of
 * `packages/workflow-contract`'s real `validate()` / `compile()` / `registryChecksum()`, produced
 * by `packages/database/scripts/regen-arcaai-consultation-workflow-seed.ts` and pasted verbatim.
 * None of them may be hand-typed or hand-patched.
 *
 * A fabricated clean validation report would be worse than no seed at all — it would assert a
 * safety verdict nothing ever reached. `task-798-arcaai-workflow-authoring.test.ts` therefore
 * re-runs the real engine and compares, so the literals cannot drift or be invented: when the
 * node registry moves, that suite goes RED and the script must be re-run.
 *
 * `packages/database` deliberately takes NO dependency on `@arcaai/workflow-contract` — adding one
 * edits the shared root `pnpm-lock.yaml`, a collision surface while sibling agents share this
 * repo. The script and the test both reach the engine by relative path instead.
 *
 * `registryChecksum` is the CURRENT value. It used to be the ONLY current one — the SYSTEM
 * platform-default row (`21-workflow-definition.ts`) carried a checksum computed over a
 * SEVEN-entry registry long after the registry had outgrown it. TASK-809 OD-15 regenerated that
 * row too (its edges had to migrate to named sockets), so both are now current and both are
 * reproducible by re-running their scripts. Neither may be hand-typed.
 *
 * ## Why these graphs, and why two
 *
 * The graphs are not a minimal rule-satisfying skeleton. They walk the capability chain the
 * requirement names: capture -> transcribe -> extract entities -> realtime summary -> assemble and
 * synthesize into SOAP -> verify -> persist -> clinician gate. Every node is a registered,
 * `implemented: true` palette entry with a real interpreter activity behind it.
 *
 * Two definitions, because "department changes the behaviour" has to be observable rather than
 * asserted. The Rheumatology graph differs in two ways that a reader can point at:
 *
 *   - it adds `consultation.inferentialSensors` — the LLM-as-judge verification pass;
 *   - its `consultation.assemblePrompt` binds `dnaStyleId` to Dr Nair's DNA writing-style report.
 *     That node config is the ONLY place in the platform where a SPECIFIC writing style can be
 *     selected: `DepartmentAgent.dnaStylePolicy` is `INHERIT | DISABLED`, a gate rather than a
 *     selector, so everywhere else the style follows whoever is logged in.
 *
 * ## The assignment rows ship DISABLED — see `substrate-exclusivity-guard.ts`
 *
 * A definition governs nothing until a `WorkflowAssignment` binds it. That binding is currently
 * UNSAFE: Substrate B's `consultation.persistDraft` calls the same `persist_draft` activity
 * Substrate A uses, and nothing yet suppresses Substrate A for a governed consultation. Two
 * writers, one clinical document.
 *
 * So the assignment rows are authored, tested and NOT written, behind
 * `CONSULTATION_ASSIGNMENT_ENABLED`. The guard module — not anyone's recollection — decides
 * whether the mechanism exists. Do not flip the flag by hand without reading it.
 */
import type { CorePrismaClient } from '../../../client';
import { SEED_CUSTOMER_TENANT_IDS, SEED_DEPARTMENT_IDS, SEED_USER_IDS } from './00-constants';
import { CUSTOMER_DNA_CLINICIANS } from './08-dna-writing-style';
import {
  GEN_COMPILED_CONFIG,
  GEN_GRAPH_CHECKSUM,
  GEN_VALIDATION_REPORT,
  REGISTRY_CHECKSUM,
  RHEUM_COMPILED_CONFIG,
  RHEUM_GRAPH_CHECKSUM,
  RHEUM_VALIDATION_REPORT,
} from './23-arcaai-workflow-authoring.generated';
import { encryptSeedRow } from './phi-encryption';
import { detectSubstrateExclusivityGate } from './substrate-exclusivity-guard';

const ARCAAI = SEED_CUSTOMER_TENANT_IDS.ARCAAI;

/**
 * The Rheumatology clinician's DNA writing-style report, looked up rather than re-typed: the ids
 * live as literals inside `CUSTOMER_DNA_CLINICIANS`, so a copy here would be a second place to
 * keep in step. Throws rather than silently binding `undefined` — a graph that pins a style that
 * does not exist is worse than one that pins none.
 */
const dnaReportIdForDepartment = (departmentId: string): string => {
  const clinician = CUSTOMER_DNA_CLINICIANS.find((entry) => entry.departmentId === departmentId);
  if (!clinician) throw new Error(`TASK-798: no seeded DNA writing-style report for department ${departmentId}`);
  return clinician.reportId;
};

/** Pinned so every derived blob is reproducible; a wall-clock value would make them un-diffable. */
export const COMPILED_AT = '2026-08-23T00:00:00.000Z';

export const ARCAAI_CONSULTATION_SOAP_ID = '99000000-0000-0000-0001-000000000001';
export const ARCAAI_RHEUM_CONSULTATION_SOAP_ID = '99000000-0000-0000-0001-000000000002';

export const ARCAAI_CONSULTATION_SOAP_SLUG = 'arcaai-consultation-soap';
export const ARCAAI_RHEUM_CONSULTATION_SOAP_SLUG = 'arcaai-rheum-consultation-soap';

// =============================================================================
// The authored graphs (regeneration INPUT — everything below them is derived)
// =============================================================================

/**
 * TASK-809 OD-15 — the edge builder, replacing the old `chain()` helper.
 *
 * `chain()` wired every consecutive pair as `fromPort: 'out'` -> `toPort: 'in'`, which is the
 * untyped convention the node contract abolished: one port cannot simultaneously mean "the
 * transcript" and "run me after the consent gate", and no interpreter activity has ever emitted
 * an output key called `"out"`. Every edge below therefore names a REAL socket from
 * `packages/workflow-contract/src/node-ports.ts`, and each is one of two kinds:
 *
 *   - **ordering** (`control`): `next` -> `after`, or `out` -> `after` off a gate, whose `out` IS
 *     a control signal. Carries no payload; the interpreter binds nothing for it.
 *   - **data**: a typed socket pair the type lattice accepts. These are what actually reach the
 *     activity as `bound_inputs`, keyed by `toPort`.
 *
 * An ordering edge is omitted wherever a data edge between the same pair already implies the
 * order — the two would be redundant, and a redundant control edge reads as a second, weaker
 * claim about the same dependency.
 *
 * ## Why the data edges are exactly these, and not the obvious larger set
 *
 * The palette's own structural rules are `allPathsPassThrough` checks, not "a path exists"
 * checks: WF-CONS-008/009/010/011 require EVERY route from `consentGate` to `hitlGate` to pass
 * through `captureBinding`, `phiHop`, `synthesize` and `sensors`, and WF-CONS-012 requires every
 * route from `captureBinding` to `synthesize` to pass through `extractEntities`. So a data edge
 * that skips a mandatory node does not merely look untidy — it makes the graph fail validation.
 * `captureBinding -> realtimeSummary` is the clearest casualty: it jumps `extractEntities`, and
 * WF-CONS-012 refuses it. The transcript-typed inputs of `realtimeSummary`, `phiHop` and
 * `suggestions` are therefore left UNWIRED, which is honest: their activities resolve what they
 * need server-side from `consultationId`, exactly as `assemblePrompt` already does.
 */
type SeedEdge = { id: string; from: string; fromPort: string; to: string; toPort: string };

const edges = (specs: readonly (readonly [string, string, string, string])[]): SeedEdge[] =>
  specs.map(([from, fromPort, to, toPort], index) => ({ id: `e${index + 1}`, from, fromPort, to, toPort }));

/** Shared spine. `dnaStyleId` is the one per-department difference in the compose stage. */
const consultationNodes = (options: { dnaStyleId: string | null; inferentialSensors: boolean }) => [
  { id: 'n_start', type: 'core.start', config: {} },
  // Identity is read from `run_payload`, never from config — a consent decision configured into
  // a graph would be a consent decision made at authoring time for every future patient.
  { id: 'n_consent', type: 'consultation.consentGate', config: {} },
  { id: 'n_capture', type: 'consultation.captureBinding', config: { action: 'start', persistSnapshot: true, onError: 'degrade' } },
  // `requiresFinalized: true` is WF-CONS-017 — entity extraction reads the FINALIZED transcript,
  // never a partial one.
  {
    id: 'n_entities',
    type: 'consultation.extractEntities',
    config: { language: 'en', persist: true, requiresFinalized: true, onError: 'degrade' },
  },
  // The realtime short-summary pass the requirement names. `externalWrite`, because it publishes
  // each interim summary to the live consultation feed.
  // `publishTo` was DROPPED here (TASK-809 OD-15): nothing reads it, and the strict
  // `consultation.realtimeSummary` config schema does not declare it — the node publishes to the
  // live consultation feed unconditionally (`nodes/consultation_realtime.py`), so the key was a
  // configuration promise the platform never kept.
  { id: 'n_realtime', type: 'consultation.realtimeSummary', config: { onError: 'degrade' } },
  // `purposeScope` is WF-CONS-013 (a tool-calling node declares its PURPOSE OF USE for the
  // outbound tool call); `unmappedOutputKey` is WF-CONS-019's sibling CR-19 — unmapped terms are
  // SURFACED, never silently dropped.
  //
  // TASK-806 lane A item 19 closed the taxonomy: `purposeScope` now draws from
  // `TERMINOLOGY_PURPOSE_SCOPES`, the `ConsentPurpose` vocabulary restricted to the members that
  // can justify an outbound call. This row said `'terminology.validate'` — a free string written
  // before any taxonomy existed. `EXTERNAL_TOOL_LOOKUP` is what this node's own egress already
  // asks consent for: `call_mcp_tool` checks `purpose="EXTERNAL_TOOL_LOOKUP"`
  // (`apps/harness/.../activities.py:1092`).
  {
    id: 'n_terms',
    type: 'consultation.bindTerminology',
    config: { purposeScope: 'EXTERNAL_TOOL_LOOKUP', unmappedOutputKey: 'unmappedTerms', onError: 'degrade' },
  },
  { id: 'n_phi', type: 'consultation.phiHop', config: { mode: 'pseudonymize', onError: 'degrade' } },
  { id: 'n_evidence', type: 'consultation.retrieveEvidence', config: { retrievalEnabled: true, onError: 'degrade' } },
  {
    id: 'n_prompt',
    type: 'consultation.assemblePrompt',
    config: {
      requiresFinalized: true,
      conversationLanguage: 'en',
      ...(options.dnaStyleId === null ? {} : { dnaStyleId: options.dnaStyleId }),
      onError: 'degrade',
    },
  },
  // `producesCode: false` is WF-CONS-015: only `bindTerminology` may produce a clinical code.
  // The negative must be STATED, not merely absent.
  { id: 'n_synth', type: 'consultation.synthesize', config: { taskKey: 'text.finalize', producesCode: false, onError: 'degrade' } },
  { id: 'n_suggest', type: 'consultation.suggestions', config: { onError: 'degrade' } },
  // Proposes spelling / medical-term / drug-name corrections and applies none of them — the
  // clinician accepts. `externalWrite: false` on this node is a safety property, not a perf one.
  { id: 'n_correct', type: 'consultation.proposeCorrections', config: { onError: 'degrade' } },
  { id: 'n_sensors', type: 'consultation.sensors', config: { onError: 'degrade' } },
  ...(options.inferentialSensors ? [{ id: 'n_infer', type: 'consultation.inferentialSensors', config: { onError: 'degrade' } }] : []),
  // `occ: true` is WF-CONS-014 — the authorship protection made structural.
  { id: 'n_persist', type: 'consultation.persistDraft', config: { occ: true, onError: 'degrade' } },
  { id: 'n_assure', type: 'consultation.finalizeAssurance', config: { onError: 'degrade' } },
  // The one durable human wait. Terminal by rule (WF-CONS-004): nothing executes after it, and
  // the substrate has no signing node at all — signing happens outside, by a human.
  {
    id: 'n_gate',
    type: 'consultation.hitlGate',
    config: { gateType: 'clinician_review', blocking: true, timeoutSeconds: 3600, onTimeout: 'TIMED_OUT' },
  },
  { id: 'n_end', type: 'core.end', config: {} },
];

const buildGraph = (options: { dnaStyleId: string | null; inferentialSensors: boolean }) => {
  const nodes = consultationNodes(options);
  // The verifier stage: `sensors` alone, or `sensors -> inferentialSensors`. Whichever runs LAST
  // is the one that hands the note on, because both verifiers pass the note through unchanged on
  // their `document` socket while their `out` socket carries the verdict object.
  const lastVerifier = options.inferentialSensors ? 'n_infer' : 'n_sensors';
  return {
    version: 1,
    nodes,
    edges: edges([
      // ---- ordering ------------------------------------------------------------------------
      ['n_start', 'next', 'n_consent', 'after'],
      // The consent gate's `out` IS the authorization signal — a `control` port, not data.
      ['n_consent', 'out', 'n_capture', 'after'],
      ['n_realtime', 'next', 'n_terms', 'after'],
      ['n_terms', 'next', 'n_phi', 'after'],
      ['n_phi', 'next', 'n_evidence', 'after'],
      ['n_synth', 'next', 'n_suggest', 'after'],
      ['n_suggest', 'next', 'n_correct', 'after'],
      ['n_correct', 'next', 'n_sensors', 'after'],
      // The gate is `gate`-classed: the compiler lifts it out of `stages` into `gates`, and
      // `CompiledGate` has no `inputs`, so NO edge into it is ever compiled to a binding. It is
      // wired as pure ordering for that reason — a data edge here would promise a thread the
      // runtime cannot honour.
      ['n_assure', 'next', 'n_gate', 'after'],
      ['n_gate', 'next', 'n_end', 'after'],

      // ---- data ----------------------------------------------------------------------------
      // ⚠ `captureBinding.out` is DESIGN INTENT (see `node-ports.ts`): the activity starts the
      // live-documentation session and emits `{action, consultationId}`, no transcript yet. The
      // edge is authored because it is the palette's declared transcript path and WF-CONS-012's
      // mandatory hop; until the activity publishes one, the interpreter contributes nothing for
      // it and `extractEntities` degrades on `no_bound_text` — exactly as it does today.
      ['n_capture', 'out', 'n_entities', 'in'],
      ['n_entities', 'out', 'n_realtime', 'entities'],
      ['n_entities', 'out', 'n_terms', 'in'],
      // TASK-806 lane A item 18 — ORDERING, not data. `consultation.assemblePrompt` no longer
      // declares a `transcript` input: the gateway assembles the prompt from the consultation's
      // own persisted transcript, so a second one over a port could only duplicate it inside the
      // prompt. The PHI hop must still precede the prompt (WF-CONS-009 is an allPathsPassThrough
      // check), and an `after` edge is what an ordering dependency is for.
      ['n_phi', 'next', 'n_prompt', 'after'],
      ['n_evidence', 'out', 'n_prompt', 'in'],
      ['n_prompt', 'out', 'n_synth', 'in'],
      // `document ⊑ text`: the correction pass proposes over any clinical text, including a
      // generated note — safe because its product is `edits`, which no extraction node consumes.
      ['n_synth', 'out', 'n_correct', 'in'],
      ['n_synth', 'out', 'n_sensors', 'in'],
      ...(options.inferentialSensors
        ? ([
            ['n_sensors', 'document', 'n_infer', 'in'],
            ['n_sensors', 'out', 'n_infer', 'verdict'],
            // The inferential verdict rides its OWN socket all the way to persistence. Sharing
            // `verdict` with the computational sensors would lose one of them: the interpreter
            // binds by `toPort`, last write wins.
            ['n_infer', 'out', 'n_persist', 'assurance'],
            ['n_infer', 'out', 'n_assure', 'assurance'],
          ] as const)
        : []),
      [lastVerifier, 'document', 'n_persist', 'in'],
      ['n_sensors', 'out', 'n_persist', 'verdict'],
      ['n_persist', 'out', 'n_assure', 'in'],
      // The edge that had no legal expression before OD-15: `persistDraft` emits the
      // `contextItemId` `finalizeAssurance` must target, yet both declared `[next]` only.
      ['n_persist', 'contextItemId', 'n_assure', 'contextItemId'],
      ['n_sensors', 'out', 'n_assure', 'verdict'],
    ]),
  };
};

/** General Medicine — the baseline chain. */
export const ARCAAI_CONSULTATION_GRAPH = buildGraph({ dnaStyleId: null, inferentialSensors: false });

/** Rheumatology — adds the LLM-as-judge pass and pins the department clinician's writing style. */
export const ARCAAI_RHEUM_CONSULTATION_GRAPH = buildGraph({
  dnaStyleId: dnaReportIdForDepartment(SEED_DEPARTMENT_IDS.RHEUM_ARCAAI),
  inferentialSensors: true,
});

// =============================================================================
// Derived blobs — GENERATED, never hand-typed. See the module docstring.
// Regenerate: pnpm --filter @arcaai/workflow-contract build
//             pnpm --filter @arcaai/database exec tsx scripts/regen-arcaai-consultation-workflow-seed.ts
// =============================================================================

export {
  GEN_COMPILED_CONFIG,
  GEN_GRAPH_CHECKSUM,
  GEN_VALIDATION_REPORT,
  REGISTRY_CHECKSUM,
  RHEUM_COMPILED_CONFIG,
  RHEUM_GRAPH_CHECKSUM,
  RHEUM_VALIDATION_REPORT,
} from './23-arcaai-workflow-authoring.generated';

// =============================================================================
// Rows
// =============================================================================

export const ARCAAI_WORKFLOW_DEFINITIONS = [
  {
    id: ARCAAI_CONSULTATION_SOAP_ID,
    tenantId: ARCAAI,
    slug: ARCAAI_CONSULTATION_SOAP_SLUG,
    name: 'ArcaAI Consultation — SOAP Documentation',
    description:
      'Tenant-authored consultation workflow: consent, capture and transcription, entity extraction, realtime interim summaries, terminology binding, PHI pseudonymisation, evidence retrieval, SOAP synthesis with suggestions and correction proposals, computational verification, OCC-protected draft persistence and a blocking clinician review gate.',
    paletteKey: 'consultation',
    versionNumber: 1,
    parentVersionId: null,
    status: 'PUBLISHED' as const,
    isActive: true,
    graph: ARCAAI_CONSULTATION_GRAPH,
    graphChecksum: GEN_GRAPH_CHECKSUM,
    compiledConfig: GEN_COMPILED_CONFIG,
    compiledConfigChecksum: (GEN_COMPILED_CONFIG as { checksum: string }).checksum,
    registryChecksum: REGISTRY_CHECKSUM,
    validationReport: GEN_VALIDATION_REPORT,
    needsReview: false,
    validatedAt: new Date(COMPILED_AT),
    publishedAt: new Date(COMPILED_AT),
    tags: ['arcaai', 'consultation', 'tenant-authored'],
    // NOT the SYSTEM user. The entire claim of this row is that a TENANT admin authored it.
    createdBy: SEED_USER_IDS.ARCAAI_ADMIN,
  },
  {
    id: ARCAAI_RHEUM_CONSULTATION_SOAP_ID,
    tenantId: ARCAAI,
    slug: ARCAAI_RHEUM_CONSULTATION_SOAP_SLUG,
    name: 'ArcaAI Rheumatology Consultation — SOAP Documentation',
    description:
      'The Rheumatology variant: the same spine plus an inferential (LLM-as-judge) verification pass, with the compose stage pinned to the department clinician’s DNA writing style.',
    paletteKey: 'consultation',
    versionNumber: 1,
    parentVersionId: null,
    status: 'PUBLISHED' as const,
    isActive: true,
    graph: ARCAAI_RHEUM_CONSULTATION_GRAPH,
    graphChecksum: RHEUM_GRAPH_CHECKSUM,
    compiledConfig: RHEUM_COMPILED_CONFIG,
    compiledConfigChecksum: (RHEUM_COMPILED_CONFIG as { checksum: string }).checksum,
    registryChecksum: REGISTRY_CHECKSUM,
    validationReport: RHEUM_VALIDATION_REPORT,
    needsReview: false,
    validatedAt: new Date(COMPILED_AT),
    publishedAt: new Date(COMPILED_AT),
    tags: ['arcaai', 'consultation', 'tenant-authored', 'rheumatology'],
    createdBy: SEED_USER_IDS.ARCAAI_ADMIN,
  },
];

export const ARCAAI_WORKFLOW_ASSIGNMENTS = [
  {
    id: '9a000000-0000-0000-0001-000000000001',
    tenantId: ARCAAI,
    scope: 'TENANT' as const,
    scopeId: null as string | null,
    paletteKey: 'consultation',
    workflowDefinitionSlug: ARCAAI_CONSULTATION_SOAP_SLUG,
    createdBy: SEED_USER_IDS.ARCAAI_ADMIN,
  },
  {
    id: '9a000000-0000-0000-0001-000000000002',
    tenantId: ARCAAI,
    scope: 'DEPARTMENT' as const,
    scopeId: SEED_DEPARTMENT_IDS.RHEUM_ARCAAI as string | null,
    paletteKey: 'consultation',
    workflowDefinitionSlug: ARCAAI_RHEUM_CONSULTATION_SOAP_SLUG,
    createdBy: SEED_USER_IDS.ARCAAI_ADMIN,
  },
];

/**
 * The append-only WORM change log. `UPDATE`/`DELETE` are REVOKEd for the application role on this
 * table, so these rows are CREATE-ONLY: an upsert would fail at the privilege layer.
 */
export const ARCAAI_WORKFLOW_ASSIGNMENT_CHANGES = [
  {
    id: '9a000000-0000-0001-0001-000000000001',
    tenantId: ARCAAI,
    scope: 'TENANT' as const,
    scopeId: null as string | null,
    paletteKey: 'consultation',
    changedBy: SEED_USER_IDS.ARCAAI_ADMIN,
    assignmentVersion: 1,
    beforeSlug: null as string | null,
    afterSlug: ARCAAI_CONSULTATION_SOAP_SLUG,
    reason: 'Seeded day-1 tenant-authored consultation workflow assignment (TASK-798).',
  },
  {
    id: '9a000000-0000-0001-0001-000000000002',
    tenantId: ARCAAI,
    scope: 'DEPARTMENT' as const,
    scopeId: SEED_DEPARTMENT_IDS.RHEUM_ARCAAI as string | null,
    paletteKey: 'consultation',
    changedBy: SEED_USER_IDS.ARCAAI_ADMIN,
    assignmentVersion: 1,
    beforeSlug: null as string | null,
    afterSlug: ARCAAI_RHEUM_CONSULTATION_SOAP_SLUG,
    reason: 'Seeded day-1 Rheumatology department override (TASK-798).',
  },
];

/**
 * Workbench fixtures. The key names mirror exactly what the consultation nodes read out of
 * `run_payload` — `consultationId` / `externalPatientId` / `userId` / `sessionId` — plus
 * `transcriptText`, which the sensors node reads.
 *
 * "Synthetic" is a CONTRACT here, not a suggestion: no realistic patient data goes into a fixture,
 * in the seed or anywhere else. These transcripts name no seeded patient and carry no identifier
 * shaped like a real one.
 */
export const ARCAAI_WORKFLOW_TEST_FIXTURES = [
  {
    id: '9b000000-0000-0000-0001-000000000001',
    tenantId: ARCAAI,
    name: 'Synthetic consultation — new patient',
    description: 'SYNTHETIC Workbench input for the ArcaAI consultation graph. Not clinical data.',
    paletteId: 'consultation',
    workflowDefinitionId: ARCAAI_CONSULTATION_SOAP_ID as string | null,
    input: {
      consultationId: '00000000-0000-4000-8000-000000000901',
      externalPatientId: 'SYNTH-001',
      userId: SEED_USER_IDS.ARCAAI_ADMIN,
      sessionId: 'synthetic-fixture-session-001',
      transcriptText:
        'Clinician: Good morning, what brings you in today? Patient: I have had a cough and a mild fever for about four days. Clinician: Any chest pain when you breathe in? Patient: A little, on the right side.',
    },
    createdBy: SEED_USER_IDS.ARCAAI_ADMIN,
  },
  {
    id: '9b000000-0000-0000-0001-000000000002',
    tenantId: ARCAAI,
    name: 'Synthetic consultation — rheumatology revisit',
    description: 'SYNTHETIC tenant-wide Workbench input, usable against any ArcaAI consultation graph. Not clinical data.',
    paletteId: 'consultation',
    workflowDefinitionId: null as string | null,
    input: {
      consultationId: '00000000-0000-4000-8000-000000000902',
      externalPatientId: 'SYNTH-002',
      userId: SEED_USER_IDS.ARCAAI_ADMIN,
      sessionId: 'synthetic-fixture-session-002',
      transcriptText:
        'Clinician: How have the joints been since we last met? Patient: The morning stiffness lasts about an hour now, mostly hands and wrists. Clinician: Any new swelling? Patient: Both wrists feel puffy in the mornings.',
    },
    createdBy: SEED_USER_IDS.ARCAAI_ADMIN,
  },
];

// =============================================================================
// The assignment safety flag
// =============================================================================

/**
 * Whether the `WorkflowAssignment` rows above may actually be written.
 *
 * DERIVED, not decided: it tracks whether the Substrate-A exclusivity mechanism exists. See
 * `substrate-exclusivity-guard.ts` for what is probed, and for the two ways the probe can be
 * wrong. Both failure directions end with the assignment NOT written, or with a RED test — never
 * with a silent enable.
 *
 * Flipping this by hand is not a code change, it is a clinical-safety decision. Read the gate
 * first.
 */
export const CONSULTATION_ASSIGNMENT_ENABLED = detectSubstrateExclusivityGate().present;

export interface SeedArcaaiWorkflowAuthoringOptions {
  /** Overrides the guard — for tests that must exercise BOTH branches. */
  readonly assignmentsEnabled?: boolean;
}

export const seedArcaaiWorkflowAuthoring = async (client: CorePrismaClient, options: SeedArcaaiWorkflowAuthoringOptions = {}) => {
  const assignmentsEnabled = options.assignmentsEnabled ?? CONSULTATION_ASSIGNMENT_ENABLED;

  console.log('Seeding ArcaAI tenant-authored consultation workflows (TASK-798)...');

  let definitionsCreated = 0;
  let definitionsSkipped = 0;

  for (const definition of ARCAAI_WORKFLOW_DEFINITIONS) {
    // CREATE-ONLY. A PUBLISHED WorkflowDefinition is immutable at three application layers AND at
    // a database trigger — an upsert with an `update` branch would raise at the DB.
    const existing = await client.workflowDefinition.findUnique({ where: { id: definition.id }, select: { id: true } });
    if (existing) {
      definitionsSkipped += 1;
      continue;
    }
    await client.workflowDefinition.create({
      data: {
        ...definition,
        graph: definition.graph as never,
        compiledConfig: definition.compiledConfig as never,
        validationReport: definition.validationReport as never,
      },
    });
    definitionsCreated += 1;
  }

  let fixturesWritten = 0;
  for (const fixture of ARCAAI_WORKFLOW_TEST_FIXTURES) {
    // `input` is Vault-Transit ciphertext on disk; the plaintext column was dropped.
    const row = await encryptSeedRow('WorkflowTestFixture', fixture);
    await client.workflowTestFixture.upsert({ where: { id: fixture.id }, create: row as never, update: row as never });
    fixturesWritten += 1;
  }

  let assignmentsWritten = 0;
  if (assignmentsEnabled) {
    for (const assignment of ARCAAI_WORKFLOW_ASSIGNMENTS) {
      // Upsert by `id`, not by the `(tenantId, scope, scopeId, paletteKey)` compound unique:
      // `scopeId` is NULL on the TENANT row, and PostgreSQL treats NULLs in a unique index as
      // distinct, so the compound key cannot address that row.
      await client.workflowAssignment.upsert({ where: { id: assignment.id }, create: assignment as never, update: assignment as never });
      assignmentsWritten += 1;
    }
    for (const change of ARCAAI_WORKFLOW_ASSIGNMENT_CHANGES) {
      // CREATE-ONLY: append-only table, UPDATE/DELETE revoked for the app role.
      const existing = await client.workflowAssignmentChange.findUnique({ where: { id: change.id }, select: { id: true } });
      if (!existing) await client.workflowAssignmentChange.create({ data: change as never });
    }
  } else {
    // LOUD, not silent. A demo that quietly skips the row that makes the demo work is worse than
    // one that fails — and this particular skip is the difference between one writer and two on a
    // clinical document.
    console.warn(
      [
        '',
        '  ┌─ TASK-798 — WorkflowAssignment rows NOT seeded ────────────────────────────',
        '  │ The ArcaAI consultation workflows are published and visible in Workflow',
        '  │ Studio, but nothing is ASSIGNED, so they govern no consultation yet.',
        '  │',
        '  │ Why: binding them requires the Substrate-A exclusivity gate (TASK-795).',
        '  │ Substrate B’s consultation.persistDraft calls the SAME persist_draft',
        '  │ activity Substrate A uses. With an assignment and no gate, BOTH engines',
        '  │ write one clinical ContextItem — two writers, one document.',
        `  │ Probe: ${detectSubstrateExclusivityGate().probedPath}`,
        '  │',
        '  │ To enable: land the gate, then re-run this seed. The flag is derived, not',
        '  │ hand-set — see substrate-exclusivity-guard.ts.',
        '  └────────────────────────────────────────────────────────────────────────────',
        '',
      ].join('\n'),
    );
  }

  console.log(
    `  ✓ Workflow definitions: ${definitionsCreated} created, ${definitionsSkipped} skipped · fixtures: ${fixturesWritten} · assignments: ${assignmentsWritten}${assignmentsEnabled ? '' : ' (GATED — see warning above)'}`,
  );
};
