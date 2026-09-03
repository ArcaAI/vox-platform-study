/**
 * `WORKFLOW_NODE_REGISTRY` — the code-owned node-type vocabulary for the agentic-workflow-
 * platform substrate (closing the gap `predicates/context.ts` flagged:
 * " `WORKFLOW_NODE_REGISTRY`, not yet built at the time this package was authored").
 *
 * own speculatively placed this at
 * `packages/applications/src/services/workflow-registry/` — but that same section says "re-
 * verify at execution time, do not assume", and nothing was ever built there. This ticket
 * places it here instead, in `@arcaai/workflow-contract`, for the same reason the compiler and
 * validator already live here: node specs are CODE CONTRACTS that gate what the interpreter
 * can execute, not tenant configuration, and this package's "zero runtime dependencies"
 * property means the registry can be imported by the database seed AND the applications layer
 * without either pulling in the other ( 's reason for the package split in the
 * first place). `packages/applications/src/services/workflow-definition/` re-exports what it
 * needs from here rather than owning a second copy.
 *
 * ## The cross-language constraint ( / mandate)
 *
 * `apps/harness/src/harness/temporal/interpreter/registry.py` is the RUNTIME dispatch table —
 * it binds each node type to a real `@activity.defn` Temporal activity and is Python-only by
 * necessity (Temporal activities cannot be expressed in TypeScript and run in this worker).
 * This file is the GATEWAY's view of the same vocabulary: what a graph is allowed to
 * reference, what class/palette/entitlement it carries, and what the compiler stamps into
 * `compiledConfig.stages[].nodes[].activity`. The two must agree on every KEY the registry
 * exposes today (currently `noop`/`passthrough` only — `registry.py`'s own docstring: "starts
 * EMPTY of palette nodes — populates it"), or a definition that validates in the
 * gateway fails admission in the interpreter. `__tests__/node-registry-parity.test.ts` (this
 * package) and `test_node_registry_parity.py` (harness) both assert against ONE committed
 * fixture — `packages/workflow-contract/src/__tests__/fixtures/node-registry.snapshot.json`
 * — rather than against each other directly, because neither
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
import { EMPTY_PORTS, NODE_PORTS } from './node-ports';
import type { WorkflowPortDescriptor } from './port-model';
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
  /**
   * An `EntitlementFeatureKey` string, or `null` if the node type is ungated
   * Per-palette entitlement gating: every node type in a palette must declare the
   *  same key as the palette, or none). Typed `string` rather than the domains enum so this
   *  package keeps zero runtime dependencies.
   */
  readonly entitlementKey: string | null;
  /**
   * The node type's config JSON Schema (authorable subset), or `undefined` when none has been
   *  authored yet — see `node-config-schemas.ts`'s docstring for which node types have one and
   * why some deliberately do not ( registry-contract gap, closed for the node types
   *  with a real, committed schema source). Attached below via `NODE_CONFIG_SCHEMAS`, never
   *  inline on these literals, so the schema source stays the single place it is authored.
   */
  readonly configSchema?: NodeConfigSchema;

  // -------------------------------------------------------------------------------------------
  // the node CONTRACT. Everything above describes how a node is DISPATCHED; the
  // fields below describe what it may be WIRED TO, when it runs, and what must be true of it
  // before a graph containing it can be published. All seven are TypeScript-side only: the
  // cross-language parity fixture carries the eight fields both runtimes share, and
  // `classes`/`paletteKey` are the standing precedent for a TS-only concept (the fixture's own
  // `_comment` records it). Do not add any of them to either projection without adding them to
  // `registry.py`'s `NodeSpec` and BOTH projections in the same change.
  // -------------------------------------------------------------------------------------------

  /** Declared input ports. Attached below from `NODE_PORTS` (`node-ports.ts`) for the same
   *  reason `configSchema` is: the tables are bulky and belong in one place. Closes D-4. */
  readonly inputs: readonly WorkflowPortDescriptor[];
  /** Declared output ports — see `inputs`. */
  readonly outputs: readonly WorkflowPortDescriptor[];
  /** WHEN the node runs, ORTHOGONAL to `lane` (DD-5). `on-start` once at the opening,
   *  `per-turn` as new material arrives, `on-end` once at the close. This is what lets two
   *  nodes share a lane without sharing a cadence, and it absorbs the endpoint stage uniformly
   *  as `on-end`. */
  readonly trigger: WorkflowNodeTrigger;
  /**
   * WHICH RUNTIME executes it, and it is now LOAD-BEARING rather than descriptive
   *  lane A, item 7). `durable` means the interpreter workflow dispatches `activityName` as a
   * Temporal activity; `realtime` means live executor runs it and the durable
   *  interpreter SKIPS it (`reason: 'realtime_lane'`), so exactly one runtime ever executes a
   *  given node.
   *
   *  It was `durable` on every entry until this lane, which was a claim the platform had already
   *  outgrown: `REALTIME_NODE_TYPES` (`realtime-node-registry.ts`) listed three consultation
   *  nodes the realtime runtime executes, and that set is now DERIVED from this field rather than
   *  hand-maintained beside it. `lane` is the SECOND field shared with the Python mirror (after
   *  `outputKey`), because the skip has to be enforced where dispatch happens.
   */
  readonly lane: WorkflowNodeLane;
  /**
   * Guard attachment keys — node types that must be wired to EVERY INSTANCE of this node
   *  before a graph containing it can be published (`workflowPublishProblems`, checked per
   *  instance, not per type).
   *
   * Populated on the TARGET CATALOGUE only (lane A, item 17): the three `agent.*`
   *  generation entries require `guard.groundedness`, and `agent.transcription` requires
   *  `guard.phi`. It stays `[]` on every PIPELINE node type, deliberately — the summarization
   *  palette's mandatory guardrail and the consultation palette's mandatory PHI hop are already
   *  enforced by the rule catalogue (`WF-SUMM-*`, `WF-CONS-009`), and a second enforcement path
   *  for one policy is how the two drift apart. The new catalogue has no rule set of its own, so
   *  here `requires` IS the only enforcement rather than a duplicate of one.
   */
  readonly requires: readonly string[];
  /** MUST be `true` for any `lane: 'durable'` node, because Temporal retries activities and a
   *  non-idempotent retry double-writes invisibly. Enforced by
   *  `nodeDescriptorContractProblems`. */
  readonly idempotent: boolean;
  /** The node TYPE's version. A node type is a contract with every saved tenant graph, so a
   *  published node's ports are never reshaped in place — a breaking change becomes a new key
   *  with an `@N` suffix (`agent.ner@2`) and this field must agree with that suffix. Otherwise
   *  definition-level immutability is undermined by node-level mutation. */
  readonly schemaVersion: number;
  /**
   * OD-11: the eval gate binds to the NODE, not to a `DepartmentAgent`. Declared here so the
   * binding has a home; `undefined` on every node today — migrates the data onto it.
   */
  readonly evalGate?: WorkflowNodeEvalGate;
  /**
   * TASK-864 / TASK-859 §6 — the node type is DEPRECATED: it keeps compiling and executing for
   * the two-release window, the Studio hides it from the palette rail (but still renders graphs
   * that use it), and `replacedBy` names the `core.*` type that supersedes it. TS-only, like
   * `classes`/`paletteKey`: the interpreter dispatches a deprecated type exactly as before.
   */
  readonly deprecated?: boolean;
  /** The `core.*` node type (or `core.action` key) a deprecated type maps onto. */
  readonly replacedBy?: string;
}

/** When a node runs — orthogonal to `lane`. */
export type WorkflowNodeTrigger = 'on-start' | 'per-turn' | 'on-end';

/** Which runtime executes a node. */
export type WorkflowNodeLane = 'realtime' | 'durable';

/** OD-11 — the golden-set binding, on the node rather than on an agent row. */
export interface WorkflowNodeEvalGate {
  readonly goldenSetId: string;
  readonly enabled: boolean;
}

/**
 * The seed entries mirror `registry.py`'s `NODE_REGISTRY` exactly — both intentionally ship
 * ONLY `noop`/`passthrough` in this pass; adds the five summarization-palette node
 * types to both sides together. `configSchema` is deliberately NOT set on these literals —
 * see the derivation below, which attaches it uniformly from `NODE_CONFIG_SCHEMAS`.
 */
const WORKFLOW_NODE_REGISTRY_BASE: Readonly<Record<string, Omit<WorkflowNodeDescriptor, 'configSchema' | 'inputs' | 'outputs'>>> = Object.freeze({
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
    trigger: 'on-start',
    lane: 'durable',
    requires: Object.freeze([]),
    idempotent: true,
    schemaVersion: 1,
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
    trigger: 'on-start',
    lane: 'durable',
    requires: Object.freeze([]),
    idempotent: true,
    schemaVersion: 1,
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
    // `entry` (TASK-864): the palette-agnostic bookend rules select the graph entry by CLASS, so
    // one rule admits this legacy marker and the `core` vocabulary's `core.trigger` alike.
    classes: Object.freeze(['boundary', 'entry']),
    paletteKey: null,
    critical: false,
    externalWrite: false,
    defaultTimeoutSeconds: 30,
    defaultMaxAttempts: 1,
    entitlementKey: null,
    trigger: 'on-start',
    lane: 'durable',
    requires: Object.freeze([]),
    idempotent: true,
    schemaVersion: 1,
  }),
  'core.end': Object.freeze({
    key: 'core.end',
    implemented: true,
    activityName: 'interpreter.core_end',
    classes: Object.freeze(['boundary', 'terminal']),
    paletteKey: null,
    critical: false,
    externalWrite: false,
    defaultTimeoutSeconds: 30,
    defaultMaxAttempts: 1,
    entitlementKey: null,
    trigger: 'on-end',
    lane: 'durable',
    requires: Object.freeze([]),
    idempotent: true,
    schemaVersion: 1,
  }),
  // -------------------------------------------------------------------------------------------
  // Summarization palette — five node types, `paletteKey: 'summarization'`. `classes`
  // carries `'activity'` on every entry (each emits exactly one NODE trajectory step per
  // palette.md's "emitsTrajectory" section) plus `'generation'` on `generate.text` only (the one
  // node whose compiled config carries an `onError` field — matches the existing DRAFT rule at
  // `rule-catalogue.ts` keyed off `nodeClass: 'generation'`). None carry `'gate'` — none are HITL
  // gates, so the compiler correctly leaves all five inside `stages[]` (none lifted into `gates[]`,
  // which v1's admission requires to stay — step 5).
  // `entitlementKey: null` on every entry — R-7: `PlanEntitlement` is
  // column-per-key, not a free-string registry, so gating this palette needs a migration, not a
  // registry value; not added here.
  //
  // RESTORED (2026-08-17, close-out pass): these five entries were dropped from this file by an
  // external tree operation mid-session (see / READMEs, and
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
    trigger: 'on-start',
    lane: 'durable',
    requires: Object.freeze([]),
    idempotent: true,
    schemaVersion: 1,
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
    trigger: 'on-start',
    lane: 'durable',
    requires: Object.freeze([]),
    idempotent: true,
    schemaVersion: 1,
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
    trigger: 'on-end',
    lane: 'durable',
    requires: Object.freeze([]),
    idempotent: true,
    schemaVersion: 1,
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
    trigger: 'on-end',
    lane: 'durable',
    requires: Object.freeze([]),
    idempotent: true,
    schemaVersion: 1,
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
    trigger: 'on-end',
    lane: 'durable',
    requires: Object.freeze([]),
    idempotent: true,
    schemaVersion: 1,
  }),
  // -------------------------------------------------------------------------------------------
  // STT palette — eight node types, `paletteKey: 'stt'`. See
  // for the node table, `critical`
  // rationale, and the `implemented: false` decision on `stt.phiHop` (a documented placeholder
  // pending — `implemented: false` makes compile() refuse ANY graph that includes it,
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
    trigger: 'on-start',
    lane: 'durable',
    requires: Object.freeze([]),
    idempotent: true,
    schemaVersion: 1,
    deprecated: true,
    replacedBy: 'core.agent',
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
    trigger: 'per-turn',
    lane: 'durable',
    requires: Object.freeze([]),
    idempotent: true,
    schemaVersion: 1,
    deprecated: true,
    replacedBy: 'core.agent',
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
    trigger: 'per-turn',
    lane: 'durable',
    requires: Object.freeze([]),
    idempotent: true,
    schemaVersion: 1,
    deprecated: true,
    replacedBy: 'core.agent',
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
    trigger: 'per-turn',
    lane: 'durable',
    requires: Object.freeze([]),
    idempotent: true,
    schemaVersion: 1,
    deprecated: true,
    replacedBy: 'core.agent',
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
    trigger: 'per-turn',
    lane: 'durable',
    requires: Object.freeze([]),
    idempotent: true,
    schemaVersion: 1,
    deprecated: true,
    replacedBy: 'core.agent',
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
    trigger: 'per-turn',
    lane: 'durable',
    requires: Object.freeze([]),
    idempotent: true,
    schemaVersion: 1,
    deprecated: true,
    replacedBy: 'core.agent',
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
    trigger: 'on-end',
    lane: 'durable',
    requires: Object.freeze([]),
    idempotent: true,
    schemaVersion: 1,
    deprecated: true,
    replacedBy: 'core.agent',
  }),
  // PLACEHOLDER — implemented:false, see palette.md. /phi-redactor is not landed.
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
    trigger: 'per-turn',
    lane: 'durable',
    requires: Object.freeze([]),
    idempotent: true,
    schemaVersion: 1,
    deprecated: true,
    replacedBy: 'core.agent',
  }),
  // -------------------------------------------------------------------------------------------
  // Consultation palette — all 13 node types.
  // An earlier revision registered only 3 (consentGate, phiHop, hitlGate) and left the other 10 specified
  // but unwired; since `DRAFT_CONSULTATION_RULE_SET` names NINE node types by key, that left the
  // palette unbuildable — the Studio's rail could offer three nodes for a rule set demanding
  // nine. The ten added here each carry the same compile() target `contracts/palette-contract.md`
  // already verified for them, now with a real interpreter wrapper on the Python side
  // (`nodes/consultation_{capture,nlp,compose,verify,persist}.py`).
  //
  // Ordered by pipeline position (consent → capture → NLP → PHI → evidence → compose → verify →
  // persist → gate), not alphabetically, so the file reads as the mandatory subgraph it encodes.
  // `classes` stays the predicate-selector vocabulary the rest of this registry uses
  // (`activity`, plus `generation` on the one node that generates text — mirroring
  // `generate.text`); it is deliberately NOT the "safety class" column of node-types.md, which is
  // a graph-shape property the validator owns, exactly as consentGate/phiHop already did.
  // (phi-redactor) HAS landed (unlike at STT's execution time), so `consultation.phiHop`
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
    trigger: 'on-start',
    lane: 'durable',
    requires: Object.freeze([]),
    idempotent: true,
    schemaVersion: 1,
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
    trigger: 'on-start',
    lane: 'realtime',
    requires: Object.freeze([]),
    idempotent: true,
    schemaVersion: 1,
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
    trigger: 'per-turn',
    lane: 'realtime',
    requires: Object.freeze([]),
    idempotent: true,
    schemaVersion: 1,
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
    trigger: 'per-turn',
    lane: 'durable',
    requires: Object.freeze([]),
    idempotent: true,
    schemaVersion: 1,
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
    trigger: 'per-turn',
    lane: 'durable',
    requires: Object.freeze([]),
    idempotent: true,
    schemaVersion: 1,
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
    trigger: 'per-turn',
    lane: 'durable',
    requires: Object.freeze([]),
    idempotent: true,
    schemaVersion: 1,
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
    trigger: 'on-end',
    lane: 'durable',
    requires: Object.freeze([]),
    idempotent: true,
    schemaVersion: 1,
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
    trigger: 'on-end',
    lane: 'durable',
    requires: Object.freeze([]),
    idempotent: true,
    schemaVersion: 1,
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
    trigger: 'on-end',
    lane: 'durable',
    requires: Object.freeze([]),
    idempotent: true,
    schemaVersion: 1,
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
    trigger: 'on-end',
    lane: 'durable',
    requires: Object.freeze([]),
    idempotent: true,
    schemaVersion: 1,
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
    trigger: 'on-end',
    lane: 'durable',
    requires: Object.freeze([]),
    idempotent: true,
    schemaVersion: 1,
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
    trigger: 'on-end',
    lane: 'durable',
    requires: Object.freeze([]),
    idempotent: true,
    schemaVersion: 1,
  }),
  // The ONE durable human wait in this substrate (now implemented). The `gate`
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
    trigger: 'on-end',
    lane: 'durable',
    requires: Object.freeze([]),
    idempotent: true,
    schemaVersion: 1,
  }),
  // -------------------------------------------------------------------------------------------
  // R3's three missing capabilities (-W3). The owner's R3 asks ONE workflow to
  // coordinate record -> transcribe -> realtime entity extraction -> REALTIME SHORT SUMMARIES ->
  // autofill SOAP -> INTELLIGENT SUGGESTIONS -> SPELLING/MEDICAL-TERM/DRUG-NAME CORRECTION.
  // verified the last three had no node, activity or sensor anywhere: the nearest
  // neighbours only VERIFY (`consultation.bindTerminology` validates codes read-only,
  // `sensors/computational/numeric_dose.py` flags a dose mismatch and never corrects it).
  //
  // None carries `critical` — CR-14 makes only consentGate/hitlGate critical, and a suggestion
  // or a spelling proposal failing must never fail a consultation that is otherwise producing a
  // note. Mirrors `registry.py`'s matching three entries and the committed parity fixture.
  // -------------------------------------------------------------------------------------------
  'consultation.realtimeSummary': Object.freeze({
    key: 'consultation.realtimeSummary',
    implemented: true,
    activityName: 'interpreter.consultation_realtime_summary',
    // `generation` for the same reason `consultation.synthesize` carries it: this node calls a
    // model to produce prose. `externalWrite` because it PUBLISHES each interim summary to the
    // live consultation feed — which also makes the interpreter's sandbox suppression correct
    // for free, since a sandbox run must not push summaries into a real consultation's UI.
    classes: Object.freeze(['activity', 'generation']),
    paletteKey: 'consultation',
    critical: false,
    externalWrite: true,
    defaultTimeoutSeconds: 150,
    defaultMaxAttempts: 2,
    entitlementKey: null,
    trigger: 'per-turn',
    lane: 'realtime',
    requires: Object.freeze([]),
    idempotent: true,
    schemaVersion: 1,
  }),
  'consultation.suggestions': Object.freeze({
    key: 'consultation.suggestions',
    implemented: true,
    activityName: 'interpreter.consultation_suggestions',
    classes: Object.freeze(['activity', 'generation']),
    paletteKey: 'consultation',
    critical: false,
    // A PROPOSAL surface: it returns suggestions and writes nothing.
    externalWrite: false,
    defaultTimeoutSeconds: 150,
    defaultMaxAttempts: 2,
    entitlementKey: null,
    trigger: 'per-turn',
    lane: 'durable',
    requires: Object.freeze([]),
    idempotent: true,
    schemaVersion: 1,
  }),
  'consultation.proposeCorrections': Object.freeze({
    key: 'consultation.proposeCorrections',
    implemented: true,
    activityName: 'interpreter.consultation_propose_corrections',
    classes: Object.freeze(['activity', 'generation']),
    paletteKey: 'consultation',
    critical: false,
    // `externalWrite: false` is a SAFETY property here, not a performance one. This node
    // PROPOSES spelling/medical-term/drug-name corrections with provenance and never applies
    // them: a system that silently rewrites a drug name or a dose in clinical text is a
    // patient-safety defect, not a feature. The clinician accepts; the console is
    // the surface that offers the choice.
    externalWrite: false,
    defaultTimeoutSeconds: 150,
    defaultMaxAttempts: 2,
    entitlementKey: null,
    trigger: 'per-turn',
    lane: 'durable',
    requires: Object.freeze([]),
    idempotent: true,
    schemaVersion: 1,
  }),
  // -------------------------------------------------------------------------------------------
  // The ENDPOINT STAGE — the ordered sequence that runs before a consultation session
  // closes. Three node types, closing three defects that were all the same defect wearing
  // different clothes: the stage was a hardcoded literal an admin could only SUBTRACT from
  // (D-10), it had no feedback-capture node at all (D-11), and an idle timeout deliberately
  // skipped it, so a timed-out consultation never finalized (D-12).
  //
  // All three are `trigger: 'on-end'`, `lane: 'durable'` and therefore `idempotent: true` —
  // `nodeDescriptorContractProblems` refuses a durable non-idempotent node, and it is right to:
  // Temporal retries activities, and a retry that double-finalizes or double-promotes a
  // correction does so invisibly. Each activity converges rather than accumulating (see
  // `nodes/consultation_endpoint.py`).
  //
  // None is `critical`. CR-14 keeps `consentGate`/`hitlGate` the only critical consultation
  // nodes, and the endpoint stage must not inherit criticality by association: a feedback
  // capture that fails must not fail a consultation whose note is already finalized. What DOES
  // protect the clinical work is that finalize runs FIRST in the default sequence, before
  // anything that may legitimately degrade.
  //
  // They carry `paletteKey: 'consultation'` (so the Studio's palette rail offers them alongside
  // the pipeline they close) but NOT a `consultation.` key prefix, because they are stage
  // vocabulary rather than pipeline steps — `session`, `summary`, `feedback` name what the node
  // acts on, exactly as `input.`/`prompt.`/`generate.`/`guardrail.`/`output.` do in the
  // summarization palette.
  // -------------------------------------------------------------------------------------------
  'session.timeout': Object.freeze({
    key: 'session.timeout',
    implemented: true,
    activityName: 'interpreter.session_timeout',
    classes: Object.freeze(['activity', 'endpoint']),
    paletteKey: 'consultation',
    critical: false,
    // Stamps the consultation's endpoint disposition (how the session ended, and under which
    // idle bound). A real write, so a SANDBOX run must not perform it.
    externalWrite: true,
    defaultTimeoutSeconds: 30,
    defaultMaxAttempts: 3,
    entitlementKey: null,
    trigger: 'on-end',
    lane: 'durable',
    requires: Object.freeze([]),
    idempotent: true,
    schemaVersion: 1,
  }),
  'summary.finalize': Object.freeze({
    key: 'summary.finalize',
    implemented: true,
    activityName: 'interpreter.summary_finalize',
    classes: Object.freeze(['activity', 'endpoint']),
    paletteKey: 'consultation',
    critical: false,
    // DD-3: locks EVERY document of the consultation, not just the SOAP note.
    externalWrite: true,
    defaultTimeoutSeconds: 60,
    defaultMaxAttempts: 3,
    entitlementKey: null,
    trigger: 'on-end',
    lane: 'durable',
    requires: Object.freeze([]),
    idempotent: true,
    schemaVersion: 1,
  }),
  'feedback.capture': Object.freeze({
    key: 'feedback.capture',
    implemented: true,
    activityName: 'interpreter.feedback_capture',
    classes: Object.freeze(['activity', 'endpoint']),
    paletteKey: 'consultation',
    critical: false,
    // DD-8. `consultation.proposeCorrections` is `externalWrite: false` precisely because a
    // system that silently rewrites a drug name is a patient-safety defect; this node is where a
    // clinician's ACCEPTANCE turns one of those proposals into a real correction over the raw
    // channel, and it is the only node in the registry that both consumes `edits` and writes.
    externalWrite: true,
    defaultTimeoutSeconds: 30,
    defaultMaxAttempts: 3,
    entitlementKey: null,
    trigger: 'on-end',
    lane: 'durable',
    requires: Object.freeze([]),
    idempotent: true,
    schemaVersion: 1,
  }),
  // -------------------------------------------------------------------------------------------
  // The TARGET CATALOGUE (/DD-9) and the guards — lane A.
  //
  // ## Why these are ADDITIONS, not renames
  //
  // A node type is a contract with every saved tenant graph (see `schemaVersion` above), and both
  // committed seed graphs plus every golden fixture name the pipeline keys above. So the target
  // catalogue is registered ALONGSIDE them. The two vocabularies are not duplicate BEHAVIOUR —
  // each `agent.*` entry DELEGATES to the engine of its pipeline counterpart, so there is one
  // implementation, two names, and no second behaviour to keep in step.
  //
  // | Catalogue entry | Engine it delegates to |
  // |---|---|
  // | `agent.transcription` | `interpreter.consultation_capture_binding` |
  // | `agent.normalization` | `interpreter.consultation_bind_terminology` (ontology linking) |
  // | `agent.ner` | `interpreter.consultation_extract_entities` |
  // | `agent.presummarization` / `agent.summarization` / `agent.discharge_summary` | `interpreter.text_generate` — DD-9's ONE generation engine |
  // | `agent.retrieval` | `interpreter.consultation_retrieve_evidence` |
  // | `agent.feedback` | `interpreter.feedback_capture` |
  // | `agent.dna_redaction` | `interpreter.consultation_phi_hop`'s redactor, in DNA-rule mode |
  // | `guard.phi` | `interpreter.consultation_phi_hop` |
  // | `guard.moderation` | `interpreter.guardrail_check` |
  // | `guard.groundedness` | `interpreter.consultation_sensors` (the groundedness sensor) |
  //
  // `paletteKey: 'consultation'` on the `agent.*` entries follows precedent for
  // `session.timeout`/`summary.finalize`/`feedback.capture`: the palette rail is where an admin
  // FINDS a node, and DD-9's whole reason for three generation entries is that an admin can find
  // them. The `guard.*` entries are `paletteKey: null` because a guard genuinely is
  // palette-agnostic — the summarization palette's generation node needs one exactly as the
  // consultation palette's does.
  // -------------------------------------------------------------------------------------------
  'agent.transcription': Object.freeze({
    key: 'agent.transcription',
    implemented: true,
    activityName: 'interpreter.agent_transcription',
    classes: Object.freeze(['activity']),
    paletteKey: 'consultation',
    critical: false,
    externalWrite: false,
    defaultTimeoutSeconds: 30,
    defaultMaxAttempts: 2,
    entitlementKey: null,
    trigger: 'per-turn',
    // Same lane as the capture node it delegates to: the runtime that actually produces a
    // transcript from a live session is realtime executor.
    lane: 'realtime',
    // A transcript is the most PHI-dense artifact this platform holds, and every consultation
    // rule set already makes a redaction hop mandatory on every path out of capture
    // (WF-CONS-009). Stating it as a guard requirement is what carries that property into a
    // graph built from the new catalogue, where no WF-CONS rule applies.
    requires: Object.freeze(['guard.phi']),
    idempotent: true,
    schemaVersion: 1,
  }),
  'agent.normalization': Object.freeze({
    key: 'agent.normalization',
    implemented: true,
    activityName: 'interpreter.agent_normalization',
    classes: Object.freeze(['activity']),
    paletteKey: 'consultation',
    critical: false,
    externalWrite: false,
    defaultTimeoutSeconds: 30,
    defaultMaxAttempts: 1,
    entitlementKey: null,
    trigger: 'per-turn',
    lane: 'durable',
    requires: Object.freeze([]),
    idempotent: true,
    schemaVersion: 1,
  }),
  'agent.ner': Object.freeze({
    key: 'agent.ner',
    implemented: true,
    activityName: 'interpreter.agent_ner',
    classes: Object.freeze(['activity']),
    paletteKey: 'consultation',
    critical: false,
    // The persist leg writes, exactly as `consultation.extractEntities`' does — which is also
    // what makes the interpreter's sandbox suppression correct for free.
    externalWrite: true,
    defaultTimeoutSeconds: 150,
    defaultMaxAttempts: 2,
    entitlementKey: null,
    trigger: 'per-turn',
    lane: 'realtime',
    requires: Object.freeze([]),
    idempotent: true,
    schemaVersion: 1,
  }),
  // Lane R (R1) — the GRAMMAR/SPELLING pass of the owner's live loop, and the catalogue's
  // realtime sibling of `consultation.proposeCorrections`.
  //
  // ## Why a sibling rather than flipping the durable node's lane
  //
  // `lane` is a property of the node TYPE and the durable interpreter SKIPS a `realtime` node
  // (`workflow.py`, reason `realtime_lane`), so one type cannot serve both runtimes. Both uses
  // are real and neither may be deleted: the seeded ArcaAI graphs wire `n_synth -> n_correct`,
  // i.e. the durable node reviews the FINISHED synthesized note, while the live loop needs
  // corrections over the RAW PARTIAL TRANSCRIPT inside a flush budget. Flipping the lane would
  // silently delete the first from every graph that already uses it.
  //
  // The INPUT TYPE is what makes the two genuinely different contracts rather than duplicates:
  // `consultation.proposeCorrections.in` is `text` precisely so it may review a generated note;
  // this node's `in` is `transcript`, so "the live grammar pass corrects what was SAID, not what
  // the model WROTE" is structural. Its product is `edits`, which nothing here applies — a
  // corrected transcript is ALWAYS ADVISORY alongside the raw, and promotion happens only
  // through the DD-8 accepted-proposal path.
  //
  // Budget and retry are realtime-shaped on purpose: the executor races each node against its
  // own timer on a flush cadence, and a retry inside a flush that a newer one supersedes is
  // discarded as `stale`, so a second attempt buys latency and nothing else.
  'agent.grammar': Object.freeze({
    key: 'agent.grammar',
    implemented: true,
    activityName: 'interpreter.agent_grammar',
    classes: Object.freeze(['activity', 'generation']),
    paletteKey: 'consultation',
    critical: false,
    // A SAFETY property, not a performance one — identical to the durable sibling's. This node
    // proposes; the clinician accepts.
    externalWrite: false,
    defaultTimeoutSeconds: 20,
    defaultMaxAttempts: 1,
    entitlementKey: null,
    trigger: 'per-turn',
    lane: 'realtime',
    requires: Object.freeze([]),
    idempotent: true,
    schemaVersion: 1,
  }),
  // IMPORTANT FINDINGS, the capability the realtime lane audit recorded as
  // absent: "there is no red-flag / critical-value / allergy-alert / severity layer anywhere".
  //
  // ## It is a CONFIGURATION capability, not a heuristic
  //
  // The owner's specification is a configuration statement end to end: findings are "mined /
  // generated / extracted by agent following a set of instructions defined / declared /
  // overwriten by tenant admin for using LLM to detect, extract, picking-up knowledge from
  // consultation context (transcription, consultation context items, etc...)". So this node ships
  // NO severity ladder, NO red-flag term list and NO importance threshold — every one of those
  // would be the platform deciding what "important" means on a tenant's behalf, which is exactly
  // the hardcoded configuration `00-project-context.md` §Configuration Principles forbids. The
  // instructions are a BOUND PROMPT TEMPLATE on the node's own config, resolved through the same
  // approval-gated path every other governed prompt uses, and a tenant with no opinion inherits
  // the platform-default template the seed binds rather than a constant in this file.
  //
  // ## Why REALTIME, and why that costs nothing on the durable path
  //
  // The acceptance bar is "important information popped up and highlighted" DURING a live
  // session; a durable `on-end` node cannot pop anything up while a clinician is still speaking.
  // The realtime executor is also where the highlight path already exists — re-anchors
  // transcript-sourced entities into the rendered note (`groundEntitiesToNote`), and this node's
  // output is `entities` precisely so findings ride that path rather than growing a second one.
  // The durable interpreter SKIPS it (`reason: 'realtime_lane'`), so exactly one runtime owns it.
  //
  // ## The first catalogue entry with NO pipeline counterpart
  //
  // Every other `agent.*` entry is a thin delegation to an engine that already exists. This
  // capability did not exist in any form, so its activity is a real implementation and its config
  // schema is its own — the same position `agent.dna_redaction` and `guard.groundedness` are in.
  // It calls `apps/text` for the judgement and `apps/nlp` for nothing: no second inference stack.
  'agent.important_findings': Object.freeze({
    key: 'agent.important_findings',
    implemented: true,
    activityName: 'interpreter.agent_important_findings',
    classes: Object.freeze(['activity']),
    paletteKey: 'consultation',
    critical: false,
    // Its findings reach the live consultation feed and the persisted flush snapshot through the
    // SAME projection `agent.ner`'s entities do. Claiming `false` would say this node's output
    // never leaves the run, which is untrue — and the sandbox suppression the flag buys costs
    // nothing on a lane the durable interpreter skips anyway.
    externalWrite: true,
    // Realtime-shaped, like `agent.grammar`: the executor races each node against its own timer
    // on a flush cadence, so a durable 150s budget would outlive the flush that started it.
    defaultTimeoutSeconds: 25,
    // A retry inside a flush that a newer one supersedes is discarded as `stale`.
    defaultMaxAttempts: 1,
    entitlementKey: null,
    trigger: 'per-turn',
    lane: 'realtime',
    // Deliberately EMPTY, and the reason is the lesson rather than an oversight. The owner
    // says grounding EVALUATES highlighted findings — but `guard.groundedness` is a `durable`
    // node, so a `requires` edge from this realtime node would name a guard that cannot run in
    // the lane that produces the findings. A publish-time requirement the runtime does not honour
    // is precisely the drift `requires`' own docstring warns about; the relationship is expressed
    // where it is real, as the guard's optional `findings` input port.
    requires: Object.freeze([]),
    idempotent: true,
    schemaVersion: 1,
  }),
  // DD-6 — pre-summarization is a NODE, fed from context supplied at runtime, running on-start.
  // It must stay NON-SIGNABLE: `isFinalSummary` excludes `PRE_SUMMARY`, locked by
  // `kept-generators-signability.task732.test.ts:63`. Nothing here can make it signable — that
  // property lives on the generator, not the node — but the constraint is recorded because a
  // future `externalWrite`/persistence change to this node is where it would be lost.
  'agent.presummarization': Object.freeze({
    key: 'agent.presummarization',
    implemented: true,
    activityName: 'interpreter.agent_presummarization',
    classes: Object.freeze(['activity', 'generation']),
    paletteKey: 'consultation',
    critical: false,
    externalWrite: false,
    defaultTimeoutSeconds: 150,
    defaultMaxAttempts: 2,
    entitlementKey: null,
    trigger: 'on-start',
    lane: 'durable',
    requires: Object.freeze(['guard.groundedness']),
    idempotent: true,
    schemaVersion: 1,
  }),
  'agent.summarization': Object.freeze({
    key: 'agent.summarization',
    implemented: true,
    activityName: 'interpreter.agent_summarization',
    classes: Object.freeze(['activity', 'generation']),
    paletteKey: 'consultation',
    critical: false,
    externalWrite: false,
    defaultTimeoutSeconds: 150,
    defaultMaxAttempts: 2,
    entitlementKey: null,
    trigger: 'on-end',
    lane: 'durable',
    requires: Object.freeze(['guard.groundedness']),
    idempotent: true,
    schemaVersion: 1,
  }),
  'agent.discharge_summary': Object.freeze({
    key: 'agent.discharge_summary',
    implemented: true,
    activityName: 'interpreter.agent_discharge_summary',
    classes: Object.freeze(['activity', 'generation']),
    paletteKey: 'consultation',
    critical: false,
    externalWrite: false,
    defaultTimeoutSeconds: 150,
    defaultMaxAttempts: 2,
    entitlementKey: null,
    trigger: 'on-end',
    lane: 'durable',
    requires: Object.freeze(['guard.groundedness']),
    idempotent: true,
    schemaVersion: 1,
  }),
  'agent.retrieval': Object.freeze({
    key: 'agent.retrieval',
    implemented: true,
    activityName: 'interpreter.agent_retrieval',
    classes: Object.freeze(['activity']),
    paletteKey: 'consultation',
    critical: false,
    externalWrite: false,
    defaultTimeoutSeconds: 150,
    defaultMaxAttempts: 2,
    entitlementKey: null,
    trigger: 'per-turn',
    lane: 'durable',
    requires: Object.freeze([]),
    idempotent: true,
    schemaVersion: 1,
  }),
  'agent.feedback': Object.freeze({
    key: 'agent.feedback',
    implemented: true,
    activityName: 'interpreter.agent_feedback',
    classes: Object.freeze(['activity', 'endpoint']),
    paletteKey: 'consultation',
    critical: false,
    // DD-8 — an ACCEPTED advisory correction becomes real here or nowhere.
    externalWrite: true,
    defaultTimeoutSeconds: 30,
    defaultMaxAttempts: 3,
    entitlementKey: null,
    trigger: 'on-end',
    lane: 'durable',
    requires: Object.freeze([]),
    idempotent: true,
    schemaVersion: 1,
  }),
  // the DNA-redaction pass, migrated out of the resolver flag triple. The
  // department-agent VETO stays retired: this node redacts when the tenant placed it and (by
  // default) the doctor opted in, which is the two-gate behaviour the owner ruled on.
  'agent.dna_redaction': Object.freeze({
    key: 'agent.dna_redaction',
    implemented: true,
    activityName: 'interpreter.agent_dna_redaction',
    classes: Object.freeze(['activity', 'redaction']),
    paletteKey: 'consultation',
    critical: false,
    externalWrite: false,
    defaultTimeoutSeconds: 60,
    defaultMaxAttempts: 3,
    entitlementKey: null,
    trigger: 'on-end',
    lane: 'durable',
    requires: Object.freeze([]),
    idempotent: true,
    schemaVersion: 1,
  }),
  // ---- Guards -------------------------------------------------------------------------
  // `critical: false` on all three, matching the engines they delegate to
  // (`consultation.phiHop`, `guardrail.check`, `consultation.sensors` are all non-critical).
  // The PHI guard's fail-CLOSED property is not criticality: it lives in `ensure_egress_safe`,
  // which RAISES before any cloud call, so a blocked egress fails the run whatever this flag says.
  'guard.phi': Object.freeze({
    key: 'guard.phi',
    implemented: true,
    activityName: 'interpreter.guard_phi',
    classes: Object.freeze(['guard', 'redaction']),
    paletteKey: null,
    critical: false,
    externalWrite: false,
    defaultTimeoutSeconds: 60,
    defaultMaxAttempts: 3,
    entitlementKey: null,
    trigger: 'per-turn',
    lane: 'durable',
    requires: Object.freeze([]),
    idempotent: true,
    schemaVersion: 1,
  }),
  'guard.moderation': Object.freeze({
    key: 'guard.moderation',
    implemented: true,
    activityName: 'interpreter.guard_moderation',
    classes: Object.freeze(['guard']),
    paletteKey: null,
    critical: false,
    externalWrite: false,
    defaultTimeoutSeconds: 60,
    defaultMaxAttempts: 3,
    entitlementKey: null,
    trigger: 'per-turn',
    lane: 'durable',
    requires: Object.freeze([]),
    idempotent: true,
    schemaVersion: 1,
  }),
  'guard.groundedness': Object.freeze({
    key: 'guard.groundedness',
    implemented: true,
    activityName: 'interpreter.guard_groundedness',
    classes: Object.freeze(['guard']),
    paletteKey: null,
    critical: false,
    externalWrite: false,
    defaultTimeoutSeconds: 150,
    defaultMaxAttempts: 2,
    entitlementKey: null,
    trigger: 'on-end',
    lane: 'durable',
    requires: Object.freeze([]),
    idempotent: true,
    schemaVersion: 1,
  }),

  // ===========================================================================================
  // the GENERIC (`agentic`) catalogue: the eight node types of the owner's spec
  // ===========================================================================================
  //
  // Program finding F-12's have/missing table, closed. `Loop`, `Data`, `TTS` and *"any generic
  // Agent"* did not exist; `Input`, `Output` and `Guardrail` existed only as palette-specific
  // types (`input.context_binding`, `output.deliver`, `guardrail.check`) whose config is shaped
  // by the summarization pipeline rather than by the tenant; `STT` existed ×8 as registry-parity
  // placeholders that return `DEGRADED` without transcribing.
  //
  // ## Why a new palette rather than more `agent.*` keys
  //
  // The ~13 fixed-purpose `agent.*` types encode behaviour in the KEY: `agent.summarization` IS
  // summarization. These encode it in CONFIGURATION, which is a different contract with the
  // author — one node type, composed. Mixing the two families under one palette would make the
  // Studio's palette rail claim they are interchangeable. They are not, and the deprecation path
  // is one-directional: new work targets `agentic.*`; the fixed types stay because a node type is
  // a contract with every saved tenant graph and both committed seeds name them.
  //
  // `KNOWN_PALETTE_KEYS` (`exposure-palette-policy.ts`) is DERIVED from this field, so declaring
  // the palette here is the whole of registering it. `EXPOSURE_ALLOWED_PALETTES` is deliberately
  // NOT widened: an allow-list that grows by default is not an allow-list, and whether a generic
  // agentic graph is a public-exposure product is an owner decision, not a side effect of this
  // ticket.
  //
  // ## `implemented: true` on all eight, including the two whose runtime is another ticket
  //
  // `compile()` REFUSES any graph containing an `implemented: false` type (`nodeInfo()` returns
  // undefined), and this ticket's own verification criterion is *"a graph using every new node
  // type compiles to a valid IR"*. So all eight are implemented and all eight have a registered
  // activity. `agentic.loop` and `agentic.tts` are honest, OBSERVABLE non-execution: their
  // activities return `DEGRADED` naming the missing runtime (the loop
  // body, for binary audio transport), exactly as `stt_placeholder.py` does — *"fail
  // loudly… never pass through while claiming the hop ran"*. A run that reaches one is visibly
  // degraded on its trajectory; it never claims work that did not happen.
  //
  // ## `critical` / `externalWrite`, both code-owned
  //
  // `agentic.output` and `agentic.tts` are `externalWrite: true` — the first publishes the run's
  // result to claim-check storage, the second writes a synthesised audio artifact — so a
  // sandboxed run suppresses both. `agentic.stt` is `externalWrite: true` because dispatching a
  // batch transcription CREATES a `TranscriptionJob` row through apps/api. Nothing here is
  // `critical`: a generic node's failure must not fail the run by default, because the author,
  // not the registry, knows whether their agent is load-bearing (`onError` is theirs to set).
  'agentic.input': Object.freeze({
    key: 'agentic.input',
    implemented: true,
    activityName: 'interpreter.agentic_input',
    classes: Object.freeze(['boundary']),
    paletteKey: 'agentic',
    critical: false,
    externalWrite: false,
    defaultTimeoutSeconds: 30,
    defaultMaxAttempts: 2,
    entitlementKey: null,
    trigger: 'on-start',
    lane: 'durable',
    requires: Object.freeze([]),
    idempotent: true,
    schemaVersion: 1,
  }),
  'agentic.output': Object.freeze({
    key: 'agentic.output',
    implemented: true,
    activityName: 'interpreter.agentic_output',
    classes: Object.freeze(['boundary']),
    paletteKey: 'agentic',
    critical: false,
    externalWrite: true,
    defaultTimeoutSeconds: 30,
    defaultMaxAttempts: 2,
    entitlementKey: null,
    trigger: 'on-end',
    lane: 'durable',
    requires: Object.freeze([]),
    idempotent: true,
    schemaVersion: 1,
  }),
  'agentic.agent': Object.freeze({
    key: 'agentic.agent',
    implemented: true,
    activityName: 'interpreter.agentic_agent',
    classes: Object.freeze(['generation']),
    paletteKey: 'agentic',
    critical: false,
    externalWrite: false,
    defaultTimeoutSeconds: 150,
    defaultMaxAttempts: 2,
    entitlementKey: null,
    trigger: 'on-start',
    lane: 'durable',
    // `requires` stays EMPTY, unlike the three fixed generation entries which require
    // `guard.groundedness`. Not an oversight: a generic agent's guards are AUTHORED
    // (`config.guards.input`/`.output`), and `requires` is a per-TYPE mandate. Declaring both
    // would give one policy two enforcement paths, which is exactly how the two drift apart —
    // the reasoning this field's own docstring already records for the pipeline node types.
    requires: Object.freeze([]),
    idempotent: true,
    schemaVersion: 1,
  }),
  'agentic.guardrail': Object.freeze({
    key: 'agentic.guardrail',
    implemented: true,
    activityName: 'interpreter.agentic_guardrail',
    classes: Object.freeze(['guard']),
    paletteKey: 'agentic',
    critical: false,
    externalWrite: false,
    defaultTimeoutSeconds: 60,
    defaultMaxAttempts: 2,
    entitlementKey: null,
    trigger: 'on-start',
    lane: 'durable',
    requires: Object.freeze([]),
    idempotent: true,
    schemaVersion: 1,
  }),
  'agentic.data': Object.freeze({
    key: 'agentic.data',
    implemented: true,
    activityName: 'interpreter.agentic_data',
    classes: Object.freeze([]),
    paletteKey: 'agentic',
    critical: false,
    externalWrite: false,
    defaultTimeoutSeconds: 30,
    defaultMaxAttempts: 2,
    entitlementKey: null,
    trigger: 'on-start',
    lane: 'durable',
    requires: Object.freeze([]),
    idempotent: true,
    schemaVersion: 1,
  }),
  'agentic.loop': Object.freeze({
    key: 'agentic.loop',
    implemented: true,
    activityName: 'interpreter.agentic_loop',
    classes: Object.freeze([]),
    paletteKey: 'agentic',
    critical: false,
    externalWrite: false,
    // The node's own budget is deliberately the WHOLE `maxDurationSeconds` ceiling its config
    // schema permits, because spends that budget as a workflow timer INSIDE the loop.
    // A smaller activity timeout here would cap the loop somewhere the author cannot see.
    defaultTimeoutSeconds: 3600,
    defaultMaxAttempts: 1,
    entitlementKey: null,
    trigger: 'on-start',
    lane: 'durable',
    requires: Object.freeze([]),
    idempotent: true,
    schemaVersion: 1,
  }),
  'agentic.stt': Object.freeze({
    key: 'agentic.stt',
    implemented: true,
    activityName: 'interpreter.agentic_stt',
    classes: Object.freeze(['phiBearing']),
    paletteKey: 'agentic',
    critical: false,
    externalWrite: true,
    defaultTimeoutSeconds: 900,
    defaultMaxAttempts: 2,
    entitlementKey: null,
    trigger: 'on-start',
    lane: 'durable',
    requires: Object.freeze([]),
    idempotent: true,
    schemaVersion: 1,
  }),
  'agentic.tts': Object.freeze({
    key: 'agentic.tts',
    implemented: true,
    activityName: 'interpreter.agentic_tts',
    classes: Object.freeze([]),
    paletteKey: 'agentic',
    critical: false,
    externalWrite: true,
    defaultTimeoutSeconds: 300,
    defaultMaxAttempts: 2,
    entitlementKey: null,
    trigger: 'on-end',
    lane: 'durable',
    requires: Object.freeze([]),
    idempotent: true,
    schemaVersion: 1,
  }),

  // ===========================================================================================
  // TASK-864 — the `core` vocabulary: ONE palette for every future graph.
  //
  // Trigger · Agent · Classify · Human review · Variable · If/Else · Loop · Note · Output are the
  // owner's control vocabulary; `core.data` and `core.action` are the two platform-action node
  // types (a deterministic reshape, and every remaining fixed-purpose clinical step keyed by
  // `actionKey`). The four legacy palettes stay registered — a node type is a contract with every
  // saved tenant graph — and are marked `deprecated` with a `replacedBy` pointer here.
  //
  // ## Classes that are LOAD-BEARING on the compiler and the interpreter
  //
  //  - `boundary` on trigger/output: the palette-agnostic reachability rules exempt markers.
  //  - `router` on classify/condition: an edge leaving any handle other than `out`/`next` is a
  //    BRANCH — the compiler records it as a `branchGuards` entry on the target, and the
  //    interpreter SKIPS the target (`branch_not_taken`) unless that handle was taken.
  //  - `review` on humanReview: the same branch treatment for `approved`/`rejected`/`timedOut`,
  //    PLUS in-stage dispatch as a `ReviewGateWorkflow` child. Deliberately NOT `gate`: the
  //    compiler lifts `gate`-classed nodes to the END of the walk, and a review must be able to
  //    sit in the middle of a graph (`... -> Agent -> Human review -> Output`).
  //  - `loop` on loop: nodes with `parentId = <loop id>` are its BODY, compiled into
  //    `loops[].body` and run by `LoopWorkflow` one iteration per generation.
  //  - `annotation` on note: stripped by `compile()`, never dispatched.
  //
  // ## `critical` / `externalWrite`
  //
  // `core.trigger` and `core.output` are `critical`: a payload that does not match the declared
  // schema (`fail` mode) is a run that cannot honestly proceed or return. `core.output` and
  // `core.humanReview` are `externalWrite` (a published result; a recorded human decision), so a
  // sandbox run suppresses both. `core.action` is `externalWrite: false` on the TYPE and the
  // interpreter resolves the DELEGATED action's own flags per instance (`ACTION_CATALOGUE`).
  // ===========================================================================================
  'core.trigger': Object.freeze({
    key: 'core.trigger',
    implemented: true,
    activityName: 'interpreter.core_trigger',
    classes: Object.freeze(['boundary', 'mandatory', 'entry']),
    paletteKey: 'core',
    critical: true,
    externalWrite: false,
    defaultTimeoutSeconds: 30,
    defaultMaxAttempts: 1,
    entitlementKey: null,
    trigger: 'on-start',
    lane: 'durable',
    requires: Object.freeze([]),
    idempotent: true,
    schemaVersion: 1,
  }),
  'core.agent': Object.freeze({
    key: 'core.agent',
    implemented: true,
    activityName: 'interpreter.core_agent',
    // NOT `generation`-classed, deliberately. That class means "this NODE carries the prompt
    // binding, the eval gate and the document-shape pin"; an Agent node carries none of them —
    // its instruction, its model and its guards live on the published Agent row it references
    // (TASK-863). It is also what keeps the anti-laundering rule intact: a generation-classed node
    // may never emit `transcript`, and this node's `transcript` socket is live for an ASR agent.
    classes: Object.freeze(['agent']),
    paletteKey: 'core',
    critical: false,
    externalWrite: false,
    defaultTimeoutSeconds: 300,
    defaultMaxAttempts: 2,
    entitlementKey: null,
    trigger: 'on-start',
    lane: 'durable',
    requires: Object.freeze([]),
    idempotent: true,
    schemaVersion: 1,
  }),
  'core.classify': Object.freeze({
    key: 'core.classify',
    implemented: true,
    activityName: 'interpreter.core_classify',
    classes: Object.freeze(['router']),
    paletteKey: 'core',
    critical: false,
    externalWrite: false,
    defaultTimeoutSeconds: 60,
    defaultMaxAttempts: 2,
    entitlementKey: null,
    trigger: 'on-start',
    lane: 'durable',
    requires: Object.freeze([]),
    idempotent: true,
    schemaVersion: 1,
  }),
  'core.humanReview': Object.freeze({
    key: 'core.humanReview',
    implemented: true,
    activityName: 'interpreter.core_human_review',
    classes: Object.freeze(['review']),
    paletteKey: 'core',
    critical: false,
    externalWrite: true,
    // The wait itself; `timeoutSeconds` on the node config is the review deadline.
    defaultTimeoutSeconds: 3600,
    defaultMaxAttempts: 1,
    entitlementKey: null,
    trigger: 'on-start',
    lane: 'durable',
    requires: Object.freeze([]),
    idempotent: true,
    schemaVersion: 1,
  }),
  'core.variable': Object.freeze({
    key: 'core.variable',
    implemented: true,
    activityName: 'interpreter.core_variables',
    classes: Object.freeze([]),
    paletteKey: 'core',
    critical: false,
    externalWrite: false,
    defaultTimeoutSeconds: 30,
    defaultMaxAttempts: 2,
    entitlementKey: null,
    trigger: 'on-start',
    lane: 'durable',
    requires: Object.freeze([]),
    idempotent: true,
    schemaVersion: 1,
  }),
  'core.condition': Object.freeze({
    key: 'core.condition',
    implemented: true,
    activityName: 'interpreter.core_condition',
    classes: Object.freeze(['router']),
    paletteKey: 'core',
    critical: false,
    externalWrite: false,
    defaultTimeoutSeconds: 30,
    defaultMaxAttempts: 2,
    entitlementKey: null,
    trigger: 'on-start',
    lane: 'durable',
    requires: Object.freeze([]),
    idempotent: true,
    schemaVersion: 1,
  }),
  'core.loop': Object.freeze({
    key: 'core.loop',
    implemented: true,
    activityName: 'interpreter.core_loop',
    classes: Object.freeze(['loop']),
    paletteKey: 'core',
    critical: false,
    externalWrite: false,
    // The whole `maxDurationSeconds` ceiling — the parent spends it as a workflow timer.
    defaultTimeoutSeconds: 3600,
    defaultMaxAttempts: 1,
    entitlementKey: null,
    trigger: 'on-start',
    lane: 'durable',
    requires: Object.freeze([]),
    idempotent: true,
    schemaVersion: 1,
  }),
  'core.note': Object.freeze({
    key: 'core.note',
    implemented: true,
    activityName: 'interpreter.core_note',
    classes: Object.freeze(['annotation']),
    paletteKey: 'core',
    critical: false,
    externalWrite: false,
    defaultTimeoutSeconds: 1,
    defaultMaxAttempts: 1,
    entitlementKey: null,
    trigger: 'on-start',
    lane: 'durable',
    requires: Object.freeze([]),
    idempotent: true,
    schemaVersion: 1,
  }),
  'core.output': Object.freeze({
    key: 'core.output',
    implemented: true,
    activityName: 'interpreter.core_output',
    classes: Object.freeze(['boundary', 'mandatory', 'terminal']),
    paletteKey: 'core',
    critical: true,
    externalWrite: true,
    defaultTimeoutSeconds: 60,
    defaultMaxAttempts: 2,
    entitlementKey: null,
    trigger: 'on-end',
    lane: 'durable',
    requires: Object.freeze([]),
    idempotent: true,
    schemaVersion: 1,
  }),
  'core.data': Object.freeze({
    key: 'core.data',
    implemented: true,
    activityName: 'interpreter.core_data',
    classes: Object.freeze([]),
    paletteKey: 'core',
    critical: false,
    externalWrite: false,
    defaultTimeoutSeconds: 30,
    defaultMaxAttempts: 2,
    entitlementKey: null,
    trigger: 'on-start',
    lane: 'durable',
    requires: Object.freeze([]),
    idempotent: true,
    schemaVersion: 1,
  }),
  'core.action': Object.freeze({
    key: 'core.action',
    implemented: true,
    activityName: 'interpreter.core_action',
    classes: Object.freeze(['action']),
    paletteKey: 'core',
    critical: false,
    externalWrite: false,
    defaultTimeoutSeconds: 150,
    defaultMaxAttempts: 2,
    entitlementKey: null,
    trigger: 'on-start',
    lane: 'durable',
    requires: Object.freeze([]),
    idempotent: true,
    schemaVersion: 1,
  }),
});

/**
 * The public registry: `WORKFLOW_NODE_REGISTRY_BASE` with each entry's `configSchema` attached
 * from `NODE_CONFIG_SCHEMAS` (`node-config-schemas.ts`) and its `inputs`/`outputs` from
 * `NODE_PORTS` (`node-ports.ts`). A key absent from the schema map yields
 * `configSchema: undefined` — the documented, structural "no schema authored yet" state, not a
 * defect (see that module's docstring for which node types this applies to and why).
 *
 * A key absent from `NODE_PORTS` is NOT the same kind of state: it yields empty port lists,
 * which is the exact D-4 condition this ticket closes, so `__tests__/node-contract.test.ts`
 * fails on it rather than letting a portless node type ship.
 */
export const WORKFLOW_NODE_REGISTRY: Readonly<Record<string, WorkflowNodeDescriptor>> = Object.freeze(
  Object.fromEntries(
    Object.entries(WORKFLOW_NODE_REGISTRY_BASE).map(([key, descriptor]) => {
      const declaredPorts = NODE_PORTS[key] ?? EMPTY_PORTS;
      return [
        key,
        Object.freeze({ ...descriptor, configSchema: NODE_CONFIG_SCHEMAS[key], inputs: declaredPorts.inputs, outputs: declaredPorts.outputs }),
      ];
    }),
  ),
);

/**
 * the palette the eight GENERIC node types belong to.
 *
 * Declared as a constant rather than typed as a string literal at each call site because three
 * independent things key on it: `KNOWN_PALETTE_KEYS` derives the create-time validation set from
 * the registry, the Studio's palette rail groups by it, and `AGENTIC_NODE_TYPES` below is derived
 * from it. A fourth thing deliberately does NOT: `EXPOSURE_ALLOWED_PALETTES` stays
 * `{summarization}`, so a generic agentic graph is not REST-invokable through the public exposure
 * plane until someone affirmatively decides it is a product there.
 */
export const AGENTIC_PALETTE_KEY = 'agentic';

/**
 * The eight generic node types, DERIVED from `paletteKey` rather than re-typed. A ninth added to
 * the palette joins this set for free; one that leaves it leaves visibly.
 */
export const AGENTIC_NODE_TYPES: readonly string[] = Object.freeze(
  Object.values(WORKFLOW_NODE_REGISTRY)
    .filter((descriptor) => descriptor.paletteKey === AGENTIC_PALETTE_KEY)
    .map((descriptor) => descriptor.key),
);

/**
 * TASK-864 — the `core` palette: the ONE vocabulary new graphs are authored in. Declared as a
 * constant for the same three reasons `AGENTIC_PALETTE_KEY` is.
 */
export const CORE_PALETTE_KEY = 'core';

/** The `core.*` node types, DERIVED from `paletteKey` rather than re-typed. */
export const CORE_NODE_TYPES: readonly string[] = Object.freeze(
  Object.values(WORKFLOW_NODE_REGISTRY)
    .filter((descriptor) => descriptor.paletteKey === CORE_PALETTE_KEY)
    .map((descriptor) => descriptor.key),
);

/** Whether a node type is marked deprecated (TASK-859 §6) — `false` for an unknown type. */
export function isDeprecatedNodeType(nodeType: string): boolean {
  return WORKFLOW_NODE_REGISTRY[nodeType]?.deprecated === true;
}

/** The registry-declared classes for a node type — `[]` for an unknown type (never throws;
 *  a caller checks `nodeInfo()`/`compile()` findings for "unknown type", not this). */
export function classesOf(nodeType: string): readonly string[] {
  return WORKFLOW_NODE_REGISTRY[nodeType]?.classes ?? [];
}

/** The palette a node type belongs to, or `undefined` if unregistered/palette-agnostic. */
export function paletteOf(nodeType: string): string | undefined {
  return WORKFLOW_NODE_REGISTRY[nodeType]?.paletteKey ?? undefined;
}

/** The `{ activity, classes }` shape `compile()`'s `CompilerContext.nodeInfo()` expects —
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
 * sha256 of the registry, descriptors sorted by `key` before hashing ( finding #7:
 * "descriptor array order must also be stable or every deploy looks like a registry bump and
 * flags every published definition NEEDS_REVIEW"). A definition's stamped `registryChecksum`
 * is compared against this at read time to trigger `NEEDS_REVIEW` re-validation.
 */
export function registryChecksum(): string {
  const sorted = Object.values(WORKFLOW_NODE_REGISTRY)
    .slice()
    .sort((a, b) => a.key.localeCompare(b.key));
  return createHash('sha256').update(canonicalJson(sorted)).digest('hex');
}
