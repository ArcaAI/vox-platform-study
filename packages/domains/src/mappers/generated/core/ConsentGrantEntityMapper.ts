import { AutoClassMapper, AutoEntityChangeMapper, BaseMapper, createMapperHandlers } from '../../../common';
import * as Entities from '../../../entities';
import * as Models from '../../../models';

// HAND-AUTHORED (the `gen:mapper` generator crashes pre-existingly; see
// AiProviderConnectionEntityMapper / AiTaskDefaultEntityMapper).
// (consent-abac).
//
// `_version` is owned by the database and the only legitimate writer is
// `Repository.updateWithVersion`. Strip it from every write path here — this
// model IS OCC-written (`revoke` is a versioned write via
// `ConsentGrantService`).
const FIELDS_NOT_WRITABLE: string[] = ['version'];

function stripNonWritableFields<T extends object>(model: T, fields: string[]): T {
  for (const field of fields) delete (model as Record<string, unknown>)[field];
  return model;
}

export class ConsentGrantEntityMapper extends BaseMapper<Entities.ConsentGrantEntity, Models.ConsentGrant> {
  constructor() {
    super();
  }

  public toPersistence(entity: Entities.ConsentGrantEntity): Models.ConsentGrant {
    const result = AutoClassMapper(entity, Models.ConsentGrant, ConsentGrantEntityMapperHandlers.$toPersistence);
    return stripNonWritableFields(result, FIELDS_NOT_WRITABLE);
  }

  public toPersistenceChanges(entity: Entities.ConsentGrantEntity): Partial<Models.ConsentGrant> {
    const result = AutoEntityChangeMapper(entity, Models.ConsentGrant, ConsentGrantEntityMapperHandlers.$toPersistence);
    return stripNonWritableFields(result, FIELDS_NOT_WRITABLE);
  }

  public toDomainEntity(dataModel: Models.ConsentGrant): Entities.ConsentGrantEntity {
    return AutoClassMapper(dataModel, Entities.ConsentGrantEntity, ConsentGrantEntityMapperHandlers.$toDomain);
  }
}

export const ConsentGrantEntityMapperHandlers = createMapperHandlers<Entities.ConsentGrantEntity, Models.ConsentGrant>({
  $toPersistence: {},
  $toDomain: {},
});
