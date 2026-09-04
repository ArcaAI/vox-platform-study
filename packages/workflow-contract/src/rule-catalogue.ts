/**
 * ============================================================================================
 * DRAFT — NOT CLINICALLY REVIEWED. DO NOT PRESENT AS A VALIDATED SAFETY BOUNDARY.
 * ============================================================================================
 *
 * These rule INSTANCES were authored by this ticket's engineering pass from the
 * `01-invariant-register.md` assessment, exactly as Risk #1 anticipates: "The 22
 * initial rules were derived from the register by this ticket's author, not by a clinician.
 * They need clinical review before Phase C, and the review's outcome may add, remove or
 * re-scope rules." That review has NOT happened in this session. See
 * full DRAFT status statement, the register cross-references, and the reviewer sign-off box.
 *
 * This export exists so the golden test suite (`__tests__/golden.test.ts`) has something
 * concrete to run against and so a future `WorkflowInvariantRule` seed (not
 * built here) has a starting point — it does NOT wire these rules as a publish-blocking gate
 * anywhere. No application service in this repo imports this module. Wiring `validate()`
 * behind a real publish path is, gated in this session on node
 * registry (Phases B–F) not existing yet
 *
 * SCOPE NOTE — 17 of the ticket's ~22-23 catalogued rules, not all of them: the six
 * `schema`-class rules (`WF-C-001..006`) each need either the code-owned node registry
 * (`WORKFLOW_NODE_REGISTRY`, Phases B–F, not built) or repository/entitlement I/O
 * (`WF-C-004`, `WF-C-006` — deliberately impure per and so are NOT included
 * here; they are implemented directly by the impure `WorkflowValidatorService` once
 * that registry exists. The 7 structural + 10 invariant rules below need only the graph and an
 * abstract `WorkflowEvaluationContext` (registry-class lookup), so they are genuinely
 * evaluable — and testable — today.
 */
import type { WorkflowRuleClass, WorkflowFindingSeverity } from './report';
import type { WorkflowRulePredicateType } from './predicates';

export interface DraftWorkflowRule {
  ruleId: string;
  ruleClass: WorkflowRuleClass;
  predicateType: WorkflowRulePredicateType;
  predicateConfig: unknown;
  severity: WorkflowFindingSeverity;
  /** null = applies to every palette. */
  paletteKey: string | null;
  registerRefs: readonly string[];
  title: string;
  /** Always 'DRAFT' — see the module docstring. */
  status: 'DRAFT';
}

function rule(partial: Omit<DraftWorkflowRule, 'status'>): DraftWorkflowRule {
  return { ...partial, status: 'DRAFT' };
}

/**
 * The Summarization-palette rule set (structural + invariant classes only — see the SCOPE NOTE
 * above). Consultation-palette rules arrive with; STT with — neither is
 * touched here (out of scope
 */
export const DRAFT_SUMMARIZATION_RULE_SET: readonly DraftWorkflowRule[] = [
  // ---- structural (palette-independent) --------------------------------------------------
  rule({
    ruleId: 'WF-S-001',
    ruleClass: 'structural',
    predicateType: 'ACYCLIC',
    predicateConfig: {},
    severity: 'ERROR',
    paletteKey: null,
    registerRefs: [],
    title: 'The graph is a DAG.',
  }),
  rule({
    ruleId: 'WF-S-002',
    ruleClass: 'structural',
    predicateType: 'SINGLE_ENTRY',
    // CLASS-based since TASK-864: `core.start` and `core.trigger` both carry `entry`, so one
    // palette-agnostic rule admits the legacy marker and the `core` vocabulary's Trigger.
    predicateConfig: { entryClass: 'entry' },
    severity: 'ERROR',
    paletteKey: null,
    registerRefs: [],
    title: 'Exactly one entry node (core.start, or core.trigger).',
  }),
  rule({
    ruleId: 'WF-S-003',
    ruleClass: 'structural',
    predicateType: 'REACHABLE_FROM_ENTRY',
    predicateConfig: { entryClass: 'entry' },
    severity: 'ERROR',
    paletteKey: null,
    registerRefs: [],
    title: 'Every node is reachable from the entry.',
  }),
  rule({
    ruleId: 'WF-S-004',
    ruleClass: 'structural',
    predicateType: 'REACHES_TERMINAL',
    predicateConfig: { terminalClass: 'terminal' },
    severity: 'ERROR',
    paletteKey: null,
    registerRefs: [],
    title: 'Every node reaches a terminal node (core.end, or core.output); no dead ends.',
  }),
  rule({
    ruleId: 'WF-S-005',
    ruleClass: 'structural',
    predicateType: 'BOUND',
    predicateConfig: { maxNodes: 256, maxEdges: 1024, maxDepth: 64 },
    severity: 'ERROR',
    paletteKey: null,
    registerRefs: [],
    title: 'Graph stays within the authoring bounds (MAX_GRAPH_NODES / MAX_GRAPH_EDGES / MAX_GRAPH_DEPTH).',
  }),
  rule({
    ruleId: 'WF-S-006',
    ruleClass: 'structural',
    predicateType: 'FORBIDDEN_NODE_TYPE',
    predicateConfig: { nodeClass: 'signing' },
    severity: 'ERROR',
    paletteKey: null,
    registerRefs: ['INV-159', 'INV-179', 'INV-186'],
    title: 'No node may write a signed state — the substrate has no signing node.',
  }),
  rule({
    ruleId: 'WF-S-007',
    ruleClass: 'structural',
    predicateType: 'REQUIRED_PATH_THROUGH',
    predicateConfig: { fromClass: 'entry', toClass: 'terminal', throughClass: 'mandatory' },
    severity: 'ERROR',
    paletteKey: null,
    registerRefs: ['INV-137', 'INV-155'],
    title: 'Every path to a terminal passes through every mandatory-class node — nothing routes around a gate.',
  }),

  // ---- invariant (Summarization palette) --------------------------------------------------
  rule({
    ruleId: 'WF-I-001',
    ruleClass: 'invariant',
    predicateType: 'REQUIRED_PATH_THROUGH',
    predicateConfig: { fromClass: 'phiBearing', toClass: 'externalEgress', throughClass: 'redaction' },
    severity: 'ERROR',
    paletteKey: 'summarization',
    registerRefs: ['INV-026', 'INV-136'],
    title: 'Every path from a PHI-bearing node to external egress passes through a redaction node.',
  }),
  rule({
    ruleId: 'WF-I-002',
    ruleClass: 'invariant',
    predicateType: 'CONFIG_PREDICATE',
    predicateConfig: { appliesTo: { nodeClass: 'generation' }, field: 'onError', op: 'present' },
    severity: 'ERROR',
    paletteKey: 'summarization',
    registerRefs: ['INV-019', 'INV-126', 'INV-205'],
    title:
      'Every generation node declares onError. DRAFT SIMPLIFICATION: the full invariant also requires a marked-output binding when onError is "degrade" — not encoded here; flagged for the clinical/architecture review to decide whether that needs a dedicated predicate kind.',
  }),
  rule({
    ruleId: 'WF-I-003',
    ruleClass: 'invariant',
    predicateType: 'REQUIRED_NODE_TYPE',
    predicateConfig: { nodeClass: 'draftLabeled', minCount: 1 },
    severity: 'WARNING',
    paletteKey: 'summarization',
    registerRefs: ['INV-030', 'INV-131', 'INV-148', 'INV-182'],
    title:
      'At least one draft/unsigned-labeled node exists. DRAFT SIMPLIFICATION: the full invariant requires EVERY artifact-producing terminal path to end at one — presence-only here, pending a dedicated per-path check.',
  }),
  rule({
    ruleId: 'WF-I-004',
    ruleClass: 'invariant',
    predicateType: 'CONFIG_PREDICATE',
    predicateConfig: { appliesTo: { nodeClass: 'activity' }, field: 'emitsTrajectory', op: 'eq', value: true },
    severity: 'ERROR',
    paletteKey: 'summarization',
    registerRefs: ['INV-054', 'INV-160', 'INV-217'],
    title:
      'Every activity node explicitly declares emitsTrajectory: true. DRAFT STRICTNESS CHOICE: requires an explicit declaration rather than tolerating silent absence — see rule-model.md §Open questions.',
  }),
  rule({
    ruleId: 'WF-I-005',
    ruleClass: 'invariant',
    predicateType: 'REQUIRED_PATH_THROUGH',
    predicateConfig: { fromClass: 'generation', toClass: 'codeBinding', throughClass: 'toolVerification' },
    severity: 'ERROR',
    paletteKey: 'summarization',
    registerRefs: ['INV-065', 'INV-066', 'INV-231'],
    title: 'A generation node’s output may not reach a code-binding node except through a tool-verification node.',
  }),
  rule({
    ruleId: 'WF-I-006',
    ruleClass: 'invariant',
    predicateType: 'FORBIDDEN_PATH',
    predicateConfig: { fromClass: 'phiBearing', toClass: 'styleDna' },
    severity: 'ERROR',
    paletteKey: 'summarization',
    registerRefs: ['INV-017', 'INV-080', 'INV-095', 'INV-165'],
    title: 'No path from a PHI-bearing node to a style/DNA-writing node.',
  }),
  rule({
    ruleId: 'WF-I-007',
    ruleClass: 'invariant',
    predicateType: 'ORDERED_BEFORE',
    predicateConfig: { beforeClass: 'consentGate', afterClass: 'generation' },
    severity: 'ERROR',
    paletteKey: 'summarization',
    registerRefs: ['INV-003', 'INV-004', 'INV-067'],
    title:
      'A consent/authorization gate never appears downstream of retrieval/generation. DRAFT SEMANTIC (see predicates/shape.ts docstring): forbids order INVERSION, does not by itself guarantee the gate is present on every path — pair with a REQUIRED_PATH_THROUGH rule for mandatory presence.',
  }),
  rule({
    ruleId: 'WF-I-008',
    ruleClass: 'invariant',
    predicateType: 'CONFIG_PREDICATE',
    predicateConfig: { appliesTo: { nodeClass: 'externalCommit' }, field: 'idempotencyKeySource', op: 'present' },
    severity: 'ERROR',
    paletteKey: 'summarization',
    registerRefs: ['INV-157', 'INV-158'],
    title: 'Any node with an external-commit class declares an idempotency-key source.',
  }),
  rule({
    ruleId: 'WF-I-009',
    ruleClass: 'invariant',
    predicateType: 'CONFIG_PREDICATE',
    predicateConfig: { appliesTo: { nodeClass: 'cloudProviderRouting' }, field: 'providerSelection', op: 'eq', value: 'fail-closed' },
    severity: 'ERROR',
    paletteKey: 'summarization',
    registerRefs: ['INV-067'],
    title: 'A node routing to a cloud provider resolves provider selection fail-closed; no env fallback is expressible.',
  }),
  // structural (Summarization palette's OWN mandatory subgraph —)
  //
  // These express the palette-specific rule design.md D5 requires: exactly one input, exactly
  // one output, generation and the guardrail gate both present, generation ordered before the
  // gate, and nothing routing generated text to the output around the gate. They are `structural`
  // (graph shape, not the register's clinical invariants) and palette-scoped (`summarization`),
  // so they sit alongside the generic WF-S-* rules above without touching them. See
  // for the full
  // rationale.
  //
  // CORRECTION (superseding this comment's earlier claim that the generic WF-S-002/003/004/007
  // "do not apply to this palette's own node set"): they always DID apply — every one of them
  // carries `paletteKey: null`, and `validate()`'s filter only ever skips a rule whose palette
  // is set and differs. The intent and the mechanism disagreed, and the consequence was that no
  // graph in ANY palette could pass validation, because those four rules are written against
  // literal `core.start`/`core.end` node types that no palette registered. Both types are now in
  // `WORKFLOW_NODE_REGISTRY` as `boundary`-classed markers, so a graph bookended by them
  // satisfies the generic rules AND its own palette's entry/terminal rules at once (the
  // reachability predicates exempt markers — see `predicates/structural.ts`'s `BOUNDARY_CLASS`).
  // `__tests__/palette-canonical-graphs.test.ts` is the gate that keeps it that way.
  rule({
    ruleId: 'WF-SUMM-001',
    ruleClass: 'structural',
    predicateType: 'SINGLE_ENTRY',
    predicateConfig: { entryType: 'input.context_binding' },
    severity: 'ERROR',
    paletteKey: 'summarization',
    registerRefs: [],
    title: 'Exactly one input.context_binding node (N-1).',
  }),
  rule({
    ruleId: 'WF-SUMM-002',
    ruleClass: 'structural',
    predicateType: 'SINGLE_ENTRY',
    predicateConfig: { entryType: 'output.deliver' },
    severity: 'ERROR',
    paletteKey: 'summarization',
    registerRefs: [],
    title: 'Exactly one output.deliver node (N-5).',
  }),
  rule({
    ruleId: 'WF-SUMM-003',
    ruleClass: 'structural',
    predicateType: 'REQUIRED_NODE_TYPE',
    predicateConfig: { nodeType: 'generate.text', minCount: 1 },
    severity: 'ERROR',
    paletteKey: 'summarization',
    registerRefs: [],
    title: 'A generate.text node is present (N-3, mandatory).',
  }),
  rule({
    ruleId: 'WF-SUMM-004',
    ruleClass: 'structural',
    predicateType: 'REQUIRED_NODE_TYPE',
    predicateConfig: { nodeType: 'guardrail.check', minCount: 1 },
    severity: 'ERROR',
    paletteKey: 'summarization',
    registerRefs: [],
    title: 'A guardrail.check node is present (N-4, mandatory and non-removable — absence is structurally identical to "removed").',
  }),
  rule({
    ruleId: 'WF-SUMM-005',
    ruleClass: 'structural',
    predicateType: 'ORDERED_BEFORE',
    predicateConfig: { beforeType: 'generate.text', afterType: 'guardrail.check' },
    severity: 'ERROR',
    paletteKey: 'summarization',
    registerRefs: [],
    title: 'generate.text is never downstream of guardrail.check — order input -> generation -> guardrail -> output is not inverted.',
  }),
  rule({
    ruleId: 'WF-SUMM-006',
    ruleClass: 'structural',
    predicateType: 'REQUIRED_PATH_THROUGH',
    predicateConfig: { fromType: 'generate.text', toType: 'output.deliver', throughType: 'guardrail.check' },
    severity: 'ERROR',
    paletteKey: 'summarization',
    registerRefs: [],
    title: 'Nothing routes generated text to output.deliver without passing through guardrail.check.',
  }),

  rule({
    ruleId: 'WF-I-010',
    ruleClass: 'invariant',
    predicateType: 'CONFIG_PREDICATE',
    predicateConfig: { appliesTo: { nodeClass: 'activity' }, field: 'retry.maximumAttempts', op: 'lte', value: 5 },
    severity: 'ERROR',
    paletteKey: 'summarization',
    registerRefs: ['INV-069', 'INV-074'],
    title:
      'Per-node retry.maximumAttempts stays within the platform cap (tenants tighten, never exceed). DRAFT SIMPLIFICATION: the companion timeoutSeconds ≤ caps.maxNodeSeconds check is a distinct CONFIG_PREDICATE row, not enumerated separately here — flagged for rule-model.md review.',
  }),
] as const;

/**
 * The STT-palette's own mandatory-subgraph rule set. Structural-only.
 * Palette-scoped (`paletteKey: 'stt'`), so these never evaluate against a summarization (or any
 * other) palette's graph — `validate()`'s existing per-rule `paletteKey` filter already routes
 * each graph correctly.
 *
 * See for the full rationale,
 * including why `stt.phiHop` (registered `implemented: false` in `node-registry.ts`/`registry.py`)
 * needs no rule of its own here: an `implemented: false` node type makes `compile()` refuse ANY
 * graph containing it, a stronger gate than a validator rule could express.
 */
export const DRAFT_STT_RULE_SET: readonly DraftWorkflowRule[] = [
  rule({
    ruleId: 'WF-STT-001',
    ruleClass: 'structural',
    predicateType: 'SINGLE_ENTRY',
    predicateConfig: { entryType: 'stt.audioInput' },
    severity: 'ERROR',
    paletteKey: 'stt',
    registerRefs: [],
    title: 'Exactly one stt.audioInput node (N-1, mandatory).',
  }),
  rule({
    ruleId: 'WF-STT-002',
    ruleClass: 'structural',
    predicateType: 'SINGLE_ENTRY',
    predicateConfig: { entryType: 'stt.transcriptOutput' },
    severity: 'ERROR',
    paletteKey: 'stt',
    registerRefs: [],
    title: 'Exactly one stt.transcriptOutput node (N-7, mandatory).',
  }),
  rule({
    ruleId: 'WF-STT-003',
    ruleClass: 'structural',
    predicateType: 'REQUIRED_NODE_TYPE',
    predicateConfig: { nodeType: 'stt.asrEngine', minCount: 1 },
    severity: 'ERROR',
    paletteKey: 'stt',
    registerRefs: [],
    title: 'An stt.asrEngine node is present (N-6, mandatory).',
  }),
  rule({
    ruleId: 'WF-STT-004',
    ruleClass: 'structural',
    predicateType: 'ORDERED_BEFORE',
    predicateConfig: { beforeType: 'stt.audioInput', afterType: 'stt.asrEngine' },
    severity: 'ERROR',
    paletteKey: 'stt',
    registerRefs: [],
    title: 'stt.audioInput is never downstream of stt.asrEngine — order not inverted.',
  }),
  rule({
    ruleId: 'WF-STT-005',
    ruleClass: 'structural',
    predicateType: 'ORDERED_BEFORE',
    predicateConfig: { beforeType: 'stt.asrEngine', afterType: 'stt.transcriptOutput' },
    severity: 'ERROR',
    paletteKey: 'stt',
    registerRefs: [],
    title: 'stt.asrEngine is never downstream of stt.transcriptOutput — transcription happens before delivery.',
  }),
  rule({
    ruleId: 'WF-STT-006',
    ruleClass: 'structural',
    predicateType: 'REQUIRED_PATH_THROUGH',
    predicateConfig: { fromType: 'stt.audioInput', toType: 'stt.transcriptOutput', throughType: 'stt.asrEngine' },
    severity: 'ERROR',
    paletteKey: 'stt',
    registerRefs: [],
    title: 'Nothing routes audio to stt.transcriptOutput without passing through stt.asrEngine.',
  }),
] as const;

/**
 * TASK-864 — the `core` palette's own rule set. Deliberately SMALL: the owner's vocabulary is a
 * control language, and its safety lives in the node contract (typed ports, branch guards, loop
 * bounds, `coreNodeConfigProblems`) rather than in a mandatory-subgraph shape. The two rules
 * here state the graph's boundaries — one Trigger, at least one Output — which the palette-
 * agnostic `WF-S-*` bookends then reason over by class (`entry` / `terminal`).
 */
export const DRAFT_CORE_RULE_SET: readonly DraftWorkflowRule[] = [
  rule({
    ruleId: 'WF-CORE-001',
    ruleClass: 'structural',
    predicateType: 'SINGLE_ENTRY',
    predicateConfig: { entryType: 'core.trigger' },
    severity: 'ERROR',
    paletteKey: 'core',
    registerRefs: [],
    title: 'Exactly one core.trigger node — the graph`s one entry point.',
  }),
  rule({
    ruleId: 'WF-CORE-002',
    ruleClass: 'structural',
    predicateType: 'REQUIRED_NODE_TYPE',
    predicateConfig: { nodeType: 'core.output', minCount: 1 },
    severity: 'ERROR',
    paletteKey: 'core',
    registerRefs: [],
    title: 'At least one core.output node — a run must declare what it returns.',
  }),
  rule({
    ruleId: 'WF-CORE-003',
    ruleClass: 'structural',
    predicateType: 'ORDERED_BEFORE',
    predicateConfig: { beforeType: 'core.trigger', afterType: 'core.output' },
    severity: 'ERROR',
    paletteKey: 'core',
    registerRefs: [],
    title: 'core.output is never upstream of core.trigger — the boundaries are not inverted.',
  }),
] as const;

/**
 * The Consultation-palette rule set (/11 — a partial pass;
 * for the full CR-01..CR-19 statement set and which ones are NOT graph rules — 19 of them are
 * implemented here as `WF-CONS-*` (CR-12 and CR-16 landed after the first partial pass); the rest are enforced elsewhere (registry-level fields,
 * deferred pending a node type that does not exist yet, or deferred pending the impure
 * schema/entitlement-I/O validator layer that no palette has today — same scope boundary the
 * SIX `WF-C-*` rules above already established for Summarization).
 *
 * Node type keys per `contracts/node-types.md`. Mandatory subgraph: consent -> capture -> PHI ->
 * synthesis -> verifier -> HITL gate, signing outside (never a node type in this substrate).
 */
export const DRAFT_CONSULTATION_RULE_SET: readonly DraftWorkflowRule[] = [
  // ---- CR-01: exactly one consent gate, nothing precedes it -------------------------------
  rule({
    ruleId: 'WF-CONS-001',
    ruleClass: 'structural',
    predicateType: 'SINGLE_ENTRY',
    predicateConfig: { entryType: 'consultation.consentGate' },
    severity: 'ERROR',
    paletteKey: 'consultation',
    registerRefs: ['INV-003', 'INV-004', 'INV-201'],
    title: 'Exactly one consultation.consentGate node (CR-01).',
  }),
  rule({
    ruleId: 'WF-CONS-002',
    ruleClass: 'structural',
    predicateType: 'REACHABLE_FROM_ENTRY',
    predicateConfig: { entryType: 'consultation.consentGate' },
    severity: 'ERROR',
    paletteKey: 'consultation',
    registerRefs: ['INV-003', 'INV-004', 'INV-201'],
    title: 'Every node is reachable from consultation.consentGate — no node precedes it (CR-01).',
  }),
  // ---- CR-06: exactly one HITL gate, terminal ---------------------------------------------
  rule({
    ruleId: 'WF-CONS-003',
    ruleClass: 'structural',
    predicateType: 'SINGLE_ENTRY',
    predicateConfig: { entryType: 'consultation.hitlGate' },
    severity: 'ERROR',
    paletteKey: 'consultation',
    registerRefs: ['INV-144', 'INV-146', 'INV-159'],
    title: 'Exactly one consultation.hitlGate node (CR-06).',
  }),
  rule({
    ruleId: 'WF-CONS-004',
    ruleClass: 'structural',
    predicateType: 'REACHES_TERMINAL',
    predicateConfig: { terminalType: 'consultation.hitlGate' },
    severity: 'ERROR',
    paletteKey: 'consultation',
    registerRefs: ['INV-144', 'INV-146', 'INV-159'],
    title: 'Every node reaches consultation.hitlGate — no node executes after it (CR-06).',
  }),
  // ---- CR-17: mandatory-node presence (capture, phiHop, persist) --------------------------
  rule({
    ruleId: 'WF-CONS-005',
    ruleClass: 'structural',
    predicateType: 'REQUIRED_NODE_TYPE',
    predicateConfig: { nodeType: 'consultation.captureBinding', minCount: 1 },
    severity: 'ERROR',
    paletteKey: 'consultation',
    registerRefs: ['INV-019', 'INV-126', 'INV-205'],
    title: 'A consultation.captureBinding node is present (CR-17, mandatory).',
  }),
  rule({
    ruleId: 'WF-CONS-006',
    ruleClass: 'structural',
    predicateType: 'REQUIRED_NODE_TYPE',
    predicateConfig: { nodeType: 'consultation.phiHop', minCount: 1 },
    severity: 'ERROR',
    paletteKey: 'consultation',
    registerRefs: ['INV-019', 'INV-126', 'INV-205'],
    title: 'A consultation.phiHop node is present (CR-17, mandatory).',
  }),
  rule({
    ruleId: 'WF-CONS-007',
    ruleClass: 'structural',
    predicateType: 'REQUIRED_NODE_TYPE',
    predicateConfig: { nodeType: 'consultation.persistDraft', minCount: 1 },
    severity: 'ERROR',
    paletteKey: 'consultation',
    registerRefs: ['INV-019', 'INV-126', 'INV-205'],
    title: 'A consultation.persistDraft node is present (CR-17, mandatory).',
  }),
  // ---- Canonical mandatory subgraph: consent -> {capture, phiHop, synthesize, sensors} -> gate
  rule({
    ruleId: 'WF-CONS-008',
    ruleClass: 'structural',
    predicateType: 'REQUIRED_PATH_THROUGH',
    predicateConfig: {
      fromType: 'consultation.consentGate',
      toType: 'consultation.hitlGate',
      throughType: 'consultation.captureBinding',
    },
    severity: 'ERROR',
    paletteKey: 'consultation',
    registerRefs: ['INV-137', 'INV-155'],
    title: 'Nothing routes from consentGate to hitlGate without passing through captureBinding.',
  }),
  rule({
    ruleId: 'WF-CONS-009',
    ruleClass: 'structural',
    predicateType: 'REQUIRED_PATH_THROUGH',
    predicateConfig: {
      fromType: 'consultation.consentGate',
      toType: 'consultation.hitlGate',
      throughType: 'consultation.phiHop',
    },
    severity: 'ERROR',
    paletteKey: 'consultation',
    registerRefs: ['INV-026', 'INV-136'],
    title:
      'Nothing routes from consentGate to hitlGate without passing through phiHop (CR-15 structural half — the data-driven phiClass/mode check is deferred, see validator-rules.md §3).',
  }),
  rule({
    ruleId: 'WF-CONS-010',
    ruleClass: 'structural',
    predicateType: 'REQUIRED_PATH_THROUGH',
    predicateConfig: {
      fromType: 'consultation.consentGate',
      toType: 'consultation.hitlGate',
      throughType: 'consultation.synthesize',
    },
    severity: 'ERROR',
    paletteKey: 'consultation',
    registerRefs: ['INV-137', 'INV-155'],
    title: 'Nothing routes from consentGate to hitlGate without passing through synthesize.',
  }),
  rule({
    ruleId: 'WF-CONS-011',
    ruleClass: 'structural',
    predicateType: 'REQUIRED_PATH_THROUGH',
    predicateConfig: {
      fromType: 'consultation.consentGate',
      toType: 'consultation.hitlGate',
      throughType: 'consultation.sensors',
    },
    severity: 'ERROR',
    paletteKey: 'consultation',
    registerRefs: ['INV-137', 'INV-155'],
    title: 'Nothing routes from consentGate to hitlGate without passing through sensors (the verifier stage).',
  }),
  // ---- CR-13: a reconciliation node sits between capture and final synthesis --------------
  rule({
    ruleId: 'WF-CONS-012',
    ruleClass: 'structural',
    predicateType: 'REQUIRED_PATH_THROUGH',
    predicateConfig: {
      fromType: 'consultation.captureBinding',
      toType: 'consultation.synthesize',
      throughType: 'consultation.extractEntities',
    },
    severity: 'ERROR',
    paletteKey: 'consultation',
    registerRefs: ['INV-134', 'INV-135', 'INV-137', 'INV-176'],
    title: 'Nothing routes captured content to synthesize without passing through extractEntities (CR-13).',
  }),
  // ---- CR-03: MCP/tool-calling node declares a purpose scope ------------------------------
  rule({
    ruleId: 'WF-CONS-013',
    ruleClass: 'invariant',
    predicateType: 'CONFIG_PREDICATE',
    predicateConfig: { appliesTo: { nodeType: 'consultation.bindTerminology' }, field: 'purposeScope', op: 'present' },
    severity: 'ERROR',
    paletteKey: 'consultation',
    registerRefs: ['INV-007', 'INV-067', 'INV-232'],
    title: 'consultation.bindTerminology declares a purposeScope (CR-03).',
  }),
  // ---- CR-07: content-writing node declares occ:true --------------------------------------
  rule({
    ruleId: 'WF-CONS-014',
    ruleClass: 'invariant',
    predicateType: 'CONFIG_PREDICATE',
    predicateConfig: { appliesTo: { nodeType: 'consultation.persistDraft' }, field: 'occ', op: 'eq', value: true },
    severity: 'ERROR',
    paletteKey: 'consultation',
    registerRefs: ['INV-029', 'INV-052', 'INV-085', 'INV-092', 'INV-133', 'INV-152', 'INV-219', 'INV-237'],
    title: 'consultation.persistDraft declares occ: true (CR-07, the authorship protection made structural).',
  }),
  // ---- CR-18: only bindTerminology may produce a code -------------------------------------
  rule({
    ruleId: 'WF-CONS-015',
    ruleClass: 'invariant',
    predicateType: 'CONFIG_PREDICATE',
    predicateConfig: { appliesTo: { nodeType: 'consultation.synthesize' }, field: 'producesCode', op: 'eq', value: false },
    severity: 'ERROR',
    paletteKey: 'consultation',
    registerRefs: ['INV-065', 'INV-066', 'INV-231', 'INV-089'],
    title:
      'consultation.synthesize explicitly declares producesCode: false (CR-18). DRAFT STRICTNESS CHOICE, mirrors WF-I-004: requires the negative to be STATED, not merely absent.',
  }),
  // ---- CR-19: the coverage gap is made visible --------------------------------------------
  rule({
    ruleId: 'WF-CONS-016',
    ruleClass: 'invariant',
    predicateType: 'CONFIG_PREDICATE',
    predicateConfig: { appliesTo: { nodeType: 'consultation.bindTerminology' }, field: 'unmappedOutputKey', op: 'present' },
    severity: 'ERROR',
    paletteKey: 'consultation',
    registerRefs: ['INV-063', 'INV-233', 'INV-071'],
    title: 'consultation.bindTerminology declares an unmappedOutputKey (CR-19 — unmapped terms surfaced, never silent).',
  }),
  // ---- CR-12: a transcript-consuming node reads FINALIZED transcript only -----------------
  //
  // `requiresFinalized` is required to be STATED true (same strictness choice as WF-CONS-015 /
  // WF-I-004): "absent" and "false" are the same silent partial-transcript read, and P-16's
  // `isFinal` gating is exactly the property that must not be lost when authorship moves from
  // `HarnessDocWorkflow` to a tenant-authored graph.
  rule({
    ruleId: 'WF-CONS-017',
    ruleClass: 'invariant',
    predicateType: 'CONFIG_PREDICATE',
    predicateConfig: { appliesTo: { nodeType: 'consultation.extractEntities' }, field: 'requiresFinalized', op: 'eq', value: true },
    severity: 'ERROR',
    paletteKey: 'consultation',
    registerRefs: ['INV-023', 'INV-027', 'INV-137', 'INV-208', 'INV-210'],
    title: 'consultation.extractEntities declares requiresFinalized: true (CR-12).',
  }),
  rule({
    ruleId: 'WF-CONS-018',
    ruleClass: 'invariant',
    predicateType: 'CONFIG_PREDICATE',
    predicateConfig: { appliesTo: { nodeType: 'consultation.assemblePrompt' }, field: 'requiresFinalized', op: 'eq', value: true },
    severity: 'ERROR',
    paletteKey: 'consultation',
    registerRefs: ['INV-023', 'INV-027', 'INV-137', 'INV-208', 'INV-210'],
    title: 'consultation.assemblePrompt declares requiresFinalized: true (CR-12).',
  }),
  // ---- CR-16: no stage-level abort — force-stop applies to the timed-out node only --------
  //
  // The `op: 'in'` template `validator-rules.md` named, applied to every ACTIVITY-classed
  // node in the palette (the two gates are not activities and degrade differently by design —
  // they are the only `critical: true` nodes, CR-14). `'abort'` is excluded by omission, and
  // the value must be stated: an undeclared error policy is how a stage-wide abort gets in
  // without anyone authoring one.
  rule({
    ruleId: 'WF-CONS-019',
    ruleClass: 'invariant',
    predicateType: 'CONFIG_PREDICATE',
    predicateConfig: { appliesTo: { nodeClass: 'activity' }, field: 'onError', op: 'in', value: ['degrade', 'retry', 'fail'] },
    severity: 'ERROR',
    paletteKey: 'consultation',
    registerRefs: ['INV-074', 'INV-075', 'INV-125'],
    title: 'Every consultation activity node declares a non-abort onError policy (CR-16 — no stage-level abort).',
  }),
] as const;
