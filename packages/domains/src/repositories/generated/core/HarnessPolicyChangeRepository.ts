import { Injectable } from '@nestjs/common';

import { Repository } from '../../../common';
import { HarnessPolicyChangeEntityMapper } from '../../../mappers';
import { HarnessPolicyChangeEntity } from '../../../entities';
import { HarnessPolicyChange } from '../../../models';
import { CoreUnitOfWorkService } from '../../../common/unitsOfWork/core';

/**
 * Append-only WORM policy-change repository (TASK-330 Phase 6). Writes go
 * through the inherited `create`; there is intentionally no update/delete
 * surface (the DB REVOKEs those privileges). `id` is a time-sortable UUIDv7,
 * so ordering by `id` reflects append order. Mirrors
 * `HarnessAuditEventRepository`.
 */
@Injectable()
export class HarnessPolicyChangeRepository extends Repository<HarnessPolicyChangeEntity, HarnessPolicyChange> {
  constructor(private readonly unitOfWorkService: CoreUnitOfWorkService) {
    super(unitOfWorkService, 'harnessPolicyChange', HarnessPolicyChangeEntityMapper.getInstance());
  }

  /** Policy-change records for a tenant, newest → oldest. */
  async listForTenant(tenantId: string): Promise<HarnessPolicyChangeEntity[]> {
    return this.findAll({
      filters: { tenantId },
      sort: [{ id: 'desc' }],
    });
  }
}
