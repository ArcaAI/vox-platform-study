import { PaginatedQuery } from '../../common';
import { AgentPromotionResponse, PaginatedAgentPromotionResponse, PromoteWorkflowRequest } from './dto';

export const IAgentPromotionService = Symbol('IAgentPromotionService');

/**
 * Workflow promotion between tenants ( renamed the promotable; the
 * service and its records keep their names because the `AgentPromotion` table
 * is WORM and pre-dates the change).
 *
 * NOTE the two different context requirements on this one service, which is
 * deliberate and documented on each method:
 *
 *   - `promote` runs under an ELEVATED TENANT-LESS context, because it must
 *     read and write across a tenant boundary.
 *   - `list` / `getById` are ORDINARY tenant-scoped reads by the TARGET tenant,
 *     which owns the promotion records as its own workflow lineage.
 */
export interface IAgentPromotionService {
  promote(dto: PromoteWorkflowRequest): Promise<AgentPromotionResponse>;
  list(query: PaginatedQuery, targetDefinitionSlug?: string): Promise<PaginatedAgentPromotionResponse>;
  getById(id: string): Promise<AgentPromotionResponse>;
}
