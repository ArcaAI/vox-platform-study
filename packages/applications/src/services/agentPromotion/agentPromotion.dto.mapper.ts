import { AgentPromotionEntity } from '@arcaai/domains';
import { AgentPromotionResponse } from './dto';

export class AgentPromotionDtoMapper {
  /**
   * `drifted` is supplied by the service (it needs the target agent's CURRENT
   * checksum, which is a read the mapper must not perform) and is left absent
   * rather than defaulted — "we did not compute it" and "it has not drifted"
   * are different statements about an audit record.
   */
  static toResponse(entity: AgentPromotionEntity, drifted?: boolean): AgentPromotionResponse {
    const response = new AgentPromotionResponse();
    response.id = entity.id;
    response.fromTenantId = entity.fromTenantId;
    response.toTenantId = entity.toTenantId;
    response.agentVersionId = entity.agentVersionId;
    response.sourceAgentId = entity.sourceAgentId;
    response.targetAgentId = entity.targetAgentId;
    response.targetAgentVersionId = entity.targetAgentVersionId ?? null;
    response.configSnapshot = (entity.configSnapshot as Record<string, unknown> | null) ?? {};
    response.checksum = entity.checksum;
    response.evalRunId = entity.evalRunId ?? null;
    response.sourceEvalRunId = entity.sourceEvalRunId ?? null;
    response.warnings = Array.isArray(entity.warnings) ? (entity.warnings as string[]) : [];
    response.promotedBy = entity.promotedBy ?? null;
    if (drifted !== undefined) {
      response.drifted = drifted;
    }
    response.createdAt = entity.createdAt.toISOString();
    response.version = entity.version;
    return response;
  }
}
