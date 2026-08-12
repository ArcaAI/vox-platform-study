import { Injectable } from '@nestjs/common';
import { Prisma } from '@arcaai/database';

import { CoreUnitOfWorkService } from '../../common/unitsOfWork/core';
import { ResourceStatusType } from '../../enums';
import { BillingInvoiceLineRepository } from '../generated/core/BillingInvoiceLineRepository';

/**
 * Structural view of the transaction client this extension writes through —
 * typed instead of `any` so the only-warn `no-explicit-any` gate stays clean
 * while still accepting both the real `Prisma.TransactionClient` and mocked
 * delegates in unit tests.
 */
interface BillingLineTxDelegate {
  billingInvoiceLine: {
    updateMany: (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => Promise<{ count: number }>;
  };
}

/**
 * Tx-aware invoice-line supersede write (TASK-615 WS-I).
 *
 * Recomputing a DRAFT replaces its lines idempotently: the OLD lines are
 * soft-deleted and the NEW set is inserted, in the SAME transaction that
 * updates the invoice totals — a crash mid-recompute must never leave an
 * invoice whose totals disagree with its live lines.
 *
 * The insert half is just `Repository.createMany(lines, false, tx)`. The
 * soft-delete half is what the base cannot express: it is a bulk PREDICATE
 * delete (`updateMany` over every live line of an invoice), whereas the base
 * `softDelete` takes a single id.
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
  async softDeleteByInvoice(
    tenantId: string,
    invoiceId: string,
    updatedBy: string | null,
    tx: Prisma.TransactionClient | BillingLineTxDelegate,
  ): Promise<number> {
    const result = await (tx as BillingLineTxDelegate).billingInvoiceLine.updateMany({
      where: { tenantId, invoiceId, resourceStatus: { not: ResourceStatusType.DELETED } },
      data: {
        resourceStatus: ResourceStatusType.DELETED,
        resourceStatusUpdatedAt: new Date(),
        ...(updatedBy ? { resourceStatusUpdatedBy: updatedBy } : {}),
        version: { increment: 1 },
      },
    });
    return result.count;
  }
}
