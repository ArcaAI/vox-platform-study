import { Injectable } from '@nestjs/common';

import { Repository } from '../../../common';
import { CoreUnitOfWorkService } from '../../../common/unitsOfWork/core';
import { AgentPromotionEntity } from '../../../entities';
import { AgentPromotionEntityMapper } from '../../../mappers';
import { AgentPromotion } from '../../../models';

/**
 * Immutable, WORM records of agent promotions between tenants.
 *
 * Listed in `MODELS_WITHOUT_SOFT_DELETE`: the table has no `resourceStatus`
 * column, so `softDelete`/`restore` throw and reads must NOT filter on it. That
 * is the point — the table is an audit history of privileged cross-tenant
 * writes, and its value depends on entries being unretractable.
 *
 * `update` is never called on this model. Every promotion creates a NEW row.
 *
 * `tenantId` is the TARGET tenant. Note that the promotion service runs under
 * an elevated tenant-less context (the `AgentTemplateResyncService` precedent),
 * where the tenant-scope Prisma extension passes through and injects NOTHING —
 * so every call below takes `tenantId` explicitly and every caller must supply
 * it. A missing filter here reads across all tenants.
 */
@Injectable()
export class AgentPromotionRepository extends Repository<AgentPromotionEntity, AgentPromotion> {
  constructor(private readonly unitOfWorkService: CoreUnitOfWorkService) {
    super(unitOfWorkService, 'agentPromotion', AgentPromotionEntityMapper.getInstance());
  }

  /**
   * Every promotion INTO an agent, newest first — the target-tenant lineage
   * read (AC-8). Covered by `AgentPromotion_tenantId_targetAgentId_idx`.
   */
  async findAllForTargetAgent(tenantId: string, targetAgentId: string): Promise<AgentPromotionEntity[]> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- DbFilters<AgentPromotion> would require importing the Prisma-generated model type here (the DepartmentAgentVersionRepository precedent).
    return this.findAll({ filters: { tenantId, targetAgentId } as any, sort: [{ createdAt: 'desc' }] });
  }

  /** The most recent promotion into an agent, or null before the first one. */
  async findLatestForTargetAgent(tenantId: string, targetAgentId: string): Promise<AgentPromotionEntity | null> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- see findAllForTargetAgent.
    const rows = await this.findAll({ filters: { tenantId, targetAgentId } as any, sort: [{ createdAt: 'desc' }], limit: 1, page: 1 });
    return rows[0] ?? null;
  }
}
