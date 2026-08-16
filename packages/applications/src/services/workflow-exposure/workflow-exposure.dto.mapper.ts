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

  static toStatusResponse(slug: string, workflowVersionNumber: number, upstream: GetWorkflowRunResult): WorkflowRunStatusResponse {
    return {
      runId: upstream.runId,
      slug,
      workflowVersionNumber,
      status: upstream.status,
      stages: upstream.stages,
      startedAt: upstream.startedAt,
      endedAt: upstream.endedAt,
    };
  }

  static toCancelResponse(runId: string, status: string): WorkflowRunCancelResponse {
    return { runId, status };
  }
}
