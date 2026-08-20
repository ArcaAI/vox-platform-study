/**
 * `WORKFLOW_NODE_REGISTRY` — the code-owned node-type vocabulary for the agentic-workflow-
 * platform substrate (TASK-734, closing the gap TASK-716's `predicates/context.ts` flagged:
 * "TASK-715's `WORKFLOW_NODE_REGISTRY`, not yet built at the time this package was authored").
 *
 * TASK-716's own README §2.3 speculatively placed this at
 * `packages/applications/src/services/workflow-registry/` — but that same section says "re-
 * verify at execution time, do not assume", and nothing was ever built there. This ticket
 * places it here instead, in `@arcaai/workflow-contract`, for the same reason the compiler and
 * validator already live here: node specs are CODE CONTRACTS that gate what the interpreter
 * can execute, not tenant configuration, and this package's "zero runtime dependencies"
 * property means the registry can be imported by the database seed AND the applications layer
 * without either pulling in the other (TASK-716 §3.2's reason for the package split in the
 * first place). `packages/applications/src/services/workflow-definition/` re-exports what it
 * needs from here rather than owning a second copy.
 *
 * ## The cross-language constraint (TASK-718 §2.3 / this ticket's mandate)
 *
 * `apps/harness/src/harness/temporal/interpreter/registry.py` is the RUNTIME dispatch table —
 * it binds each node type to a real `@activity.defn` Temporal activity and is Python-only by
 * necessity (Temporal activities cannot be expressed in TypeScript and run in this worker).
 * This file is the GATEWAY's view of the same vocabulary: what a graph is allowed to
 * reference, what class/palette/entitlement it carries, and what the compiler stamps into
 * `compiledConfig.stages[].nodes[].activity`. The two must agree on every KEY the registry
 * exposes today (currently `noop`/`passthrough` only — `registry.py`'s own docstring: "starts
 * EMPTY of palette nodes — TASK-720 populates it"), or a definition that validates in the
 * gateway fails admission in the interpreter. `__tests__/node-registry-parity.test.ts` (this
 * package) and `test_node_registry_parity.py` (harness) both assert against ONE committed
 * fixture — `docs/implementation/TASK-734-Workflow-Substrate-Second-Pass/contracts/
 * node-registry.snapshot.json` — rather than against each other directly, because neither
 * runtime can import the other language's module.
 *
 * `classes`/`paletteKey` are TS-only concepts (the predicate catalogue's `nodeClass` selector
 * and the Studio's palette grouping); `registry.py`'s `kind` field (reserved for a future
 * `child_workflow` dispatch) has no TS counterpart yet. The shared fixture therefore only
 * carries the fields both sides actually have today: `key`, `implemented`, `activityName`,
 * `critical`, `externalWrite`, `defaultTimeoutSeconds`, `defaultMaxAttempts`, `entitlementKey`.
 */
import { createHash } from 'node:crypto';
import { canonicalJson } from './canonical-json';
import type { CompilerNodeInfo } from './compiler';
import { NODE_CONFIG_SCHEMAS, type NodeConfigSchema } from './node-config-schemas';
import type { WorkflowNodeClassLookup } from './predicates';

export interface WorkflowNodeDescriptor {
  /** The node `type` string authored on a graph node (`WorkflowGraphNode.type`). */
  readonly key: string;
  /** Mirrors `registry.py`'s `NodeSpec.implemented` — an unimplemented entry is an
   *  OBSERVABLE, non-executable placeholder, never silently dropped. */
  readonly implemented: boolean;
  /** The Temporal-registered activity name (`registry.py`'s `activity_name`, e.g.
   *  `"interpreter.noop"`) — what the compiler stamps into `CompiledNode.activity`. */
  readonly activityName: string;
  /** Registry-declared classes (e.g. `['gate']`, `['phiBearing']`) — resolved by
   *  `classesOf()` for the predicate catalogue's `{ nodeClass }` selectors and by the
   *  compiler to detect gate nodes. Empty for the seed `noop`/`passthrough` entries, which
   *  belong to no palette and carry no safety classification. */
  readonly classes: readonly string[];
  /** The palette this node type belongs to, or `null` for palette-agnostic utility nodes
   *  (the seed entries). Resolved by `paletteOf()`. */
  readonly paletteKey: string | null;
  /** Code-owned safety property — never tenant-configurable (mirrors `registry.py`). */
  readonly critical: boolean;
  /** Code-owned safety property — never tenant-configurable (mirrors `registry.py`). */
  readonly externalWrite: boolean;
  readonly defaultTimeoutSeconds: number;
  readonly defaultMaxAttempts: number;
  /** An `EntitlementFeatureKey` string, or `null` if the node type is ungated (TASK-715
   *  §3.5's per-palette entitlement gating: every node type in a palette must declare the
   *  same key as the palette, or none). Typed `string` rather than the domains enum so this
   *  package keeps zero runtime dependencies. */
  readonly entitlementKey: string | null;
  /** The node type's config JSON Schema (authorable subset), or `undefined` when none has been
   *  authored yet — see `node-config-schemas.ts`'s docstring for which node types have one and
   *  why some deliberately do not (TASK-719's registry-contract gap, closed for the node types
   *  with a real, committed schema source). Attached below via `NODE_CONFIG_SCHEMAS`, never
   *  inline on these literals, so the schema source stays the single place it is authored. */
  readonly configSchema?: NodeConfigSchema;
}

/**
 * The seed entries mirror `registry.py`'s `NODE_REGISTRY` exactly — both intentionally ship
 * ONLY `noop`/`passthrough` in this pass; TASK-720 adds the five summarization-palette node
 * types to both sides together. `configSchema` is deliberately NOT set on these literals —
 * see the derivation below, which attaches it uniformly from `NODE_CONFIG_SCHEMAS`.
 */
const WORKFLOW_NODE_REGISTRY_BASE: Readonly<Record<string, Omit<WorkflowNodeDescriptor, 'configSchema'>>> = Object.freeze({
  noop: Object.freeze({
    key: 'noop',
    implemented: true,
    activityName: 'interpreter.noop',
    classes: Object.freeze([]),
    paletteKey: null,
    critical: false,
    externalWrite: false,
    defaultTimeoutSeconds: 60,
    defaultMaxAttempts: 1,
    entitlementKey: null,
  }),
  passthrough: Object.freeze({
    key: 'passthrough',
    implemented: true,
    activityName: 'interpreter.passthrough',
    classes: Object.freeze([]),
    paletteKey: null,
    critical: false,
    externalWrite: false,
    defaultTimeoutSeconds: 60,
    defaultMaxAttempts: 1,
    entitlementKey: null,
  }),
  // -------------------------------------------------------------------------------------------
  // Graph boundary markers (palette-agnostic). The four palette-independent structural rules
  // WF-S-002/003/004/007 are written against these two literal types, so before they existed NO
  // graph in ANY palette could satisfy them — the platform's own seeded summarization graph
  // scored 17 errors against its own validator. They are MARKERS, not work: `classes:
  // ['boundary']` is what `REACHABLE_FROM_ENTRY`/`REACHES_TERMINAL` use to exempt them from a
  // palette's OWN entry/terminal rule (see `predicates/structural.ts`), so
  // `core.start -> consultation.consentGate` does not read as "a node precedes the consent gate".
  // `interpreter.core_start`/`interpreter.core_end` are real registered activities for the same
  // reason `noop` is: compile() refuses any graph containing an unimplemented type, and a marker
  // that cannot be dispatched would make every graph unpublishable all over again.
  // -------------------------------------------------------------------------------------------
  'core.start': Object.freeze({
    key: 'core.start',
    implemented: true,
    activityName: 'interpreter.core_start',
    classes: Object.freeze(['boundary']),
    paletteKey: null,
    critical: false,
    externalWrite: false,
    defaultTimeoutSeconds: 30,
    defaultMaxAttempts: 1,
    entitlementKey: null,
  }),
  'core.end': Object.freeze({
    key: 'core.end',
    implemented: true,
    activityName: 'interpreter.core_end',
    classes: Object.freeze(['boundary']),
    paletteKey: null,
    critical: false,
    externalWrite: false,
    defaultTimeoutSeconds: 30,
    defaultMaxAttempts: 1,
    entitlementKey: null,
  }),
  // -------------------------------------------------------------------------------------------
  // Summarization palette (TASK-720) — five node types, `paletteKey: 'summarization'`. `classes`
  // carries `'activity'` on every entry (each emits exactly one NODE trajectory step per
  // palette.md's "emitsTrajectory" section) plus `'generation'` on `generate.text` only (the one
  // node whose compiled config carries an `onError` field — matches the existing DRAFT rule at
  // `rule-catalogue.ts` keyed off `nodeClass: 'generation'`). None carry `'gate'` — none are HITL
  // gates, so the compiler correctly leaves all five inside `stages[]` (none lifted into `gates[]`,
  // which v1's admission requires to stay `[]` — execution-semantics.md §2 step 5).
  // `entitlementKey: null` on every entry — R-7 (this ticket's README §6): `PlanEntitlement` is
  // column-per-key, not a free-string registry, so gating this palette needs a migration, not a
  // registry value; not added here.
  //
  // RESTORED (2026-08-17, close-out pass): these five entries were dropped from this file by an
  // external tree operation mid-session (see TASK-724/TASK-731 READMEs, and this ticket's own §7
  // "Second pass") even though the node activities, rule catalogue (`WF-SUMM-001..006`), and
  // golden fixtures never stopped existing on disk. Re-added verbatim from the last known-good
  // shape (git history, commit 632f93f14) — values match `contracts/palette.md`'s node table and
  // `registry.py`'s matching five entries exactly.
  // -------------------------------------------------------------------------------------------
  'input.context_binding': Object.freeze({
    key: 'input.context_binding',
    implemented: true,
    activityName: 'interpreter.context_binding',
    classes: Object.freeze(['activity', 'mandatory']),
    paletteKey: 'summarization',
    critical: true,
    externalWrite: false,
    defaultTimeoutSeconds: 60,
    defaultMaxAttempts: 3,
    entitlementKey: null,
  }),
  'prompt.template_ref': Object.freeze({
    key: 'prompt.template_ref',
    implemented: true,
    activityName: 'interpreter.template_ref',
    classes: Object.freeze(['activity']),
    paletteKey: 'summarization',
    critical: false,
    externalWrite: false,
    defaultTimeoutSeconds: 30,
    defaultMaxAttempts: 3,
    entitlementKey: null,
  }),
  'generate.text': Object.freeze({
    key: 'generate.text',
    implemented: true,
    activityName: 'interpreter.text_generate',
    classes: Object.freeze(['activity', 'generation', 'mandatory']),
    paletteKey: 'summarization',
    critical: true,
    externalWrite: false,
    defaultTimeoutSeconds: 300,
    defaultMaxAttempts: 2,
    entitlementKey: null,
  }),
  'guardrail.check': Object.freeze({
    key: 'guardrail.check',
    implemented: true,
    activityName: 'interpreter.guardrail_check',
    classes: Object.freeze(['activity', 'mandatory']),
    paletteKey: 'summarization',
    critical: false,
    externalWrite: false,
    defaultTimeoutSeconds: 60,
    defaultMaxAttempts: 3,
    entitlementKey: null,
  }),
  'output.deliver': Object.freeze({
    key: 'output.deliver',
    implemented: true,
    activityName: 'interpreter.deliver',
    classes: Object.freeze(['activity', 'mandatory']),
    paletteKey: 'summarization',
    critical: true,
    externalWrite: true,
    defaultTimeoutSeconds: 60,
    defaultMaxAttempts: 3,
    entitlementKey: null,
  }),
  // -------------------------------------------------------------------------------------------
  // STT palette (TASK-724) — eight node types, `paletteKey: 'stt'`. See
  // docs/implementation/TASK-724-Palette-Stt/contracts/palette.md for the node table, `critical`
  // rationale, and the `implemented: false` decision on `stt.phiHop` (a documented placeholder
  // pending TASK-710 — `implemented: false` makes compile() refuse ANY graph that includes it,
  // never a silent pass-through). `entitlementKey: null` on every entry — `featurePaletteStt`
  // gating is wired at WorkflowDefinitionService.publish() via IEntitlementsService, not a
  // registry-declared key (see palette.md's Entitlement gate section).
  // -------------------------------------------------------------------------------------------
  'stt.audioInput': Object.freeze({
    key: 'stt.audioInput',
    implemented: true,
    activityName: 'interpreter.stt_audio_input',
    classes: Object.freeze(['activity', 'mandatory']),
    paletteKey: 'stt',
    critical: true,
    externalWrite: false,
    defaultTimeoutSeconds: 60,
    defaultMaxAttempts: 3,
    entitlementKey: null,
  }),
  'stt.vad': Object.freeze({
    key: 'stt.vad',
    implemented: true,
    activityName: 'interpreter.stt_vad',
    classes: Object.freeze(['activity']),
    paletteKey: 'stt',
    critical: false,
    externalWrite: false,
    defaultTimeoutSeconds: 60,
    defaultMaxAttempts: 3,
    entitlementKey: null,
  }),
  'stt.noiseFilter': Object.freeze({
    key: 'stt.noiseFilter',
    implemented: true,
    activityName: 'interpreter.stt_noise_filter',
    classes: Object.freeze(['activity']),
    paletteKey: 'stt',
    critical: false,
    externalWrite: false,
    defaultTimeoutSeconds: 60,
    defaultMaxAttempts: 3,
    entitlementKey: null,
  }),
  'stt.diarization': Object.freeze({
    key: 'stt.diarization',
    implemented: true,
    activityName: 'interpreter.stt_diarization',
    classes: Object.freeze(['activity']),
    paletteKey: 'stt',
    critical: false,
    externalWrite: false,
    defaultTimeoutSeconds: 120,
    defaultMaxAttempts: 3,
    entitlementKey: null,
  }),
  'stt.languageDetection': Object.freeze({
    key: 'stt.languageDetection',
    implemented: true,
    activityName: 'interpreter.stt_language_detection',
    classes: Object.freeze(['activity']),
    paletteKey: 'stt',
    critical: false,
    externalWrite: false,
    defaultTimeoutSeconds: 30,
    defaultMaxAttempts: 3,
    entitlementKey: null,
  }),
  'stt.asrEngine': Object.freeze({
    key: 'stt.asrEngine',
    implemented: true,
    activityName: 'interpreter.stt_asr_engine',
    classes: Object.freeze(['activity', 'mandatory']),
    paletteKey: 'stt',
    critical: true,
    externalWrite: false,
    defaultTimeoutSeconds: 600,
    defaultMaxAttempts: 2,
    entitlementKey: null,
  }),
  'stt.transcriptOutput': Object.freeze({
    key: 'stt.transcriptOutput',
    implemented: true,
    activityName: 'interpreter.stt_transcript_output',
    classes: Object.freeze(['activity', 'mandatory']),
    paletteKey: 'stt',
    critical: true,
    externalWrite: true,
    defaultTimeoutSeconds: 60,
    defaultMaxAttempts: 3,
    entitlementKey: null,
  }),
  // PLACEHOLDER — implemented:false, see palette.md. TASK-710/phi-redactor is not landed.
  'stt.phiHop': Object.freeze({
    key: 'stt.phiHop',
    implemented: false,
    activityName: 'interpreter.stt_phi_hop',
    classes: Object.freeze(['activity']),
    paletteKey: 'stt',
    critical: false,
    externalWrite: false,
    defaultTimeoutSeconds: 60,
    defaultMaxAttempts: 1,
    entitlementKey: null,
  }),
  // -------------------------------------------------------------------------------------------
  // Consultation palette (TASK-731) — all 13 node types from
  // docs/implementation/TASK-731-Palette-Consultation/contracts/node-types.md's node table.
  // TASK-731 registered only 3 (consentGate, phiHop, hitlGate) and left the other 10 specified
  // but unwired; since `DRAFT_CONSULTATION_RULE_SET` names NINE node types by key, that left the
  // palette unbuildable — the Studio's rail could offer three nodes for a rule set demanding
  // nine. The ten added here each carry the same compile target `contracts/palette-contract.md`
  // §1 already verified for them, now with a real interpreter wrapper on the Python side
  // (`nodes/consultation_{capture,nlp,compose,verify,persist}.py`).
  //
  // Ordered by pipeline position (consent → capture → NLP → PHI → evidence → compose → verify →
  // persist → gate), not alphabetically, so the file reads as the mandatory subgraph it encodes.
  // `classes` stays the predicate-selector vocabulary the rest of this registry uses
  // (`activity`, plus `generation` on the one node that generates text — mirroring
  // `generate.text`); it is deliberately NOT the "safety class" column of node-types.md, which is
  // a graph-shape property the validator owns, exactly as consentGate/phiHop already did.
  // TASK-710 (phi-redactor) HAS landed (unlike at STT's execution time), so `consultation.phiHop`
  // registers `implemented: true`, unlike its `stt.phiHop` sibling above.
  // -------------------------------------------------------------------------------------------
  'consultation.consentGate': Object.freeze({
    key: 'consultation.consentGate',
    implemented: true,
    activityName: 'interpreter.consultation_consent_gate',
    classes: Object.freeze(['consentGate', 'mandatory']),
    paletteKey: 'consultation',
    critical: true,
    externalWrite: false,
    defaultTimeoutSeconds: 30,
    defaultMaxAttempts: 3,
    entitlementKey: null,
  }),
  'consultation.captureBinding': Object.freeze({
    key: 'consultation.captureBinding',
    implemented: true,
    activityName: 'interpreter.consultation_capture_binding',
    classes: Object.freeze(['activity', 'mandatory']),
    paletteKey: 'consultation',
    critical: false,
    externalWrite: false,
    defaultTimeoutSeconds: 30,
    defaultMaxAttempts: 2,
    entitlementKey: null,
  }),
  // externalWrite for the persist leg (persist_entities), not the extraction itself — see
  // node-types.md's `critical` rationale, third bullet.
  'consultation.extractEntities': Object.freeze({
    key: 'consultation.extractEntities',
    implemented: true,
    activityName: 'interpreter.consultation_extract_entities',
    classes: Object.freeze(['activity']),
    paletteKey: 'consultation',
    critical: false,
    externalWrite: true,
    defaultTimeoutSeconds: 150,
    defaultMaxAttempts: 2,
    entitlementKey: null,
  }),
  'consultation.bindTerminology': Object.freeze({
    key: 'consultation.bindTerminology',
    implemented: true,
    activityName: 'interpreter.consultation_bind_terminology',
    classes: Object.freeze(['activity']),
    paletteKey: 'consultation',
    critical: false,
    externalWrite: false,
    defaultTimeoutSeconds: 30,
    defaultMaxAttempts: 1,
    entitlementKey: null,
  }),
  'consultation.phiHop': Object.freeze({
    key: 'consultation.phiHop',
    implemented: true,
    activityName: 'interpreter.consultation_phi_hop',
    classes: Object.freeze(['activity', 'redaction', 'mandatory']),
    paletteKey: 'consultation',
    critical: false,
    externalWrite: false,
    defaultTimeoutSeconds: 60,
    defaultMaxAttempts: 3,
    entitlementKey: null,
  }),
  'consultation.retrieveEvidence': Object.freeze({
    key: 'consultation.retrieveEvidence',
    implemented: true,
    activityName: 'interpreter.consultation_retrieve_evidence',
    classes: Object.freeze(['activity']),
    paletteKey: 'consultation',
    critical: false,
    externalWrite: false,
    defaultTimeoutSeconds: 150,
    defaultMaxAttempts: 2,
    entitlementKey: null,
  }),
  'consultation.assemblePrompt': Object.freeze({
    key: 'consultation.assemblePrompt',
    implemented: true,
    activityName: 'interpreter.consultation_assemble_prompt',
    classes: Object.freeze(['activity']),
    paletteKey: 'consultation',
    critical: false,
    externalWrite: false,
    defaultTimeoutSeconds: 150,
    defaultMaxAttempts: 3,
    entitlementKey: null,
  }),
  'consultation.synthesize': Object.freeze({
    key: 'consultation.synthesize',
    implemented: true,
    activityName: 'interpreter.consultation_synthesize',
    classes: Object.freeze(['activity', 'generation']),
    paletteKey: 'consultation',
    critical: false,
    externalWrite: false,
    defaultTimeoutSeconds: 150,
    defaultMaxAttempts: 2,
    entitlementKey: null,
  }),
  'consultation.sensors': Object.freeze({
    key: 'consultation.sensors',
    implemented: true,
    activityName: 'interpreter.consultation_sensors',
    classes: Object.freeze(['activity']),
    paletteKey: 'consultation',
    critical: false,
    externalWrite: false,
    defaultTimeoutSeconds: 150,
    defaultMaxAttempts: 2,
    entitlementKey: null,
  }),
  'consultation.inferentialSensors': Object.freeze({
    key: 'consultation.inferentialSensors',
    implemented: true,
    activityName: 'interpreter.consultation_inferential_sensors',
    classes: Object.freeze(['activity']),
    paletteKey: 'consultation',
    critical: false,
    externalWrite: false,
    defaultTimeoutSeconds: 900,
    defaultMaxAttempts: 2,
    entitlementKey: null,
  }),
  'consultation.persistDraft': Object.freeze({
    key: 'consultation.persistDraft',
    implemented: true,
    activityName: 'interpreter.consultation_persist_draft',
    classes: Object.freeze(['activity', 'mandatory']),
    paletteKey: 'consultation',
    critical: false,
    externalWrite: true,
    defaultTimeoutSeconds: 150,
    defaultMaxAttempts: 3,
    entitlementKey: null,
  }),
  'consultation.finalizeAssurance': Object.freeze({
    key: 'consultation.finalizeAssurance',
    implemented: true,
    activityName: 'interpreter.consultation_finalize_assurance',
    classes: Object.freeze(['activity', 'mandatory']),
    paletteKey: 'consultation',
    critical: false,
    externalWrite: true,
    defaultTimeoutSeconds: 150,
    defaultMaxAttempts: 3,
    entitlementKey: null,
  }),
  // The ONE durable human wait in this substrate (TASK-731 Phase B, now implemented). The `gate`
  // class is load-bearing on BOTH sides: the compiler lifts a `gate`-classed node out of
  // `stages` into `gates` (compiler.ts), and the interpreter starts `ConsultationGateWorkflow`
  // as a child for it rather than dispatching `activityName` — which stays declared because it
  // is the S-4 cross-check anchor. `mandatory` keeps WF-S-007 able to see it as a node nothing
  // may route around.
  'consultation.hitlGate': Object.freeze({
    key: 'consultation.hitlGate',
    implemented: true,
    activityName: 'interpreter.consultation_hitl_gate',
    classes: Object.freeze(['gate', 'mandatory']),
    paletteKey: 'consultation',
    critical: true,
    externalWrite: true,
    defaultTimeoutSeconds: 60,
    defaultMaxAttempts: 1,
    entitlementKey: null,
  }),
});

/**
 * The public registry: `WORKFLOW_NODE_REGISTRY_BASE` with each entry's `configSchema` attached
 * from `NODE_CONFIG_SCHEMAS` (`node-config-schemas.ts`). A key absent from that map yields
 * `configSchema: undefined` — the documented, structural "no schema authored yet" state, not a
 * defect (see that module's docstring for which node types this applies to and why).
 */
export const WORKFLOW_NODE_REGISTRY: Readonly<Record<string, WorkflowNodeDescriptor>> = Object.freeze(
  Object.fromEntries(
    Object.entries(WORKFLOW_NODE_REGISTRY_BASE).map(([key, descriptor]) => [
      key,
      Object.freeze({ ...descriptor, configSchema: NODE_CONFIG_SCHEMAS[key] }),
    ]),
  ),
);

/** The registry-declared classes for a node type — `[]` for an unknown type (never throws;
 *  a caller checks `nodeInfo()`/`compile()` findings for "unknown type", not this). */
export function classesOf(nodeType: string): readonly string[] {
  return WORKFLOW_NODE_REGISTRY[nodeType]?.classes ?? [];
}

/** The palette a node type belongs to, or `undefined` if unregistered/palette-agnostic. */
export function paletteOf(nodeType: string): string | undefined {
  return WORKFLOW_NODE_REGISTRY[nodeType]?.paletteKey ?? undefined;
}

/** The `{ activity, classes }` shape `compile()`'s `CompilerContext.nodeInfo` expects —
 *  `undefined` for an unregistered or unimplemented type, so the compiler's existing
 *  "not a registered node type" finding also fires for a registered-but-`implemented: false`
 *  entry (mirrors `registry.py`'s "no entry, or `implemented=False`, is an observable skip"). */
export function nodeInfo(nodeType: string): CompilerNodeInfo | undefined {
  const descriptor = WORKFLOW_NODE_REGISTRY[nodeType];
  if (descriptor === undefined || !descriptor.implemented) return undefined;
  return { activity: descriptor.activityName, classes: descriptor.classes };
}

/** Satisfies `WorkflowEvaluationContext.registry` (`predicates/context.ts`) — the impure glue
 *  between this static registry and the pure predicate evaluators. */
export const workflowNodeClassLookup: WorkflowNodeClassLookup = { classesOf, paletteOf };

/**
 * sha256 of the registry, descriptors sorted by `key` before hashing (TASK-715 §6 finding #7:
 * "descriptor array order must also be stable or every deploy looks like a registry bump and
 * flags every published definition NEEDS_REVIEW"). A definition's stamped `registryChecksum`
 * is compared against this at read time to trigger TASK-716's `NEEDS_REVIEW` re-validation.
 */
export function registryChecksum(): string {
  const sorted = Object.values(WORKFLOW_NODE_REGISTRY)
    .slice()
    .sort((a, b) => a.key.localeCompare(b.key));
  return createHash('sha256').update(canonicalJson(sorted)).digest('hex');
}
