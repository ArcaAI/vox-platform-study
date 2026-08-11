import { PaginatedQuery } from '../../common';
import { AgentPromotionResponse, PaginatedAgentPromotionResponse, PromoteAgentRequest } from './dto';

export const IAgentPromotionService = Symbol('IAgentPromotionService');

/**
 * TASK-663 — agent promotion between tenants.
 *
 * NOTE the two different context requirements on this one service, which is
 * deliberate and documented on each method:
 *
 *   - `promote` runs under an ELEVATED TENANT-LESS context (the
 *     `AgentTemplateResyncService` precedent), because it must read and write
 *     across a tenant boundary.
 *   - `list` / `getById` are ORDINARY tenant-scoped reads by the TARGET tenant,
 *     which owns the promotion records as its own agent lineage.
 */
export interface IAgentPromotionService {
  promote(dto: PromoteAgentRequest): Promise<AgentPromotionResponse>;
  list(query: PaginatedQuery, targetAgentId?: string): Promise<PaginatedAgentPromotionResponse>;
  getById(id: string): Promise<AgentPromotionResponse>;
}
