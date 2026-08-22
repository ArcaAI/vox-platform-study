import { WorkflowInvariantRuleEntity } from '@arcaai/domains';
import { FetchResponse } from '../../common';
import { PaginatedWorkflowInvariantRuleResponse, WorkflowInvariantRuleResponse } from './dto';
import { SYSTEM_TENANT_ID } from './system-tenant';

/** Static mapper — entity -> response DTO, never the reverse (rule 04). */
export class WorkflowInvariantRuleDtoMapper {
  static toResponse(entity: WorkflowInvariantRuleEntity): WorkflowInvariantRuleResponse {
    const dto = new WorkflowInvariantRuleResponse();
    dto.id = entity.id;
    dto.tenantId = entity.tenantId;
    // Surfaced so a console can render the platform register read-only WITHOUT re-deriving the
    // ownership rule client-side — the server owns that judgement (it is the same predicate the
    // write gate uses).
    dto.isSystemOwned = entity.tenantId === SYSTEM_TENANT_ID;
    dto.ruleId = entity.ruleId;
    dto.registerRefs = [...(entity.registerRefs ?? [])];
    dto.title = entity.title;
    dto.rationale = entity.rationale ?? null;
    dto.predicateType = String(entity.predicateType);
    dto.predicateConfig = (entity.predicateConfig as Record<string, unknown>) ?? {};
    dto.paletteKey = entity.paletteKey ?? null;
    dto.severity = String(entity.severity);
    dto.ruleVersion = entity.ruleVersion;
    dto.effectiveFrom = entity.effectiveFrom.toISOString();
    dto.resourceStatus = String(entity.resourceStatus);
    dto.createdAt = entity.createdAt.toISOString();
    dto.updatedAt = entity.updatedAt.toISOString();
    dto.version = entity.version;
    return dto;
  }

  static toPaginatedResponse({ page, limit, count, data }: FetchResponse<WorkflowInvariantRuleEntity>): PaginatedWorkflowInvariantRuleResponse {
    return new PaginatedWorkflowInvariantRuleResponse({
      page,
      limit,
      count,
      data: data.map((entity) => WorkflowInvariantRuleDtoMapper.toResponse(entity)),
    });
  }
}
