import { WorkflowDefinitionEntity } from '@arcaai/domains';
import { declaredIoSchemas, declaredOutputProtocols, declaredTriggerKinds } from '@arcaai/workflow-contract';
import { GetWorkflowRunResult } from '../consultation/harness/harness-gateway.service';
import { WorkflowInvokeResponse, WorkflowRunCancelResponse, WorkflowRunStatusResponse, WorkflowSummaryResponse } from './dto';
import { terminalStatusOf } from '../workflow-run/run-status';
import { graphOf, inputSchemaOf } from './workflow-schema-description';

/** Static mapper — entity/upstream-payload -> response DTO, never the reverse (rule 04). */
export class WorkflowExposureDtoMapper {
  /**
   * TASK-890 §3.9 — the summary carries the definition's I/O contract, derived from the SAME
   * readers `describeWorkflow` uses (`inputSchemaOf` included, so a reference-bound trigger's
   * frozen payload schema reaches the catalogue too — black-box J4-F4), so `GET /workflows` and
   * `GET /workflows/{slug}/schema` cannot disagree about what a definition accepts and returns.
   */
  static toSummaryResponse(entity: WorkflowDefinitionEntity): WorkflowSummaryResponse {
    const graph = graphOf(entity.graph);
    const { output } = declaredIoSchemas(graph);
    return {
      slug: entity.slug,
      name: entity.name,
      description: entity.description,
      paletteKey: entity.paletteKey,
      versionNumber: entity.versionNumber,
      inputSchema: inputSchemaOf(graph, entity.compiledConfig),
      outputSchema: (output as Record<string, unknown> | null) ?? null,
      protocols: declaredOutputProtocols(graph),
      triggerKinds: declaredTriggerKinds(graph),
    };
  }

  static toInvokeResponse(runId: string, slug: string, status: 'started' | 'already_running'): WorkflowInvokeResponse {
    return {
      runId,
      status,
      statusUrl: `/api/v1/workflows/${slug}/runs/${runId}`,
      streamUrl: `/api/v1/workflows/${slug}/runs/${runId}/stream`,
    };
  }

  /**
   * `resultRef` comes from the durable run READ MODEL, never from `upstream`: Temporal state
   *  carries per-node status only, which is precisely why the delivered output needed a column
   * .
   *
   * TASK-950 — `actingUserId` has the same provenance and for the same reason: it is a fact about
   * who the run acts FOR, recorded on the row's `_metadata` at `recordRunStarted`, and Temporal
   * never sees it. It arrives here ALREADY extracted and narrowed (`WorkflowRunResponse.actingUserId`,
   * produced by `WorkflowRunDtoMapper`) rather than as a raw `_metadata` bag, so there is exactly
   * one rule in the codebase for what counts as a valid value.
   *
   * Both default to `null`, which is also the honest answer for every caller that has no run row
   * to read from.
   *
   * TASK-982 (E6) — `status` is the caller's ALREADY-FOLDED value (`terminalStatusOf(upstream.status)
   * ?? 'RUNNING'`, computed once in `WorkflowExposureService.getRunStatus`), never `upstream.status`
   * verbatim: the raw interpreter vocabulary (SUCCEEDED/DEGRADED/CANCELLED/…) must never reach a
   * caller, on this surface or the persisted one. The four node counts share `resultRef`'s
   * provenance — the durable run read model, not Temporal — and `degraded` is DERIVED from them:
   * a per-run FLAG, never a run STATE (README pitfall 6).
   */
  static toStatusResponse(
    slug: string,
    workflowVersionNumber: number,
    upstream: GetWorkflowRunResult,
    resultRef: Record<string, unknown> | null = null,
    actingUserId: string | null = null,
    status: string = terminalStatusOf(upstream.status) ?? 'RUNNING',
    nodeCount: number | null = null,
    failedNodeCount: number | null = null,
    degradedNodeCount: number | null = null,
    skippedNodeCount: number | null = null,
  ): WorkflowRunStatusResponse {
    return {
      runId: upstream.runId,
      slug,
      workflowVersionNumber,
      status,
      stages: upstream.stages,
      startedAt: upstream.startedAt,
      endedAt: upstream.endedAt,
      resultRef,
      actingUserId,
      nodeCount,
      failedNodeCount,
      degradedNodeCount,
      skippedNodeCount,
      // A SKIPPED node is a hand-off or an untaken branch, never a warning — only DEGRADED nodes count.
      degraded: status === 'COMPLETED' && (degradedNodeCount ?? 0) > 0,
    };
  }

  static toCancelResponse(runId: string, status: string): WorkflowRunCancelResponse {
    return { runId, status };
  }
}
