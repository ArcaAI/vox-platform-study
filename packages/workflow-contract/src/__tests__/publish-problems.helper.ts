/**
 * TASK-890 §3.5 — the `string[]` shape the suites that predate `publishFindings` assert against.
 *
 * `workflowPublishProblems` was deleted (it was a gate nothing called, BLOCKER 1c) and its checks
 * moved into `publishFindings`, which returns `WorkflowFinding[]`. The EXPECTATIONS in those
 * suites — "this graph publishes clean", "this one names `guard.groundedness`" — are still
 * exactly right, so they are repointed through this adapter rather than rewritten: a rewrite
 * would have quietly changed what they assert at the same moment as what they call.
 *
 * ERROR severity only, deliberately. The old function returned publish-BLOCKING problems, and
 * `publishFindings` also emits WARNINGs (`GUARDRAIL_OPTED_OUT`, and `PROMPT_VARIABLE_UNDECLARED`
 * during the OD-C ramp) which never blocked anything and must not turn an `[]` assertion red.
 */
import { jsonSchemaValueProblems } from '@arcaai/json-schema-subset';
import type { WorkflowGraph } from '../graph-model';
import type { WorkflowNodeDescriptor } from '../node-registry';
import { publishFindings } from '../publish-findings';

export function publishProblems(graph: WorkflowGraph, options?: { registry?: Readonly<Record<string, WorkflowNodeDescriptor>> }): string[] {
  return publishFindings(graph, {
    registry: options?.registry,
    schemaValueProblems: jsonSchemaValueProblems,
    templateReferenceSeverity: 'WARNING',
  })
    .filter((finding) => finding.severity === 'ERROR')
    .map((finding) => finding.message);
}
