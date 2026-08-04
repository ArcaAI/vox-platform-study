import { AutoClassMapper, AutoEntityChangeMapper, BaseMapper, createMapperHandlers } from '../../../common';
import * as Entities from '../../../entities';
import * as Models from '../../../models';

// HAND-AUTHORED (the `gen:mapper` generator crashes pre-existingly, stripping
// this very guard before it dies; see the AiProviderConnectionEntityMapper /
// AiTaskDefaultEntityMapper precedents in this folder).
//
// `_version` is owned by the database and the only legitimate writer is
// `Repository.updateWithVersion`. Strip it from every write path here so the
// auto-mappers cannot leak it into a Prisma update. TenantAllowedOrigin IS
// OCC-written (versioned admin PATCH route — TASK-610).
const FIELDS_NOT_WRITABLE: string[] = ['version'];

function stripNonWritableFields<T extends object>(model: T, fields: string[]): T {
  for (const field of fields) delete (model as Record<string, unknown>)[field];
  return model;
}

export class TenantAllowedOriginEntityMapper extends BaseMapper<Entities.TenantAllowedOriginEntity, Models.TenantAllowedOrigin> {
  constructor() {
    super();
  }

  public toPersistence(entity: Entities.TenantAllowedOriginEntity): Models.TenantAllowedOrigin {
    const result = AutoClassMapper(entity, Models.TenantAllowedOrigin, TenantAllowedOriginEntityMapperHandlers.$toPersistence);
    return stripNonWritableFields(result, FIELDS_NOT_WRITABLE);
  }

  public toPersistenceChanges(entity: Entities.TenantAllowedOriginEntity): Partial<Models.TenantAllowedOrigin> {
    const result = AutoEntityChangeMapper(entity, Models.TenantAllowedOrigin, TenantAllowedOriginEntityMapperHandlers.$toPersistence);
    return stripNonWritableFields(result, FIELDS_NOT_WRITABLE);
  }

  public toDomainEntity(dataModel: Models.TenantAllowedOrigin): Entities.TenantAllowedOriginEntity {
    return AutoClassMapper(dataModel, Entities.TenantAllowedOriginEntity, TenantAllowedOriginEntityMapperHandlers.$toDomain);
  }
}

export const TenantAllowedOriginEntityMapperHandlers = createMapperHandlers<Entities.TenantAllowedOriginEntity, Models.TenantAllowedOrigin>({
  $toPersistence: {},
  $toDomain: {},
});
