import { Injectable } from '@nestjs/common';
import { Prisma } from '@arcaai/database';
import { DataNotFoundException } from '@arcaai/exceptions';

import { Repository } from '../../../common';
import { CoreUnitOfWorkService } from '../../../common/unitsOfWork/core';
import { TenantNlpTaskInstructionsEntity } from '../../../entities';
import { ResourceStatusType } from '../../../enums';
import { TenantNlpTaskInstructionsEntityMapper } from '../../../mappers';
import { TenantNlpTaskInstructions } from '../../../models';

/**
 * Tenant-writable topic/intent instruction content repository.
 *
 * One row per (tenant, taskKey) — enforced by the
 * `TenantNlpTaskInstructions_tenant_task_unique` index. Unlike `AiTaskDefault`
 * there is no SYSTEM-tenant platform default here — a plain tenant-scoped
 * resource (see `tenant-nlp-task-instructions.prisma`).
 */
@Injectable()
export class TenantNlpTaskInstructionsRepository extends Repository<
  TenantNlpTaskInstructionsEntity,
  TenantNlpTaskInstructions
> {
  constructor(private readonly unitOfWorkService: CoreUnitOfWorkService) {
    super(unitOfWorkService, 'tenantNlpTaskInstructions', TenantNlpTaskInstructionsEntityMapper.getInstance());
  }

  /**
   * The row owned by `(tenantId, taskKey)`, ENABLED only, or null when the
   * tenant has no instructions row for the task yet.
   */
  async findByTenantAndTaskKey(
    tenantId: string,
    taskKey: string,
    tx?: Prisma.TransactionClient | any,
  ): Promise<TenantNlpTaskInstructionsEntity | null> {
    const where = { tenantId, taskKey, resourceStatus: ResourceStatusType.ENABLED };

    if (tx) {
      const model = await (tx as Record<string, any>).tenantNlpTaskInstructions.findFirst({ where });
      return model ? TenantNlpTaskInstructionsEntityMapper.getInstance().toDomainEntity(model) : null;
    }

    try {
      return await this.findFirst({ filters: where });
    } catch (err) {
      if (err instanceof DataNotFoundException) {
        return null;
      }
      throw err;
    }
  }
}
