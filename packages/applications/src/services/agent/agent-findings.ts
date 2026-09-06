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
  | 'PROMPT_TEMPLATE_SYNTAX'
  | 'PROMPT_VARIABLE_UNDECLARED'
  | 'CONTEXT_SCHEMA_NOT_FOUND'
  | 'CONTEXT_SCHEMA_VERSION_NOT_FOUND';

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
