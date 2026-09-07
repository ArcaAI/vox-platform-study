/**
 * the tenant-authored consultation workflow (R1), and the fixtures that let it be
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
 * SEVEN-entry registry long after the registry had outgrown it. regenerated that
 * row too (its edges had to migrate to named sockets), so both are now current and both are
 * reproducible by re-running their scripts. Neither may be hand-typed.
 *
 * ## Why these graphs, and why four
 *
 * The graphs are not a minimal rule-satisfying skeleton. They walk the capability chain the
 * requirement names: capture -> transcribe -> extract entities -> realtime summary -> assemble and
 * synthesize into SOAP -> verify -> persist -> clinician gate. Every node is a registered,
 * `implemented: true` palette entry with a real interpreter activity behind it.
 *
 * They are ONE spine varied on three axes, because each axis has to be observable rather than
 * asserted:
 *
 *   - DEPARTMENT. The Rheumatology graph adds `consultation.inferentialSensors` — the
 *     LLM-as-judge verification pass — and its `consultation.assemblePrompt` binds `dnaStyleId`
 *     to Dr Nair's DNA writing-style report. That node config is the ONLY place in the platform
 *     where a SPECIFIC writing style can be selected: `DepartmentAgent.dnaStylePolicy` is
 *     `INHERIT | DISABLED`, a gate rather than a selector, so everywhere else the style follows
 *     whoever is logged in.
 *   - VISIT TYPE (TASK-891 D8). The two visit-type graphs are the General Medicine one with a
 *     `documentTemplateSlug` on the realtime node, naming the running case note's SHAPE. A
 *     realtime node names ONE slug, so one workflow cannot serve both visit types — hence two
 *     definitions rather than one parameterised at run time.
 *
 * The unqualified General Medicine graph deliberately names NO slug, which is what keeps a tenant
 * that authored nothing resolving the platform SOAP shape exactly as it did before D8.
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
import { TEMPLATE_IDS } from './07-prompt-template';
import { ARCAAI_CLINICAL_TEMPLATE_IDS } from './07b-arcaai-clinical-templates';
import { CUSTOMER_DNA_CLINICIANS } from './08-dna-writing-style';
import {
  GEN_COMPILED_CONFIG,
  GEN_GRAPH_CHECKSUM,
  GEN_VALIDATION_REPORT,
  NEW_VISIT_COMPILED_CONFIG,
  NEW_VISIT_GRAPH_CHECKSUM,
  NEW_VISIT_VALIDATION_REPORT,
  REGISTRY_CHECKSUM,
  REVISIT_COMPILED_CONFIG,
  REVISIT_GRAPH_CHECKSUM,
  REVISIT_VALIDATION_REPORT,
  RHEUM_COMPILED_CONFIG,
  RHEUM_GRAPH_CHECKSUM,
  RHEUM_VALIDATION_REPORT,
} from './23-arcaai-workflow-authoring.generated';
// TASK-891 (D8) — the two seeded note SHAPES the visit-type graphs name. Imported rather than
// restated so a renamed slug breaks the build here, at the join, instead of failing open at flush
// time to the platform SOAP shape with the cause hidden a layer further in.
import { NEW_VISIT_NOTE_SLUG, REVISIT_NOTE_SLUG } from './27-document-template-library';
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
  if (!clinician) throw new Error(`no seeded DNA writing-style report for department ${departmentId}`);
  return clinician.reportId;
};

/** Pinned so every derived blob is reproducible; a wall-clock value would make them un-diffable. */
export const COMPILED_AT = '2026-08-23T00:00:00.000Z';

export const ARCAAI_CONSULTATION_SOAP_ID = '99000000-0000-0000-0001-000000000001';
export const ARCAAI_RHEUM_CONSULTATION_SOAP_ID = '99000000-0000-0000-0001-000000000002';
export const ARCAAI_NEW_VISIT_CONSULTATION_ID = '99000000-0000-0000-0001-000000000003';
export const ARCAAI_REVISIT_CONSULTATION_ID = '99000000-0000-0000-0001-000000000004';

export const ARCAAI_CONSULTATION_SOAP_SLUG = 'arcaai-consultation-soap';
export const ARCAAI_RHEUM_CONSULTATION_SOAP_SLUG = 'arcaai-rheum-consultation-soap';
export const ARCAAI_NEW_VISIT_CONSULTATION_SLUG = 'arcaai-consultation-new-visit';
export const ARCAAI_REVISIT_CONSULTATION_SLUG = 'arcaai-consultation-revisit';

// =============================================================================
// The authored graphs (regeneration INPUT — everything below them is derived)
// =============================================================================

/**
 * the edge builder, replacing the old `chain()` helper.
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
 *
 * ## CORRECTION: `captureBinding -> realtimeSummary` is NOT refused
 *
 * This docstring used to name that edge as "the clearest casualty" of WF-CONS-012 and leave
 * `realtimeSummary.in` unwired on the strength of it. That was wrong, and it cost the platform a
 * live defect: `RealtimeSummaryHandler` reads exactly one input — `boundText(ctx, 'in')` — so in
 * graph mode the running note was generated from `''` on every flush, while the node's UNREAD
 * `entities` port was the one that carried a binding.
 *
 * WF-CONS-012 constrains where the branch REJOINS, not whether the edge may exist. A branch off
 * capture that rejoins AT `extractEntities` keeps extraction on every route to synthesis — which
 * is exactly the placement `agent.important_findings` was given, and it admits `realtimeSummary`
 * and `agent.grammar` on the same terms. All three now hang off capture and rejoin at extraction.
 *
 * A second constraint, invisible to the validator, pins the PRODUCER as well as the rejoin point:
 * `buildRealtimeLane` drops any binding whose producer is not itself a `realtime` node, so a
 * transcript sourced from `consultation.phiHop` (also `transcript`-typed, and durable) would
 * validate, compile, and then be silently unbound at flush time. `consultation.captureBinding` is
 * the palette's only realtime producer of `transcript`, so it is the only legal source.
 *
 * `phiHop` and `suggestions` keep UNWIRED transcript inputs, and for them the original reasoning
 * still holds: both are durable, and their activities resolve what they need server-side from
 * `consultationId`, exactly as `assemblePrompt` already does.
 */
type SeedEdge = { id: string; from: string; fromPort: string; to: string; toPort: string };

const edges = (specs: readonly (readonly [string, string, string, string])[]): SeedEdge[] =>
  specs.map(([from, fromPort, to, toPort], index) => ({ id: `e${index + 1}`, from, fromPort, to, toPort }));

/**
 * The axes on which a seeded consultation graph varies. Everything else is one shared spine — a
 * second spine would be a second thing to keep in step with the rule set.
 */
export interface ConsultationGraphOptions {
  /** The department clinician's DNA writing-style report, bound in the compose stage. */
  readonly dnaStyleId: string | null;
  /** Adds `consultation.inferentialSensors` — the LLM-as-judge verification pass. */
  readonly inferentialSensors: boolean;
  /**
   * TASK-891 (D8) — the SHAPE of the running case note, named on the realtime node.
   *
   * `null` leaves the key OFF the node entirely, which is what the two pre-existing graphs carry
   * and what keeps their checksums byte-identical across this change. An absent key is not the
   * same as an empty one: `realtimeDocumentTemplateSlug` returns `null` for it and
   * `resolveForGeneration(tenantId)` then falls open to the platform SOAP shape, exactly as it
   * has since before this ticket.
   */
  readonly documentTemplateSlug: string | null;
}

/** Shared spine. `dnaStyleId` is the one per-department difference in the compose stage. */
const consultationNodes = (options: ConsultationGraphOptions) => [
  { id: 'n_start', type: 'core.start', config: {} },
  // Identity is read from `run_payload`, never from config — a consent decision configured into
  // a graph would be a consent decision made at authoring time for every future patient.
  { id: 'n_consent', type: 'consultation.consentGate', config: {} },
  // Lane R (R2) — PRE-SUMMARIZATION, seeded BY DEFAULT (owner ruling,
  //
  // The ruling has two halves and this node is the first: pre-summary resolution is TENANT tier,
  // and a tenant must have an ACTIVE `agent.presummarization` node carrying the prompt that
  // governs it. `PromptResolutionService.resolvePreSummaryPromptId` reads exactly that — an
  // enabled node of this type with a bound `promptTemplateId` in the tenant's PUBLISHED
  // consultation graph — so what this row supplies is the tenant's DECLARATION of which prompt
  // governs pre-summary, not merely another step in the durable walk.
  //
  // The binding is the tenant's OWN tenant-wide pre-summary template (07b), never the SYSTEM
  // default: a tenant tier that resolved to a platform row would be exactly the silent fallback
  // refuses.
  //
  // ⚠ Its `in: context<schemaRef>` is deliberately UNWIRED, and that is the same declared state
  // `n_entities` has lived in since OD-15. The consultation palette has no `on-start` producer of
  // `context<schemaRef>`: the registry's only one is `input.context_binding`, which belongs to the
  // summarization palette and is `critical: true`, so importing it here would let a
  // context-binding failure fail a whole consultation. DD-6's runtime feed is separate work;
  // until it exists the interpreter contributes nothing for the port and the node degrades
  // exactly as `extractEntities` does, while the prompt binding it carries resolves regardless.
  {
    id: 'n_presum',
    type: 'agent.presummarization',
    config: {
      // WF-CONS-015's negative, STATED rather than merely absent — only `bindTerminology` may
      // produce a clinical code.
      producesCode: false,
      promptTemplateId: ARCAAI_CLINICAL_TEMPLATE_IDS.PRE_SUMMARY,
      onError: 'degrade',
    },
  },
  // `agent.presummarization` declares `requires: ['guard.groundedness']`, checked PER NODE
  // INSTANCE by `workflowPublishProblems`. A generated pre-summary is read as clinical history,
  // so an ungrounded one is precisely the claim a clinician would carry forward unchallenged —
  // the guard is the reason the requirement exists, not paperwork to satisfy it.
  { id: 'n_ground_presum', type: 'guard.groundedness', config: { onError: 'degrade' } },
  { id: 'n_capture', type: 'consultation.captureBinding', config: { action: 'start', persistSnapshot: true, onError: 'degrade' } },
  // Lane N — IMPORTANT FINDINGS, the third item of the owner's live-loop
  // acceptance bar and the one found missing outright.
  //
  // It reads the TRANSCRIPT the capture node published, and nothing else on the data side. That
  // is the anti-laundering rule applied where it matters most: a "finding" the note generator
  // invented, then highlighted as clinically IMPORTANT, is the worst shape this failure could
  // take, and `document` does not satisfy `transcript` so the wiring cannot be authored.
  //
  // ⚠ Its ordering edge runs `n_findings -> n_entities`, i.e. findings sits BETWEEN capture and
  // extraction, and that placement is forced by the rule set rather than chosen. WF-CONS-012 is an
  // `allPathsPassThrough` check: EVERY route from `captureBinding` to `synthesize` must cross
  // `extractEntities`. Hanging this node off capture and rejoining anywhere downstream of
  // extraction would open a route that skips it; rejoining after synthesis would skip the PHI hop
  // (WF-CONS-009) and synthesis itself (WF-CONS-010). Routing it INTO extraction is the one shape
  // that satisfies all three.
  //
  // The consequence is that its optional `entities` hint port stays UNWIRED here — the hints come
  // from `n_entities`, which now runs after it, and an edge back would be a cycle. That costs one
  // model call's worth of detector hints and buys three satisfied invariants; the port stays
  // declared because a tenant graph that orders the two differently can use it.
  //
  // `promptTemplateId` is the PLATFORM-DEFAULT instruction (a SYSTEM-tenant `PromptTemplate`, 07).
  // A tenant admin overrides what counts as important by binding its OWN template here — that
  // binding IS the tenant -> SYSTEM cascade for this capability, and there is no in-code default
  // behind it: an unbound node degrades visibly rather than mining by some platform definition.
  {
    id: 'n_findings',
    type: 'agent.important_findings',
    config: {
      promptTemplateId: TEMPLATE_IDS.IMPORTANT_FINDINGS_SYSTEM,
      taskKey: 'text.live',
      onError: 'degrade',
    },
  },
  // the LIVE GRAMMAR pass, which Lane R registered and seeded nowhere.
  //
  // recorded "partial transcript plus advisory corrections" as *"Made to work"*. It was made
  // POSSIBLE — node type, realtime handler, Python activity — and then contained in neither
  // ArcaAI graph, so the pass ran for no tenant at all. This row is what makes it run.
  //
  // ⚠ Its placement is the SAME forced one `n_findings` has, for the same two reasons. WF-CONS-012
  // is an `allPathsPassThrough` check, so a branch off capture rejoining anywhere downstream of
  // extraction opens a route around it, and rejoining after synthesis skips the PHI hop
  // (WF-CONS-009) and synthesis (WF-CONS-010). And `buildRealtimeLane` drops a binding whose
  // producer is not a realtime node, so `consultation.captureBinding` — the palette's only
  // realtime producer of `transcript` — is the only source whose edge survives to flush time.
  //
  // Its `in` is `transcript`, and that is the DIFFERENCE from `n_correct` rather than an
  // oversight: `consultation.proposeCorrections.in` is `text` so the durable pass may review the
  // FINISHED note, while this one reviews the raw partial transcript the clinician is watching
  // grow. Both are seeded; neither replaces the other.
  //
  // Its optional `entities` hint port stays UNWIRED for the reason `n_findings`' does — the hints
  // come from `n_entities`, which now runs after it, and an edge back would be a cycle.
  //
  // `promptTemplateId` is the PLATFORM-DEFAULT instruction (a SYSTEM-tenant `PromptTemplate`, 07),
  // and it is not optional decoration: the realtime handler resolves its system prompt from this
  // binding and THROWS when it is absent, so an unbound node degrades on every flush. A tenant
  // admin overrides the instruction by binding its own template here.
  {
    id: 'n_grammar',
    type: 'agent.grammar',
    config: {
      promptTemplateId: TEMPLATE_IDS.LIVE_GRAMMAR_SYSTEM,
      taskKey: 'text.live',
      onError: 'degrade',
    },
  },
  // `requiresFinalized: true` is WF-CONS-017 — entity extraction reads the FINALIZED transcript,
  // never a partial one.
  {
    id: 'n_entities',
    type: 'consultation.extractEntities',
    config: { language: 'en', persist: true, requiresFinalized: true, onError: 'degrade' },
  },
  // The realtime short-summary pass the requirement names. `externalWrite`, because it publishes
  // each interim summary to the live consultation feed.
  // `publishTo` was DROPPED here: nothing reads it, and the strict
  // `consultation.realtimeSummary` config schema does not declare it — the node publishes to the
  // live consultation feed unconditionally (`nodes/consultation_realtime.py`), so the key was a
  // configuration promise the platform never kept.
  //
  // ⚠ — its `in: transcript` is now WIRED, and its `entities` port is not. That is
  // the reverse of what this seed carried since OD-15, and the reversal is the fix: the realtime
  // handler reads `in` and nothing else, so the note was being generated from an empty string
  // while the port it ignores carried the only binding. Moving it onto the capture branch is what
  // the rule set actually permits (see the module docstring's CORRECTION), and dropping the
  // `entities` edge is required twice over — it would be a cycle once the summary is ordered into
  // extraction, and the PLATFORM-DEFAULT lane leaves the same port unwired on purpose, because
  // wiring it "would make the note wait for NER, serialising the two calls". The seeded graph now
  // agrees with the lane it is meant to be at parity with.
  //
  // TASK-891 (D8) — `documentTemplateSlug` names the SHAPE of the running note (OD-2's third
  // wire-up). `realtimeDocumentTemplateSlug` reads it off the frozen lane and
  // `ensureTemplateResolved` hands it to `DocumentTemplateService.resolveForGeneration(tenantId,
  // slug)`, whose `slug` parameter already existed and nothing passed. It is spread in only when
  // the variant declares one, so the two pre-existing graphs keep byte-identical checksums.
  // `config` is `Record<string, unknown>` on the node type, so this needs no schema change.
  {
    id: 'n_realtime',
    type: 'consultation.realtimeSummary',
    config: {
      onError: 'degrade',
      ...(options.documentTemplateSlug === null ? {} : { documentTemplateSlug: options.documentTemplateSlug }),
    },
  },
  // `purposeScope` is WF-CONS-013 (a tool-calling node declares its PURPOSE OF USE for the
  // outbound tool call); `unmappedOutputKey` is WF-CONS-019's sibling CR-19 — unmapped terms are
  // SURFACED, never silently dropped.
  //
  // lane A item 19 closed the taxonomy: `purposeScope` now draws from
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
  // Lane N — THE FINALIZATION CHAIN, which recorded as unseeded:
  // "`agent.dna_redaction` is absent from both seeded graphs".
  //
  // ## Redaction runs BEFORE grounding, and that ordering is the owner's
  //
  // The specification says grounding evaluates the *redacted* transcript and the *redacted*
  // summary. So the note goes `synthesize -> dna_redaction -> verifier`, and everything that
  // scores the note now scores the REDACTED one. (Earlier programme notes had this the other way
  // round — grounding then redaction. They were wrong, and the port lattice now makes the correct
  // order structural: the redactor emits a `document` the guard consumes, while the guard emits a
  // `verdict` the redactor cannot.)
  //
  // `requireDoctorOptIn: true` reproduces the surviving two-gate behaviour verbatim
  // the TENANT gate is the presence of this node in the published graph, and the DOCTOR's
  // own DNA opt-in still applies. The retired `DepartmentAgent` veto stays retired.
  { id: 'n_dna', type: 'agent.dna_redaction', config: { requireDoctorOptIn: true, onError: 'degrade' } },
  // TASK-882 — the DNA WRITING-STYLE gate as a node. Its presence (enabled) is what lets a
  // doctor's learned writing style reach prompt assembly; the doctor's own opt-out is a
  // per-user preference the gateway honours. Ordering-only, on the branch that rejoins at
  // prompt assembly — it applies nothing itself and carries no data.
  { id: 'n_dna_style', type: 'agent.dna_style', config: { onError: 'degrade' } },
  // The POLICY-DRIVEN grounding pass over the redacted note.
  //
  // Distinct from `n_sensors` rather than a duplicate of it: the sensors node runs the
  // COMPUTATIONAL pass, while this one follows the tenant's own written policies. With no
  // `policies` declared the guard falls back to that same computational pass, which is why the
  // policy binding below is what makes this node worth placing at all.
  //
  // ONE policy is seeded, bound to the platform-default policy body (a SYSTEM-tenant
  // `PromptTemplate`, 07). A tenant admin adds, replaces or disables policies by editing this
  // array on its own graph — that is the "set of policies defined/declared/overwriten by tenant
  // admin" the owner specified, and the platform ships no rubric, no pass mark and no score
  // formula of its own.
  //
  // ⚠ Its `transcript` and `findings` input ports are deliberately UNWIRED, and both are honest
  // rather than unfinished. The palette has no `transcript`-typed producer downstream of the PHI
  // hop, so the guard's engine resolves the consultation transcript server-side from
  // `run_payload` exactly as `consultation.sensors` already does; and `agent.important_findings`
  // is a REALTIME node, so a durable edge from it would name a producer this lane never runs.
  // The same declared-but-unwired state `n_realtime` and `n_presum` have carried since OD-15.
  {
    id: 'n_ground_note',
    type: 'guard.groundedness',
    config: {
      policies: [{ key: 'clinical-note-grounding', appliesTo: 'summary', promptTemplateId: TEMPLATE_IDS.GROUNDING_POLICY_SYSTEM }],
      onError: 'degrade',
    },
  },
  // ⚠ — `promptTemplateId` is NOT optional decoration, for the same reason it is not on
  // `n_correct` below. The activity resolves its system prompt from this binding and DEGRADES when
  // it is absent; it used to run on a Python constant (`_SUGGESTION_SYSTEM_PROMPT`), which is the
  // hardcoded configuration `00-project-context.md` §Configuration Principles forbids and which no
  // tenant could read, change or version-pin.
  //
  // It binds its OWN row rather than reusing either correction body: those two review existing
  // words for error and may add nothing, while this node's whole purpose is to raise what is
  // absent. A tenant admin overrides it by binding its own template here.
  {
    id: 'n_suggest',
    type: 'consultation.suggestions',
    config: { promptTemplateId: TEMPLATE_IDS.LIVE_SUGGESTIONS_SYSTEM, onError: 'degrade' },
  },
  // Proposes spelling / medical-term / drug-name corrections and applies none of them — the
  // clinician accepts. `externalWrite: false` on this node is a safety property, not a perf one.
  //
  // ⚠ — `promptTemplateId` is NOT optional decoration. The activity resolves its system
  // prompt from this binding and DEGRADES when it is absent; it used to run on a Python constant
  // (`_CORRECTION_SYSTEM_PROMPT`), which is the hardcoded configuration
  // `00-project-context.md` §Configuration Principles forbids and which no tenant could read,
  // change or version-pin.
  //
  // It binds NOTE_CORRECTIONS_SYSTEM and not the LIVE_GRAMMAR_SYSTEM row `n_grammar` uses, for
  // the same reason the two nodes both exist: this one is fed from `n_synth`, so it reviews a
  // FINISHED note, while `n_grammar` reviews the partial transcript the clinician is watching
  // grow. One instruction cannot be right about both. A tenant admin overrides it by binding its
  // own template here.
  {
    id: 'n_correct',
    type: 'consultation.proposeCorrections',
    config: { promptTemplateId: TEMPLATE_IDS.NOTE_CORRECTIONS_SYSTEM, onError: 'degrade' },
  },
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

const buildGraph = (options: ConsultationGraphOptions) => {
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
      // Lane N — findings mine the same raw transcript NER does, and are ordered INTO extraction
      // so no route from capture to synthesis can skip `extractEntities` (WF-CONS-012). See the
      // node comment for why this is the only placement the rule set admits.
      ['n_capture', 'out', 'n_findings', 'in'],
      ['n_findings', 'next', 'n_entities', 'after'],
      // the LIVE GRAMMAR pass, on the same branch and for the same reasons. Its
      // `out: edits` is deliberately consumed by NOTHING: corrections are advisory alongside the
      // raw transcript, and an edge out of `out` would be a second promotion channel beside the
      // accepted-proposal path the clinician actually approves through.
      ['n_capture', 'out', 'n_grammar', 'in'],
      ['n_grammar', 'next', 'n_entities', 'after'],
      // the running note reads the CAPTURED TRANSCRIPT. This edge is what the
      // module docstring wrongly recorded as refused by WF-CONS-012; rejoining at extraction (the
      // line below) is what keeps every capture->synthesize route crossing `extractEntities`.
      // `n_entities -> n_realtime.entities` is GONE with it: it would now be a cycle, the handler
      // never read it, and the platform-default lane leaves that port unwired on purpose.
      ['n_capture', 'out', 'n_realtime', 'in'],
      ['n_realtime', 'next', 'n_entities', 'after'],
      ['n_entities', 'out', 'n_terms', 'in'],
      // lane A item 18 — ORDERING, not data. `consultation.assemblePrompt` no longer
      // declares a `transcript` input: the gateway assembles the prompt from the consultation's
      // own persisted transcript, so a second one over a port could only duplicate it inside the
      // prompt. The PHI hop must still precede the prompt (WF-CONS-009 is an allPathsPassThrough
      // check), and an `after` edge is what an ordering dependency is for.
      ['n_phi', 'next', 'n_prompt', 'after'],
      // ---- Lane R (R2): the pre-summarization branch ---------------------------------------
      //
      // It hangs off the PHI HOP, and the rule set is what decides that rather than taste.
      // `agent.presummarization` is a GENERATION node, and WF-CONS-009 requires every route from
      // the consent gate to the HITL gate to pass through `consultation.phiHop` — so a generation
      // node placed EARLIER would either be unreachable or would open a route that generates from
      // un-redacted text, which is the precise thing that rule exists to forbid. Branching after
      // the hop and rejoining at prompt assembly keeps all four mandatory hops (capture, phi,
      // synthesize, sensors) on every path, and keeps the branch off the note's data chain.
      //
      // ORDERING ONLY — `next -> after` carries no data. See the node comment for why `n_presum`'s
      // `in: context<schemaRef>` is left unwired rather than fed from `n_evidence`: retrieved
      // evidence is not the admin-selected case-note context DD-6 describes, and inventing that
      // equivalence in a seed is how a semantic drift becomes a platform default.
      ['n_phi', 'next', 'n_presum', 'after'],
      ['n_presum', 'out', 'n_ground_presum', 'in'],
      // WF-S-004 / WF-CONS-004: every node must REACH the `consultation.hitlGate` terminal, so the
      // guarded branch rejoins the chain rather than dead-ending.
      ['n_ground_presum', 'next', 'n_prompt', 'after'],
      // TASK-882 — the DNA writing-style gate sits between the PHI hop and prompt assembly,
      // where the gateway reads it. Ordering only, same shape as the pre-summary branch.
      ['n_phi', 'next', 'n_dna_style', 'after'],
      ['n_dna_style', 'next', 'n_prompt', 'after'],
      ['n_evidence', 'out', 'n_prompt', 'in'],
      ['n_prompt', 'out', 'n_synth', 'in'],
      // `document ⊑ text`: the correction pass proposes over any clinical text, including a
      // generated note — safe because its product is `edits`, which no extraction node consumes.
      ['n_synth', 'out', 'n_correct', 'in'],
      // Lane N — REDACTION, then GROUNDING, then the computational verifier. The verifier now
      // scores the REDACTED note, which is what "grounding evaluates the redacted summary" means
      // once it is a graph rather than a sentence.
      ['n_synth', 'out', 'n_dna', 'in'],
      ['n_dna', 'out', 'n_sensors', 'in'],
      ['n_dna', 'out', 'n_ground_note', 'in'],
      // Rejoins at the verifier rather than at persistence: WF-CONS-011 requires every route from
      // the consent gate to the HITL gate to pass through `consultation.sensors`, so a branch that
      // rejoined later would open one that does not.
      ['n_ground_note', 'next', 'n_sensors', 'after'],
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

/**
 * General Medicine — the baseline chain, and the UNQUALIFIED tenant default.
 *
 * It names no `documentTemplateSlug` on purpose. An empty selector is a subset of every request,
 * so this graph is what a tenant that authored nothing resolves — and it must keep resolving the
 * platform SOAP shape through `resolveForGeneration`'s fail-open, exactly as it did before the
 * visit-type work. Naming `soap_note` explicitly here would agree with that value while changing
 * this definition's `graphChecksum` and republishing a row nobody asked to change.
 */
export const ARCAAI_CONSULTATION_GRAPH = buildGraph({ dnaStyleId: null, inferentialSensors: false, documentTemplateSlug: null });

/** Rheumatology — adds the LLM-as-judge pass and pins the department clinician's writing style. */
export const ARCAAI_RHEUM_CONSULTATION_GRAPH = buildGraph({
  dnaStyleId: dnaReportIdForDepartment(SEED_DEPARTMENT_IDS.RHEUM_ARCAAI),
  inferentialSensors: true,
  documentTemplateSlug: null,
});

/**
 * TASK-891 (D8) — the two VISIT-TYPE variants, and the join this ticket exists for.
 *
 * A realtime node names ONE slug, so one workflow cannot serve both visit types. These are
 * `ARCAAI_CONSULTATION_GRAPH` in every other respect — a variant, not a new graph — differing
 * only in the note shape they predefine. `27-document-template-library.ts` seeds those two
 * shapes from the customer's own approved department x visit-type heading lists (10 sections for
 * a new/referral visit, 11 for a follow-up, sharing only 3 of 18 keys); until a workflow NAMED
 * one, seeding them changed no runtime behaviour at all, which that file says in as many words.
 *
 * The visit-type-qualified `WorkflowAssignment` rows below point here. The unqualified row does
 * NOT, and that asymmetry is the backwards-compatibility guarantee: a tenant carrying only the
 * unqualified row resolves the baseline graph and the platform SOAP shape, unchanged, while a
 * tenant carrying the qualified pair gets the visit-type shape because a more specific selector
 * wins.
 */
export const ARCAAI_NEW_VISIT_CONSULTATION_GRAPH = buildGraph({
  dnaStyleId: null,
  inferentialSensors: false,
  documentTemplateSlug: NEW_VISIT_NOTE_SLUG,
});

export const ARCAAI_REVISIT_CONSULTATION_GRAPH = buildGraph({
  dnaStyleId: null,
  inferentialSensors: false,
  documentTemplateSlug: REVISIT_NOTE_SLUG,
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
  NEW_VISIT_COMPILED_CONFIG,
  NEW_VISIT_GRAPH_CHECKSUM,
  NEW_VISIT_VALIDATION_REPORT,
  REGISTRY_CHECKSUM,
  REVISIT_COMPILED_CONFIG,
  REVISIT_GRAPH_CHECKSUM,
  REVISIT_VALIDATION_REPORT,
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
  // TASK-891 (D8) — the two VISIT-TYPE variants. Same spine as the General Medicine row above;
  // the only difference is the note SHAPE their realtime node predefines, which is what the
  // visit-type-qualified assignments below select on.
  {
    id: ARCAAI_NEW_VISIT_CONSULTATION_ID,
    tenantId: ARCAAI,
    slug: ARCAAI_NEW_VISIT_CONSULTATION_SLUG,
    name: 'ArcaAI Consultation — New / Referral Visit',
    description:
      'The tenant consultation chain with the running case note shaped for a NEW or referral visit: the ten-section new-patient note derived from the department x visit-type heading lists the customer approved. Selected by the `visit-type:new-visit` assignment selector.',
    paletteKey: 'consultation',
    versionNumber: 1,
    parentVersionId: null,
    status: 'PUBLISHED' as const,
    isActive: true,
    graph: ARCAAI_NEW_VISIT_CONSULTATION_GRAPH,
    graphChecksum: NEW_VISIT_GRAPH_CHECKSUM,
    compiledConfig: NEW_VISIT_COMPILED_CONFIG,
    compiledConfigChecksum: (NEW_VISIT_COMPILED_CONFIG as { checksum: string }).checksum,
    registryChecksum: REGISTRY_CHECKSUM,
    validationReport: NEW_VISIT_VALIDATION_REPORT,
    needsReview: false,
    validatedAt: new Date(COMPILED_AT),
    publishedAt: new Date(COMPILED_AT),
    tags: ['arcaai', 'consultation', 'tenant-authored', 'visit-type:new-visit'],
    createdBy: SEED_USER_IDS.ARCAAI_ADMIN,
  },
  {
    id: ARCAAI_REVISIT_CONSULTATION_ID,
    tenantId: ARCAAI,
    slug: ARCAAI_REVISIT_CONSULTATION_SLUG,
    name: 'ArcaAI Consultation — Follow-up Visit',
    description:
      'The tenant consultation chain with the running case note shaped for a FOLLOW-UP visit: the eleven-section revisit note that tracks change — last visit’s complaints and their status today, this result against the one before it, and the encounter’s order set. Selected by the `visit-type:revisit` assignment selector.',
    paletteKey: 'consultation',
    versionNumber: 1,
    parentVersionId: null,
    status: 'PUBLISHED' as const,
    isActive: true,
    graph: ARCAAI_REVISIT_CONSULTATION_GRAPH,
    graphChecksum: REVISIT_GRAPH_CHECKSUM,
    compiledConfig: REVISIT_COMPILED_CONFIG,
    compiledConfigChecksum: (REVISIT_COMPILED_CONFIG as { checksum: string }).checksum,
    registryChecksum: REGISTRY_CHECKSUM,
    validationReport: REVISIT_VALIDATION_REPORT,
    needsReview: false,
    validatedAt: new Date(COMPILED_AT),
    publishedAt: new Date(COMPILED_AT),
    tags: ['arcaai', 'consultation', 'tenant-authored', 'visit-type:revisit'],
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
    selectorKey: '',
    createdBy: SEED_USER_IDS.ARCAAI_ADMIN,
  },
  {
    id: '9a000000-0000-0000-0001-000000000002',
    tenantId: ARCAAI,
    scope: 'DEPARTMENT' as const,
    scopeId: SEED_DEPARTMENT_IDS.RHEUM_ARCAAI as string | null,
    paletteKey: 'consultation',
    workflowDefinitionSlug: ARCAAI_RHEUM_CONSULTATION_SOAP_SLUG,
    selectorKey: '',
    createdBy: SEED_USER_IDS.ARCAAI_ADMIN,
  },
  // TASK-891 (D8) — the visit-type-qualified pair, alongside (never replacing) the unqualified
  // TENANT row above. `WorkflowAssignmentService.resolve` matches a row whose selector is a
  // SUBSET of the request tags, most specific first and unqualified last, so a request tagged
  // `visit-type:new-visit` / `visit-type:revisit` lands here and everything else keeps landing on
  // the unqualified row.
  //
  // D8b seeded this pair pointing at the SAME SOAP definition as the unqualified row, to prove
  // the plumbing without inventing a graph. They now point at the two visit-type definitions
  // above, which is the whole join: the note shape a clinician WATCHES being written is the one
  // that matches the visit type, so it agrees with the note they eventually sign. A tenant admin
  // can repoint either row at any other PUBLISHED `consultation`-palette definition without a
  // code change.
  {
    id: '9a000000-0000-0000-0001-000000000003',
    tenantId: ARCAAI,
    scope: 'TENANT' as const,
    scopeId: null as string | null,
    paletteKey: 'consultation',
    workflowDefinitionSlug: ARCAAI_NEW_VISIT_CONSULTATION_SLUG,
    selectorKey: 'visit-type:new-visit',
    createdBy: SEED_USER_IDS.ARCAAI_ADMIN,
  },
  {
    id: '9a000000-0000-0000-0001-000000000004',
    tenantId: ARCAAI,
    scope: 'TENANT' as const,
    scopeId: null as string | null,
    paletteKey: 'consultation',
    workflowDefinitionSlug: ARCAAI_REVISIT_CONSULTATION_SLUG,
    selectorKey: 'visit-type:revisit',
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
    reason: 'Seeded day-1 tenant-authored consultation workflow assignment .',
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
    reason: 'Seeded day-1 Rheumatology department override .',
  },
  // TASK-891 (D8) — change rows for the two visit-type-qualified assignments above.
  // NOTE: `WorkflowAssignmentChange` (unlike its `AgentAssignmentChange` sibling, TASK-884)
  // carries no `selectorKey` column, so these rows are identified by content
  // (`afterSlug`/`reason`) rather than by a queryable selector key — see the report for the
  // follow-up this leaves open.
  {
    id: '9a000000-0000-0001-0001-000000000003',
    tenantId: ARCAAI,
    scope: 'TENANT' as const,
    scopeId: null as string | null,
    paletteKey: 'consultation',
    changedBy: SEED_USER_IDS.ARCAAI_ADMIN,
    assignmentVersion: 1,
    beforeSlug: null as string | null,
    afterSlug: ARCAAI_NEW_VISIT_CONSULTATION_SLUG,
    reason: 'Seeded day-1 visit-type:new-visit selector assignment (TASK-891 D8).',
  },
  {
    id: '9a000000-0000-0001-0001-000000000004',
    tenantId: ARCAAI,
    scope: 'TENANT' as const,
    scopeId: null as string | null,
    paletteKey: 'consultation',
    changedBy: SEED_USER_IDS.ARCAAI_ADMIN,
    assignmentVersion: 1,
    beforeSlug: null as string | null,
    afterSlug: ARCAAI_REVISIT_CONSULTATION_SLUG,
    reason: 'Seeded day-1 visit-type:revisit selector assignment (TASK-891 D8).',
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

  console.log('Seeding ArcaAI tenant-authored consultation workflows ...');

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
        '  ┌─ WorkflowAssignment rows NOT seeded ────────────────────────────',
        '  │ The ArcaAI consultation workflows are published and visible in Workflow',
        '  │ Studio, but nothing is ASSIGNED, so they govern no consultation yet.',
        '  │',
        '  │ Why: binding them requires the Substrate-A exclusivity gate.',
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
