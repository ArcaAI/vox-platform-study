import { Injectable } from '@nestjs/common';

import { Repository } from '../../../common';
import { HarnessAuditEventEntityMapper } from '../../../mappers';
import { HarnessAuditEventEntity } from '../../../entities';
import { HarnessAuditEvent } from '../../../models';
import { CoreUnitOfWorkService } from '../../../common/unitsOfWork/core';

/**
 * Append-only WORM audit repository. Writes go through the
 * inherited `create`; there is intentionally no update/delete surface (the DB
 * REVOKEs those privileges). `id` is a time-sortable UUIDv7, so ordering by
 * `id` reflects append order and anchors the hash chain.
 */
@Injectable()
export class HarnessAuditEventRepository extends Repository<HarnessAuditEventEntity, HarnessAuditEvent> {
  constructor(private readonly unitOfWorkService: CoreUnitOfWorkService) {
    super(unitOfWorkService, 'harnessAuditEvent', HarnessAuditEventEntityMapper.getInstance());
  }

  /**
   * The most recently appended event for a tenant (its `hash` becomes the next
   * event's `prevHash`), or `null` when the tenant's chain is empty.
   */
  async getLatestForTenant(tenantId: string): Promise<HarnessAuditEventEntity | null> {
    try {
      return await this.findFirst({
        filters: { tenantId },
        sort: [{ id: 'desc' }],
      });
    } catch {
      return null;
    }
  }

  /**
   * The full audit chain for a tenant, oldest → newest, for chain verification.
   */
  async getChainForTenant(tenantId: string): Promise<HarnessAuditEventEntity[]> {
    return this.findAll({
      filters: { tenantId },
      sort: [{ id: 'asc' }],
    });
  }

  /**
   * Audit events for a single consultation, oldest → newest.
   */
  async getByConsultation(tenantId: string, consultationId: string): Promise<HarnessAuditEventEntity[]> {
    return this.findAll({
      filters: { tenantId, consultationId },
      sort: [{ id: 'asc' }],
    });
  }
}
