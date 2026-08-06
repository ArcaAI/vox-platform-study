import { Injectable } from '@nestjs/common';
import { Prisma } from '@arcaai/database';

import { CoreUnitOfWorkService } from '../../common/unitsOfWork/core';
import { removeNullValues } from '../../common/removeNullValues';
import { BillingInvoiceLineEntity } from '../../entities';
import { ResourceStatusType } from '../../enums';
import { BillingInvoiceLineEntityMapper } from '../../mappers';
import { BillingInvoiceLineRepository } from '../generated/core/BillingInvoiceLineRepository';

/**
 * Tx-aware invoice-line supersede writes (TASK-615 WS-I).
 *
 * Recomputing a DRAFT replaces its lines idempotently: the OLD lines are
 * soft-deleted and the NEW set is inserted, in the SAME transaction that
 * updates the invoice totals — a crash mid-recompute must never leave an
 * invoice whose totals disagree with its live lines.
 *
 * The base `Repository` cannot express that today: `softDelete` and
 * `createMany` take no transaction client (a known wave-2 follow-up, flagged
 * by WS-F). This extension adds the two tx-aware forms rather than patching
 * the shared base mid-wave.
 *
 * Soft-delete, never hard-delete: superseded draft lines stay queryable as
 * the recompute audit trail (the extended client's read filter hides them
 * from ordinary reads).
 */
@Injectable()
export class BillingInvoiceLineWriteRepository extends BillingInvoiceLineRepository {
  constructor(unitOfWorkService: CoreUnitOfWorkService) {
    super(unitOfWorkService);
  }

  /**
   * Soft-delete every LIVE line of one invoice through the caller's tx.
   * Bumps `_version` on each row — soft-delete is a real state change (OCC).
   */
  async softDeleteByInvoice(tenantId: string, invoiceId: string, updatedBy: string | null, tx: Prisma.TransactionClient | any): Promise<number> {
    const result = await (tx as Record<string, any>).billingInvoiceLine.updateMany({
      where: { tenantId, invoiceId, resourceStatus: { not: ResourceStatusType.DELETED } },
      data: {
        resourceStatus: ResourceStatusType.DELETED,
        resourceStatusUpdatedAt: new Date(),
        ...(updatedBy ? { resourceStatusUpdatedBy: updatedBy } : {}),
        version: { increment: 1 },
      },
    });
    return result.count as number;
  }

  /**
   * Insert a batch of lines through the caller's tx. Uses the SAME mapper +
   * null-stripping pipeline as `Repository.create`, so the `_version` OCC
   * strip applies (the DB owns `_version`).
   */
  async createManyInTx(entities: readonly BillingInvoiceLineEntity[], tx: Prisma.TransactionClient | any): Promise<number> {
    if (entities.length === 0) return 0;
    const mapper = BillingInvoiceLineEntityMapper.getInstance();
    const data = entities.map((entity) => removeNullValues(mapper.toPersistence(entity)));
    const result = await (tx as Record<string, any>).billingInvoiceLine.createMany({ data });
    return result.count as number;
  }
}
