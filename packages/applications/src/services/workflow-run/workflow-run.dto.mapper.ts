import { WorkflowRunEntity } from '@arcaai/domains';
import { WorkflowRunResponse } from './dto';

export class WorkflowRunDtoMapper {
  static toResponse(entity: WorkflowRunEntity): WorkflowRunResponse {
    const dto = new WorkflowRunResponse();
    dto.id = entity.id;
    dto.tenantId = entity.tenantId;
    dto.workflowVersionId = entity.workflowVersionId;
    dto.workflowSlug = entity.workflowSlug;
    dto.workflowVersionNumber = entity.workflowVersionNumber;
    dto.definitionName = entity.definitionName;
    dto.sessionId = entity.sessionId;
    dto.runId = entity.runId;
    dto.trigger = entity.trigger;
    dto.status = String(entity.status);
    dto.isSandbox = entity.isSandbox;
    dto.startedAt = entity.startedAt.toISOString();
    dto.endedAt = entity.endedAt ? entity.endedAt.toISOString() : null;
    dto.durationMs = entity.durationMs ?? null;
    dto.nodeCount = entity.nodeCount ?? null;
    dto.failedNodeCount = entity.failedNodeCount;
    dto.degradedNodeCount = entity.degradedNodeCount;
    dto.firstErrorCode = entity.firstErrorCode ?? null;
    dto.resultRef = (entity.resultRef as Record<string, unknown> | null) ?? null;
    dto.createdAt = entity.createdAt.toISOString();
    return dto;
  }
}
