import { AutoClassMapper, AutoEntityChangeMapper, BaseMapper, createMapperHandlers } from '../../../common';
import * as Entities from '../../../entities';
import * as Models from '../../../models';

// `_version` is owned by the database and the only legitimate writer is
// `Repository.updateWithVersion`. Strip it from every write path here so the
// auto-mappers cannot leak it into a Prisma update — lines are written and re-written while the invoice is a DRAFT.
// Mirrors the `DepartmentEntityMapper` / `AiTaskDefaultEntityMapper` treatment.
//
// `resourceStatus*` is NOT stripped: unlike its append-only siblings in this
// plane, `BillingInvoiceLine` keeps the standard soft-delete lifecycle and those columns
// exist.
const FIELDS_NOT_WRITABLE: string[] = ['version'];

function stripNonWritableFields<T extends object>(model: T, fields: string[]): T {
  for (const field of fields) {
    delete (model as Record<string, unknown>)[field];
  }
  return model;
}

export class BillingInvoiceLineEntityMapper extends BaseMapper<Entities.BillingInvoiceLineEntity, Models.BillingInvoiceLine> {
  constructor() {
    super();
  }

  public toPersistence(entity: Entities.BillingInvoiceLineEntity): Models.BillingInvoiceLine {
    const result = AutoClassMapper(entity, Models.BillingInvoiceLine, BillingInvoiceLineEntityMapperHandlers.$toPersistence);
    return stripNonWritableFields(result, FIELDS_NOT_WRITABLE);
  }

  public toPersistenceChanges(entity: Entities.BillingInvoiceLineEntity): Partial<Models.BillingInvoiceLine> {
    const result = AutoEntityChangeMapper(entity, Models.BillingInvoiceLine, BillingInvoiceLineEntityMapperHandlers.$toPersistence);
    return stripNonWritableFields(result, FIELDS_NOT_WRITABLE);
  }

  public toDomainEntity(dataModel: Models.BillingInvoiceLine): Entities.BillingInvoiceLineEntity {
    return AutoClassMapper(dataModel, Entities.BillingInvoiceLineEntity, BillingInvoiceLineEntityMapperHandlers.$toDomain);
  }
}

export const BillingInvoiceLineEntityMapperHandlers = createMapperHandlers<Entities.BillingInvoiceLineEntity, Models.BillingInvoiceLine>({
  $toPersistence: {},
  $toDomain: {},
});
