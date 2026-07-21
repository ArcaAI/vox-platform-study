import { Injectable } from '@nestjs/common';

import { Repository } from '../../../common';
import { PipelinePolicyChangeEntityMapper } from '../../../mappers';
import { PipelinePolicyChangeEntity } from '../../../entities';
import { PipelinePolicyChange } from '../../../models';
import { CoreUnitOfWorkService } from '../../../common/unitsOfWork/core';

/**
 * Append-only WORM pipeline-policy-change repository. Writes
 * go through the inherited `create`; there is intentionally no update/delete
 * surface (the DB REVOKEs those privileges). `id` is a time-sortable UUIDv7, so
 * ordering by `id` reflects append order. Mirrors `HarnessPolicyChangeRepository`.
 */
@Injectable()
export class PipelinePolicyChangeRepository extends Repository<PipelinePolicyChangeEntity, PipelinePolicyChange> {
  constructor(private readonly unitOfWorkService: CoreUnitOfWorkService) {
    super(unitOfWorkService, 'pipelinePolicyChange', PipelinePolicyChangeEntityMapper.getInstance());
  }

  /** Policy-change records for a tenant, newest → oldest. */
  async listForTenant(tenantId: string): Promise<PipelinePolicyChangeEntity[]> {
    return this.findAll({
      filters: { tenantId },
      sort: [{ id: 'desc' }],
    });
  }
}
