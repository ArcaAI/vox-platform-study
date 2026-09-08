import type { CorePrisma, WorkflowDefinitionEntity } from '@arcaai/domains';
import { PaginatedQuery } from '../../common';
import { AgentPromotionResponse, PaginatedAgentPromotionResponse, PromoteWorkflowRequest } from './dto';

/**
 * TASK-930 D-4 — an optional step that runs INSIDE the promotion's transaction, after the target
 * definition and its WORM `AgentPromotion` record are written and before the commit.
 *
 * It exists because `WorkflowDefinitionService.promoteToSystem` does not merely copy a workflow
 * into SYSTEM — it PUBLISHES the copy, and a publish can still refuse (the publish gate, a
 * hyper-parameter the bound configuration does not accept). Run after the commit, as it was, a
 * refusal left an orphan SYSTEM DRAFT behind and burned a version number; run here, it rolls the
 * whole promotion back, which is the same "a block writes nothing" posture the eval gate and the
 * §6.2 agent check already have.
 *
 * The `tx` client is handed over because a repository CACHES its database context at
 * construction (`Repository`'s constructor), so CLS propagation does NOT enrol these singletons:
 * passing `tx` explicitly is what actually puts the hook's writes in this transaction — and
 * without it they would target a row that is not visible outside it yet.
 *
 * It is NOT a general extension point: it is the unit of work opened for a caller that has one
 * more write to make in the same breath. Anything that does not need to be atomic with the copy
 * belongs after `promote()` returns.
 */
export type PromoteOptions = {
  afterWrite?: (definition: WorkflowDefinitionEntity, tx: CorePrisma.TransactionClient) => Promise<void>;
};

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
  promote(dto: PromoteWorkflowRequest, options?: PromoteOptions): Promise<AgentPromotionResponse>;
  list(query: PaginatedQuery, targetDefinitionSlug?: string): Promise<PaginatedAgentPromotionResponse>;
  getById(id: string): Promise<AgentPromotionResponse>;
}
