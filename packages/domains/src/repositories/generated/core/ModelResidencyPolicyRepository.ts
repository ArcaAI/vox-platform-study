import { Injectable } from '@nestjs/common';
import { DataNotFoundException } from '@arcaai/exceptions';

import { Repository } from '../../../common';
import { CoreUnitOfWorkService } from '../../../common/unitsOfWork/core';
import { ModelResidencyPolicyEntity } from '../../../entities';
import { ResourceStatusType } from '../../../enums';
import { ModelResidencyPolicyEntityMapper } from '../../../mappers';
import { ModelResidencyPolicy } from '../../../models';

/**
 * Desired load/unload/pin state per (model, service) — TASK-1005 §5.2.
 *
 * SYSTEM-only platform configuration: every row carries the reserved SYSTEM
 * tenantId. Reads/writes still go through the tenant-scope extension like
 * every other tenant-scoped model (see the Prisma model header for why).
 */
@Injectable()
export class ModelResidencyPolicyRepository extends Repository<ModelResidencyPolicyEntity, ModelResidencyPolicy> {
  constructor(private readonly unitOfWorkService: CoreUnitOfWorkService) {
    super(unitOfWorkService, 'modelResidencyPolicy', ModelResidencyPolicyEntityMapper.getInstance());
  }

  /**
   * The live policy row for one (tenantId, aiModelId, service) — the same
   * grain as the `ModelResidencyPolicy_tenant_model_service_unique` index —
   * or `null` when the controller must fall back to its implicit default
   * (§5.2 "Defaults when no row exists").
   */
  async findByModelAndService(tenantId: string, aiModelId: string, service: string): Promise<ModelResidencyPolicyEntity | null> {
    try {
      return await this.findFirst({
        filters: {
          tenantId,
          aiModelId,
          service,
          resourceStatus: ResourceStatusType.ENABLED,
        },
      });
    } catch (err) {
      if (err instanceof DataNotFoundException) {
        return null;
      }
      throw err;
    }
  }
}
