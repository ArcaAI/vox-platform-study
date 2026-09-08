import { PromoteAgentToSystemRequest, PromoteAgentToSystemResponse } from './dto';

export const IAgentPromoteToSystemService = Symbol('IAgentPromoteToSystemService');

/**
 * TASK-930 §6.1 — Global → SYSTEM promotion of ONE agent lineage.
 *
 * Its own port rather than a method on `IAgentPromotionService`, because that service promotes a
 * WORKFLOW between two arbitrary tenants and this one promotes an AGENT along the single declared
 * platform path. They share the WORM `AgentPromotion` table and nothing else: different source
 * resolution, different referenced content, and — the load-bearing difference — this one PUBLISHES
 * and ACTIVATES what it writes, which a tenant → tenant push must never do.
 *
 * Runs under an ELEVATED TENANT-LESS context for the mechanical reason `AgentPromotionService`
 * documents: with a pinned tenant the tenant-scope Prisma extension forces the caller's `tenantId`
 * into every read, which makes a cross-tenant read impossible rather than merely unauthorized.
 */
export interface IAgentPromoteToSystemService {
  promoteToSystem(dto: PromoteAgentToSystemRequest): Promise<PromoteAgentToSystemResponse>;
}
