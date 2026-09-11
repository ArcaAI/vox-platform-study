import { WorkflowRunEntity } from '@arcaai/domains';
import { WorkflowRunResponse } from './dto';

/**
 * TASK-950 — read `actingUserId` out of the row's `_metadata`.
 *
 * `_metadata` is a BAG the write contract stores verbatim (`RecordRunStartedInput.metaData`), so
 * nothing guarantees its shape: the key may be absent, or hold a value some other caller put
 * there. Narrowing to `string` is therefore the read rule, not a formality — anything else is
 * `null`, which is the same answer the three legitimate absences give (a human caller, a
 * consultation-bound run, a trigger schema that declares no identity field).
 *
 * This is the ONE place the extraction happens. `WorkflowExposureDtoMapper.toStatusResponse`
 * takes the already-extracted id, so the two response surfaces cannot disagree about what counts
 * as a valid value.
 */
function readActingUserId(metaData: Record<string, unknown> | null | undefined): string | null {
  const value = metaData?.actingUserId;
  return typeof value === 'string' ? value : null;
}

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
    dto.actingUserId = readActingUserId(entity.metaData);
    dto.createdAt = entity.createdAt.toISOString();
    return dto;
  }
}
