import { GetWorkflowRunResult } from '../consultation/harness/harness-gateway.service';
import { SandboxRunCancelResponse, SandboxRunResponse, SandboxRunStatusResponse } from './dto';

/** Static mapper — upstream-payload -> response DTO, never the reverse (rule 04). */
export class WorkflowSandboxRunDtoMapper {
  static toStartResponse(runId: string, definitionId: string, status: 'started' | 'already_running'): SandboxRunResponse {
    return {
      runId,
      status,
      statusUrl: `/api/v1/admin/workflow-definitions/${definitionId}/sandbox-runs/${runId}`,
      streamUrl: `/api/v1/admin/workflow-definitions/${definitionId}/sandbox-runs/${runId}/stream`,
    };
  }

  static toStatusResponse(definitionId: string, upstream: GetWorkflowRunResult): SandboxRunStatusResponse {
    return {
      runId: upstream.runId,
      workflowDefinitionId: definitionId,
      status: upstream.status,
      stages: upstream.stages,
      startedAt: upstream.startedAt,
      endedAt: upstream.endedAt,
    };
  }

  static toCancelResponse(runId: string, status: string): SandboxRunCancelResponse {
    return { runId, status };
  }
}
