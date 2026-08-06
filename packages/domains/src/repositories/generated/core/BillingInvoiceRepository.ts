import { Injectable } from '@nestjs/common';
import { Prisma } from '@arcaai/database';
import { DataNotFoundException } from '@arcaai/exceptions';

import { Repository } from '../../../common';
import { CoreUnitOfWorkService } from '../../../common/unitsOfWork/core';
import { BillingInvoiceEntity } from '../../../entities';
import { BillingInvoiceStatus } from '../../../enums';
import { BillingInvoiceEntityMapper } from '../../../mappers';
import { BillingInvoice } from '../../../models';

/**
 * Invoice repository.
 *
 * `BillingInvoice` is the ONE optimistically-concurrency-controlled model of
 * TASK-615: draft edits and the FINALIZE transition go through the inherited
 * `updateWithVersion`, so a stale writer gets an `OptimisticConcurrencyException`
 * (→ 412) instead of silently overwriting another admin's totals. Its mapper
 * carries the `FIELDS_NOT_WRITABLE = ['version']` strip that makes that work.
 *
 * Standard soft-delete lifecycle (a draft raised in error is withdrawn, not
 * purged) and sys-events on mutation (`ResourceType.BillingInvoice`).
 */
@Injectable()
export class BillingInvoiceRepository extends Repository<BillingInvoiceEntity, BillingInvoice> {
  constructor(private readonly unitOfWorkService: CoreUnitOfWorkService) {
    super(unitOfWorkService, 'billingInvoice', BillingInvoiceEntityMapper.getInstance());
  }

  /**
   * The invoice covering one period for one tenant, or null.
   *
   * `(tenantId, periodStart)` is UNIQUE in the schema — the guard against a
   * re-run of the monthly draft job issuing a second invoice for the same month.
   * This read is how the job checks before it computes.
   */
  async findByPeriod(tenantId: string, periodStart: Date, tx?: Prisma.TransactionClient | any): Promise<BillingInvoiceEntity | null> {
    const where = { tenantId, periodStart };

    if (tx) {
      const model = await (tx as Record<string, any>).billingInvoice.findFirst({ where });
      return model ? BillingInvoiceEntityMapper.getInstance().toDomainEntity(model) : null;
    }

    try {
      return await this.findFirst({ filters: where });
    } catch (err) {
      // Only a genuine miss maps to null. Anything else — most importantly the
      // tenant-scope extension's cross-tenant throw — must SURFACE, or a
      // global-admin read targeting a foreign tenant would silently look empty.
      if (err instanceof DataNotFoundException) {
        return null;
      }
      throw err;
    }
  }

  /** A tenant's invoices, newest period first. */
  async findByTenant(tenantId: string, status?: BillingInvoiceStatus): Promise<BillingInvoiceEntity[]> {
    const where: Record<string, unknown> = { tenantId };
    if (status) where.status = status;

    const models = await this.db.findMany({ where, orderBy: [{ periodStart: 'desc' }] });
    const mapper = BillingInvoiceEntityMapper.getInstance();
    return models.map((model: BillingInvoice) => mapper.toDomainEntity(model));
  }
}
