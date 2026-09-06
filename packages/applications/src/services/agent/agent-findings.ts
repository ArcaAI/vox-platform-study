import { GENERATION_HYPERPARAMETERS, type AgentConfigProblem } from '@arcaai/workflow-contract';

const GENERATION_PARAMS: ReadonlySet<string> = new Set<string>(GENERATION_HYPERPARAMETERS);

/** Machine-readable reason codes an agent validation/publish reports (`validationReport.findings[].code`). */
export type AgentFindingCode =
  | 'CONFIG'
  | 'SCHEMA'
  | 'MODEL_NOT_FOUND'
  | 'MODEL_TASK_MISMATCH'
  | 'MODEL_DISABLED'
  | 'MODEL_UNAVAILABLE'
  | 'TEMPLATE_NOT_FOUND'
  | 'TEMPLATE_NOT_APPROVED'
  | 'TEMPLATE_VERSION_NOT_FOUND'
  | 'CAPABILITY'
  // TASK-890 §3.5 — the codes an agent shares with the workflow publish gate
  // (`WORKFLOW_PUBLISH_FINDING_CODES`). ONE vocabulary across both surfaces, so a console renders
  // the same fix for the same problem whether it was found on a graph node or on an agent.
  //
  // The sharing is a SUBSET, and deliberately so (wave-2b close): these four are facts about a
  // TEMPLATE or a CONTEXT SCHEMA, which both gates can see. The model family above
  // (`MODEL_NOT_FOUND` / `MODEL_TASK_MISMATCH` / `MODEL_DISABLED` / `MODEL_UNAVAILABLE` /
  // `MODEL_NOT_READY` / `CAPABILITY` / `TEMPLATE_*`) stays agent-only because the workflow gate
  // is a PURE function in a package with no database: it resolves no model row and no readiness
  // snapshot, so it could never emit one. Adding them to the workflow list would declare a
  // vocabulary nothing in that gate can produce.
  | 'PROMPT_TEMPLATE_SYNTAX'
  | 'PROMPT_VARIABLE_UNDECLARED'
  | 'CONTEXT_SCHEMA_NOT_FOUND'
  | 'CONTEXT_SCHEMA_VERSION_NOT_FOUND'
  // TASK-890 §3.12 — ADVISORY. The last readiness observation says the thing that would serve
  // this model was not answering (`engine_down`) or does not have the artifact
  // (`weights_missing`). It is a WARNING and never blocks: an engine that is down while an
  // author publishes may be up when the graph runs, and the RUN-time 503 is the real gate.
  // `MODEL_UNAVAILABLE` (the `usable` axis) stays the ERROR.
  | 'MODEL_NOT_READY'
  // TASK-890 §3.14 (OD-R) — the agent's own guardrail opt-out (`parameters.guards.enabled:
  // false`), recorded as a WARNING so the omission is visible on the row that made it rather
  // than merely permitted. Shares the name with the graph-side finding `publishFindings` emits
  // on a `core.agent` node.
  | 'GUARDRAIL_OPTED_OUT';

export interface AgentFinding extends AgentConfigProblem {
  readonly code: AgentFindingCode;
}

export interface AgentValidationReport {
  checkedAt: string;
  blocking: boolean;
  findings: AgentFinding[];
}

/** `agentConfigProblems` reports paths; the code is derived from WHICH check fired. */
export function codeForConfigProblem(problem: AgentConfigProblem): AgentFindingCode {
  if (problem.path === 'modelId' || problem.path.startsWith('fallbacks[')) return 'MODEL_TASK_MISMATCH';
  if (problem.path === 'parameters.ssml') return 'CAPABILITY';
  if (problem.path.startsWith('parameters.generation.') && GENERATION_PARAMS.has(problem.path.slice('parameters.generation.'.length)))
    return 'CAPABILITY';
  return 'CONFIG';
}

export function hasBlocking(findings: readonly AgentFinding[]): boolean {
  return findings.some((finding) => finding.severity === 'ERROR');
}
