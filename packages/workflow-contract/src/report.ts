/**
 * The machine-readable validator output design.md requires: "Output: per-node
 * machine-readable `ValidationReport`, persisted with the version." This EXTENDS the house
 * `problems: string[]` idiom (see `packages/json-schema-subset`) rather than replacing it —
 * `message` is exactly the string those functions already produce, wrapped with
 * `nodeId`/`ruleId`/`severity`/`path` so the Studio can map a finding back onto a
 * canvas node.
 */

export type WorkflowFindingSeverity = 'ERROR' | 'WARNING';
export type WorkflowRuleClass = 'structural' | 'invariant' | 'schema';

export interface WorkflowFinding {
  /** e.g. 'WF-S-001' | 'WF-I-006' | 'WF-C-004' | 'WF-INTERNAL' (see — never "ok" on a throw). */
  ruleId: string;
  ruleClass: WorkflowRuleClass;
  severity: WorkflowFindingSeverity;
  /** null = a graph-level finding, not attributable to one node. */
  nodeId: string | null;
  edgeId?: string;
  /** JSON pointer into the node's config, when the finding is about a config field. */
  path?: string;
  /** The house `problems` string, verbatim. */
  message: string;
  /**
   * TASK-890 §3.5 — the machine-readable reason, from the vocabulary `publish-findings.ts`
   * declares (and shares with `AgentFindingCode` in the applications layer). Optional because
   * the rule catalogue's own findings identify themselves by `ruleId`; a publish finding needs a
   * SECOND axis, because ten different rule ids all mean "this node's config is wrong" and a
   * console that wants to offer the right fix cannot get that from a message string.
   */
  code?: string;
  /** INV-xxx ids from `01-invariant-register.md`, when the rule cites the register. */
  registerRefs?: readonly string[];
}

export interface WorkflowValidationReport {
  reportVersion: 1;
  /** No ERROR-severity findings. WARNING findings do not block publish. */
  ok: boolean;
  findings: WorkflowFinding[];
  ruleSetVersion: number;
  registryChecksum: string;
  evaluatedAt: string;
}

/** `true` iff any finding is ERROR-severity — the sole publish-blocking predicate. */
export function hasBlockingFindings(findings: readonly WorkflowFinding[]): boolean {
  return findings.some((finding) => finding.severity === 'ERROR');
}

/** Builds a report from a finding list; `ok` is derived, never set independently (see above). */
export function buildValidationReport(
  findings: readonly WorkflowFinding[],
  meta: { ruleSetVersion: number; registryChecksum: string; evaluatedAt?: string },
): WorkflowValidationReport {
  return {
    reportVersion: 1,
    ok: !hasBlockingFindings(findings),
    findings: [...findings],
    ruleSetVersion: meta.ruleSetVersion,
    registryChecksum: meta.registryChecksum,
    evaluatedAt: meta.evaluatedAt ?? new Date().toISOString(),
  };
}

/**
 * The synthetic finding an orchestrator MUST emit when an evaluator throws unexpectedly
 * ("the orchestrator catches and converts an unexpected throw into a synthetic ERROR
 * finding, never into 'ok'"). Exported so both the pure `validate()` orchestrator and the
 * impure service produce byte-identical shapes for this case.
 */
export function internalErrorFinding(ruleId: string, ruleClass: WorkflowRuleClass, error: unknown): WorkflowFinding {
  const message = error instanceof Error ? error.message : String(error);
  return {
    ruleId: 'WF-INTERNAL',
    ruleClass,
    severity: 'ERROR',
    nodeId: null,
    message: `rule ${ruleId} failed to evaluate: ${message}`,
  };
}
