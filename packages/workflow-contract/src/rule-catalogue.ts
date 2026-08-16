/**
 * ============================================================================================
 * DRAFT — NOT CLINICALLY REVIEWED. DO NOT PRESENT AS A VALIDATED SAFETY BOUNDARY.
 * ============================================================================================
 *
 * These rule INSTANCES were authored by this ticket's engineering pass from the
 * `01-invariant-register.md` assessment, exactly as TASK-716 §6 Risk #1 anticipates: "The 22
 * initial rules were derived from the register by this ticket's author, not by a clinician.
 * They need clinical review before Phase C, and the review's outcome may add, remove or
 * re-scope rules." That review has NOT happened in this session. See
 * `docs/implementation/TASK-716-Workflow-Compiler-Validator/contracts/rule-model.md` for the
 * full DRAFT status statement, the register cross-references, and the reviewer sign-off box.
 *
 * This export exists so the golden test suite (`__tests__/golden.test.ts`) has something
 * concrete to run against and so a future `WorkflowInvariantRule` seed (TASK-716 Task 11, not
 * built here) has a starting point — it does NOT wire these rules as a publish-blocking gate
 * anywhere. No application service in this repo imports this module. Wiring `validate()`
 * behind a real publish path is TASK-716 Task 8, gated in this session on TASK-715's node
 * registry (Phases B–F) not existing yet — see the ticket README §7.
 *
 * SCOPE NOTE — 17 of the ticket's ~22-23 catalogued rules, not all of them: the six
 * `schema`-class rules (`WF-C-001..006`) each need either the code-owned node registry
 * (`WORKFLOW_NODE_REGISTRY`, TASK-715 Phases B–F, not built) or repository/entitlement I/O
 * (`WF-C-004`, `WF-C-006` — deliberately impure per TASK-716 §3.2) and so are NOT included
 * here; they are implemented directly by the impure `WorkflowValidatorService` (Task 8) once
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
 * above). Consultation-palette rules arrive with TASK-731; STT with TASK-724 — neither is
 * touched here (out of scope per the ticket README §1).
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
    predicateConfig: { entryType: 'core.start' },
    severity: 'ERROR',
    paletteKey: null,
    registerRefs: [],
    title: 'Exactly one core.start node.',
  }),
  rule({
    ruleId: 'WF-S-003',
    ruleClass: 'structural',
    predicateType: 'REACHABLE_FROM_ENTRY',
    predicateConfig: { entryType: 'core.start' },
    severity: 'ERROR',
    paletteKey: null,
    registerRefs: [],
    title: 'Every node is reachable from the entry.',
  }),
  rule({
    ruleId: 'WF-S-004',
    ruleClass: 'structural',
    predicateType: 'REACHES_TERMINAL',
    predicateConfig: { terminalType: 'core.end' },
    severity: 'ERROR',
    paletteKey: null,
    registerRefs: [],
    title: 'Every node reaches a core.end; no dead ends.',
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
    predicateConfig: { fromType: 'core.start', toType: 'core.end', throughClass: 'mandatory' },
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
