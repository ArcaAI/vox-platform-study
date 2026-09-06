import { WorkflowDefinitionEntity } from '@arcaai/domains';
import { declaredIoSchemas, declaredOutputProtocols, declaredTriggerKinds } from '@arcaai/workflow-contract';
import { GetWorkflowRunResult } from '../consultation/harness/harness-gateway.service';
import { WorkflowInvokeResponse, WorkflowRunCancelResponse, WorkflowRunStatusResponse, WorkflowSummaryResponse } from './dto';
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
   */
  static toStatusResponse(
    slug: string,
    workflowVersionNumber: number,
    upstream: GetWorkflowRunResult,
    resultRef: Record<string, unknown> | null = null,
  ): WorkflowRunStatusResponse {
    return {
      runId: upstream.runId,
      slug,
      workflowVersionNumber,
      status: upstream.status,
      stages: upstream.stages,
      startedAt: upstream.startedAt,
      endedAt: upstream.endedAt,
      resultRef,
    };
  }

  static toCancelResponse(runId: string, status: string): WorkflowRunCancelResponse {
    return { runId, status };
  }
}
