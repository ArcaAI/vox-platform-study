import { AutoClassMapper, AutoEntityChangeMapper, BaseMapper, createMapperHandlers } from '../../../common';
import * as Entities from '../../../entities';
import * as Models from '../../../models';

const FIELDS_NOT_IN_PRISMA: string[] = [
  'version',
  'createdBy',
  'updatedBy',
  'updatedAt',
  'resourceStatus',
  'resourceStatusUpdatedAt',
  'resourceStatusUpdatedBy',
];

function stripNonPrismaFields<T extends object>(model: T, fields: string[]): T {
  for (const field of fields) {
    delete (model as Record<string, unknown>)[field];
  }
  return model;
}

export class NamedEntityEntityMapper extends BaseMapper<Entities.NamedEntityEntity, Models.NamedEntity> {
  constructor() {
    super();
  }

  public toPersistence(entity: Entities.NamedEntityEntity): Models.NamedEntity {
    const result = AutoClassMapper(entity, Models.NamedEntity, NamedEntityEntityMapperHandlers.$toPersistence);
    return stripNonPrismaFields(result, FIELDS_NOT_IN_PRISMA);
  }

  public toPersistenceChanges(entity: Entities.NamedEntityEntity): Partial<Models.NamedEntity> {
    const result = AutoEntityChangeMapper(entity, Models.NamedEntity, NamedEntityEntityMapperHandlers.$toPersistence);
    return stripNonPrismaFields(result, FIELDS_NOT_IN_PRISMA);
  }

  public toDomainEntity(dataModel: Models.NamedEntity): Entities.NamedEntityEntity {
    return AutoClassMapper(dataModel, Entities.NamedEntityEntity, NamedEntityEntityMapperHandlers.$toDomain);
  }
}

export const NamedEntityEntityMapperHandlers = createMapperHandlers<Entities.NamedEntityEntity, Models.NamedEntity>({
  $toPersistence: {},
  $toDomain: {},
});
