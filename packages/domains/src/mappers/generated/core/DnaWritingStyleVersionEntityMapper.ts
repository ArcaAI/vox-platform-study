import { AutoClassMapper, AutoEntityChangeMapper, BaseMapper, createMapperHandlers } from '../../../common';
import * as Entities from '../../../entities';
import * as Models from '../../../models';
import * as Mappers from '../../../mappers';

const FIELDS_NOT_IN_PRISMA: string[] = [
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

export class DnaWritingStyleVersionEntityMapper extends BaseMapper<Entities.DnaWritingStyleVersionEntity, Models.DnaWritingStyleVersion> {
  constructor() {
    super();
  }

  public toPersistence(entity: Entities.DnaWritingStyleVersionEntity): Models.DnaWritingStyleVersion {
    const result = AutoClassMapper(entity, Models.DnaWritingStyleVersion, DnaWritingStyleVersionEntityMapperHandlers.$toPersistence);
    return stripNonPrismaFields(result, FIELDS_NOT_IN_PRISMA);
  }

  public toPersistenceChanges(entity: Entities.DnaWritingStyleVersionEntity): Partial<Models.DnaWritingStyleVersion> {
    const result = AutoEntityChangeMapper(entity, Models.DnaWritingStyleVersion, DnaWritingStyleVersionEntityMapperHandlers.$toPersistence);
    return stripNonPrismaFields(result, FIELDS_NOT_IN_PRISMA);
  }

  public toDomainEntity(dataModel: Models.DnaWritingStyleVersion): Entities.DnaWritingStyleVersionEntity {
    return AutoClassMapper(dataModel, Entities.DnaWritingStyleVersionEntity, DnaWritingStyleVersionEntityMapperHandlers.$toDomain);
  }
}

export const DnaWritingStyleVersionEntityMapperHandlers = createMapperHandlers<Entities.DnaWritingStyleVersionEntity, Models.DnaWritingStyleVersion>({
  $toPersistence: {
    // Return the raw ciphertext Buffer directly so the
    // generic auto-mapper does not destructure the typed array.
    encryptedReportData: (entity) => entity.encryptedReportData ?? null,
    encryptedStyleText: (entity) => entity.encryptedStyleText ?? null,
    encryptedRedactionRules: (entity) => entity.encryptedRedactionRules ?? null,
  },
  $toDomain: {
    encryptedReportData: (model) => model.encryptedReportData ?? null,
    encryptedStyleText: (model) => model.encryptedStyleText ?? null,
    encryptedRedactionRules: (model) => model.encryptedRedactionRules ?? null,
  },
});
