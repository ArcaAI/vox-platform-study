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
  // TASK-893: the six `WF-SUMM-*` rules (the summarization palette's own mandatory subgraph)
  // were deleted with that palette's node types; `DRAFT_CORE_RULE_SET` states the `core`
  // boundaries, and the palette-agnostic `WF-S-*` rows reason over them by class.

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

/*
 * `DRAFT_STT_RULE_SET` (`WF-STT-001..006`) lived here until TASK-867 (the TASK-861 step-10
 * follow-up): the `stt` palette is retired — every `stt.*` descriptor is `implemented: false`
 * (`node-registry.ts`), so `compile()` refuses any graph the six palette-scoped rules could
 * have evaluated. Rules that can never fire were deleted with their golden fixtures rather than
 * kept as inert rows; the descriptors themselves stay for the deprecation window.
 */

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

/*
 * `DRAFT_CONSULTATION_RULE_SET` (`WF-CONS-001..019`) lived here until TASK-893: the `consultation`
 * palette's node types are retired, and a rule scoped to a palette that no longer exists can never
 * fire. The clinical steps it governed survive as ACTIONS behind `core.action`
 * (`action-catalogue.ts`), whose `mandatory` / `redaction` / `activity` classes `classesOf()`
 * resolves per instance — so class-based rules still see them.
 */

/**
 * TASK-1036 — the DATA-CONTRACT rules: bindings (§9.2), the consultation scope (§9.3) and the
 * workflow settings (§3.5).
 *
 * Unlike the DRAFT rule sets above these are not graph-shape predicates evaluated by
 * `validate()`; they are publish checks (`publishFindings` → `bindings.ts` /
 * `workflow-settings.ts`). They are catalogued here so a console, the docs and a reviewer read one
 * table: the code a finding carries, its rule id, how loud it is, what it means and how to fix it.
 *
 * `severity` is the severity under the NEW model (declared `inputs`, declared `settings`).
 * `legacySeverity` is what the same rule reports on a graph still on the legacy model (edges for
 * data, trigger `kinds` / output `protocols` for settings) during the one-release migration, so
 * nothing that published before TASK-1036 stops publishing.
 */
export interface DataContractRule {
  /** `WF-PUB` for a publish finding; the four settings implications carry their own `WF-SET-00n`. */
  readonly ruleId: string;
  readonly code: string;
  readonly severity: 'ERROR' | 'WARNING' | 'INFO';
  readonly legacySeverity?: 'WARNING';
  readonly title: string;
  readonly fix: string;
}

export const DATA_CONTRACT_RULES: readonly DataContractRule[] = Object.freeze([
  {
    ruleId: 'WF-PUB',
    code: 'BINDING_UNKNOWN_PATH',
    severity: 'ERROR',
    title: 'An input reads a path that does not exist: no such root, step, output field, variable or schema field.',
    fix: 'Pick the field from the list; it offers only what this step can read.',
  },
  {
    ruleId: 'WF-PUB',
    code: 'BINDING_NOT_ANCESTOR',
    severity: 'ERROR',
    title: 'An input reads the output of a step that does not run before this one.',
    fix: 'Connect that step upstream of this one, or read another field.',
  },
  {
    ruleId: 'WF-PUB',
    code: 'BINDING_TYPE_MISMATCH',
    severity: 'ERROR',
    title: 'An input receives a value of a type it cannot use (for example audio where text is needed).',
    fix: 'Choose a field of a matching type, or add a step that produces one.',
  },
  {
    ruleId: 'WF-PUB',
    code: 'BINDING_TYPE_CONVERTED',
    severity: 'INFO',
    title: 'An input receives a value that will be formatted to fit (for example a number or a list as text).',
    fix: 'Nothing to do unless the formatted value is not what the step should see.',
  },
  {
    ruleId: 'WF-PUB',
    code: 'BINDING_UNKNOWN_INPUT',
    severity: 'ERROR',
    title: 'A binding names an input this step does not declare.',
    fix: 'Remove the binding, or bind one of the inputs the step lists.',
  },
  {
    ruleId: 'WF-PUB',
    code: 'REQUIRED_INPUT_UNBOUND',
    severity: 'ERROR',
    title: 'A required input of this step has no value: no binding and no connection.',
    fix: 'Choose where the input comes from, or connect a step that produces it.',
  },
  {
    ruleId: 'WF-PUB',
    code: 'INPUT_MULTIPLE_PRODUCERS',
    severity: 'ERROR',
    legacySeverity: 'WARNING',
    title: 'Several steps feed one single-value input, so only one value can arrive (OD-18).',
    fix: 'Bind the input to one of them, or combine the values with a Merge step.',
  },
  {
    ruleId: 'WF-PUB',
    code: 'CONSULTATION_SCOPE_UNAVAILABLE',
    severity: 'ERROR',
    title: 'A step reads consultation data, but the workflow is not started by a consultation.',
    fix: 'Add the consultation source in the workflow settings, or read the value from the context.',
  },
  {
    ruleId: 'WF-PUB',
    code: 'SETTINGS_INVALID',
    severity: 'ERROR',
    title: 'The workflow settings are malformed (an unknown connection or source, a repeat, an unknown key).',
    fix: 'Re-open the workflow settings and save them again.',
  },
  {
    ruleId: 'WF-SET-001',
    code: 'SETTINGS_SSE_REQUIRES_API',
    severity: 'ERROR',
    legacySeverity: 'WARNING',
    title: 'Streaming a run (SSE) is enabled without the API connection it follows.',
    fix: 'Enable the API connection.',
  },
  {
    ruleId: 'WF-SET-002',
    code: 'SETTINGS_SOCKET_REQUIRES_API',
    severity: 'ERROR',
    legacySeverity: 'WARNING',
    title: 'The socket connection is enabled without the API connection it attaches to.',
    fix: 'Enable the API connection.',
  },
  {
    ruleId: 'WF-SET-003',
    code: 'SETTINGS_LIVE_AUDIO_REQUIRES_SOCKET',
    severity: 'ERROR',
    legacySeverity: 'WARNING',
    title: 'A speech step (speech-to-text or text-to-speech) or a streamed audio input needs the socket connection.',
    fix: 'Enable the socket connection.',
  },
  {
    ruleId: 'WF-SET-004',
    code: 'SETTINGS_UPLOAD_REQUIRES_API',
    severity: 'ERROR',
    legacySeverity: 'WARNING',
    title: 'An uploaded audio file or an attachment in the Input shape needs the API connection.',
    fix: 'Enable the API connection.',
  },
] satisfies DataContractRule[]);
