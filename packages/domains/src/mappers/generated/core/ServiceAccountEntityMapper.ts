import { AutoClassMapper, AutoEntityChangeMapper, BaseMapper, createMapperHandlers } from '../../../common';
import * as Entities from '../../../entities';
import * as Models from '../../../models';

// HAND-AUTHORED — `gen:mapper` is DESTRUCTIVE and must never be run (it strips
// exactly the `_version` guard below before crashing; see `03-domain-layer.md`).
// Follows the `AiProviderConnectionEntityMapper` precedent in this folder.
//
// `_version` is owned by the database and the only legitimate writer is
// `Repository.updateWithVersion`. `ServiceAccount` IS OCC-written (versioned
// PATCH routes on `/admin/service-accounts/:id`), so the strip is load-bearing.
const FIELDS_NOT_WRITABLE: string[] = ['version'];

function stripNonWritableFields<T extends object>(model: T, fields: string[]): T {
  for (const field of fields) delete (model as Record<string, unknown>)[field];
  return model;
}

export class ServiceAccountEntityMapper extends BaseMapper<Entities.ServiceAccountEntity, Models.ServiceAccount> {
  constructor() {
    super();
  }

  public toPersistence(entity: Entities.ServiceAccountEntity): Models.ServiceAccount {
    const result = AutoClassMapper(entity, Models.ServiceAccount, ServiceAccountEntityMapperHandlers.$toPersistence);
    return stripNonWritableFields(result, FIELDS_NOT_WRITABLE);
  }

  public toPersistenceChanges(entity: Entities.ServiceAccountEntity): Partial<Models.ServiceAccount> {
    const result = AutoEntityChangeMapper(entity, Models.ServiceAccount, ServiceAccountEntityMapperHandlers.$toPersistence);
    return stripNonWritableFields(result, FIELDS_NOT_WRITABLE);
  }

  public toDomainEntity(dataModel: Models.ServiceAccount): Entities.ServiceAccountEntity {
    return AutoClassMapper(dataModel, Entities.ServiceAccountEntity, ServiceAccountEntityMapperHandlers.$toDomain);
  }
}

export const ServiceAccountEntityMapperHandlers = createMapperHandlers<Entities.ServiceAccountEntity, Models.ServiceAccount>({
  $toPersistence: {},
  $toDomain: {},
});
