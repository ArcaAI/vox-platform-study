import { Injectable } from '@nestjs/common';

import { Repository } from '../../../common';
import { CoreUnitOfWorkService } from '../../../common/unitsOfWork/core';
import { WorkflowWebhookSecretEntity } from '../../../entities';
import { WorkflowWebhookSecretEntityMapper } from '../../../mappers';
import { WorkflowWebhookSecret } from '../../../models';

/**
 * TASK-864 — the inbound workflow webhook trigger's per-definition secret.
 *
 * HAND-AUTHORED (the `gen:repository` generator is broken — rule 03), following the
 * `AiProviderConnectionRepository` precedent. One row per (tenant, workflowSlug), enforced by
 * `WorkflowWebhookSecret_tenant_slug_key`. Tenant-scoped through the Prisma extension; never
 * SYSTEM-shared.
 */
@Injectable()
export class WorkflowWebhookSecretRepository extends Repository<WorkflowWebhookSecretEntity, WorkflowWebhookSecret> {
  constructor(private readonly unitOfWorkService: CoreUnitOfWorkService) {
    super(unitOfWorkService, 'workflowWebhookSecret', WorkflowWebhookSecretEntityMapper.getInstance());
  }

  /** The ONE secret row of a workflow lineage, or `null` when none was ever issued. */
  async findByTenantSlug(tenantId: string, workflowSlug: string): Promise<WorkflowWebhookSecretEntity | null> {
    const rows = await this.findAll({ filters: { tenantId, workflowSlug } });
    return rows[0] ?? null;
  }
}
