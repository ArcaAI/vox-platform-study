import { WorkflowDefinitionEntity } from '@arcaai/domains';
import { GetWorkflowRunResult } from '../consultation/harness/harness-gateway.service';
import { WorkflowInvokeResponse, WorkflowRunCancelResponse, WorkflowRunStatusResponse, WorkflowSummaryResponse } from './dto';

/** Static mapper — entity/upstream-payload -> response DTO, never the reverse (rule 04). */
export class WorkflowExposureDtoMapper {
  static toSummaryResponse(entity: WorkflowDefinitionEntity): WorkflowSummaryResponse {
    return {
      slug: entity.slug,
      name: entity.name,
      description: entity.description,
      paletteKey: entity.paletteKey,
      versionNumber: entity.versionNumber,
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
