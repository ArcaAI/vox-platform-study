import { AutoClassMapper, AutoEntityChangeMapper, BaseMapper, createMapperHandlers } from '../../../common';
import * as Entities from '../../../entities';
import * as Models from '../../../models';

// `_version` is owned by the database and the only legitimate writer is
// `Repository.updateWithVersion`. Strip it from every write path here so the
// auto-mappers cannot leak it into a Prisma update — the invoice is the ONE optimistically-concurrency-controlled model of TASK-615 — draft edits and the FINALIZE transition are guarded by _version, so letting it reach a Prisma update would let two concurrent finalizes both win on a money document.
// Mirrors the `DepartmentEntityMapper` / `AiTaskDefaultEntityMapper` treatment.
//
// `resourceStatus*` is NOT stripped: unlike its append-only siblings in this
// plane, `BillingInvoice` keeps the standard soft-delete lifecycle and those columns
// exist.
const FIELDS_NOT_WRITABLE: string[] = ['version'];

function stripNonWritableFields<T extends object>(model: T, fields: string[]): T {
  for (const field of fields) {
    delete (model as Record<string, unknown>)[field];
  }
  return model;
}

export class BillingInvoiceEntityMapper extends BaseMapper<Entities.BillingInvoiceEntity, Models.BillingInvoice> {
  constructor() {
    super();
  }

  public toPersistence(entity: Entities.BillingInvoiceEntity): Models.BillingInvoice {
    const result = AutoClassMapper(entity, Models.BillingInvoice, BillingInvoiceEntityMapperHandlers.$toPersistence);
    return stripNonWritableFields(result, FIELDS_NOT_WRITABLE);
  }

  public toPersistenceChanges(entity: Entities.BillingInvoiceEntity): Partial<Models.BillingInvoice> {
    const result = AutoEntityChangeMapper(entity, Models.BillingInvoice, BillingInvoiceEntityMapperHandlers.$toPersistence);
    return stripNonWritableFields(result, FIELDS_NOT_WRITABLE);
  }

  public toDomainEntity(dataModel: Models.BillingInvoice): Entities.BillingInvoiceEntity {
    return AutoClassMapper(dataModel, Entities.BillingInvoiceEntity, BillingInvoiceEntityMapperHandlers.$toDomain);
  }
}

export const BillingInvoiceEntityMapperHandlers = createMapperHandlers<Entities.BillingInvoiceEntity, Models.BillingInvoice>({
  $toPersistence: {},
  $toDomain: {},
});
