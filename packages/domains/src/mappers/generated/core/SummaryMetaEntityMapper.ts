import { AutoClassMapper, AutoEntityChangeMapper, BaseMapper, createMapperHandlers } from '../../../common';
import * as Entities from '../../../entities';
import * as Models from '../../../models';

// `SummaryMeta` has `id`, `tenantId`, `createdAt`, `updatedAt` but NO `_version`
// / `_metadata` / `createdBy` / `updatedBy` columns. The base entity/model carry
// those inherited fields, so strip them before persistence to avoid Prisma
// "Unknown argument `version`" errors on insert. (`updatedAt` IS a real column.)
const FIELDS_NOT_IN_PRISMA: string[] = [
  'version',
  'metaData',
  'createdBy',
  'updatedBy',
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

export class SummaryMetaEntityMapper extends BaseMapper<Entities.SummaryMetaEntity, Models.SummaryMeta> {
  constructor() {
    super();
  }

  public toPersistence(entity: Entities.SummaryMetaEntity): Models.SummaryMeta {
    const result = AutoClassMapper(entity, Models.SummaryMeta, SummaryMetaEntityMapperHandlers.$toPersistence);
    return stripNonPrismaFields(result, FIELDS_NOT_IN_PRISMA);
  }

  public toPersistenceChanges(entity: Entities.SummaryMetaEntity): Partial<Models.SummaryMeta> {
    const result = AutoEntityChangeMapper(entity, Models.SummaryMeta, SummaryMetaEntityMapperHandlers.$toPersistence);
    return stripNonPrismaFields(result, FIELDS_NOT_IN_PRISMA);
  }

  public toDomainEntity(dataModel: Models.SummaryMeta): Entities.SummaryMetaEntity {
    return AutoClassMapper(dataModel, Entities.SummaryMetaEntity, SummaryMetaEntityMapperHandlers.$toDomain);
  }
}

export const SummaryMetaEntityMapperHandlers = createMapperHandlers<Entities.SummaryMetaEntity, Models.SummaryMeta>({
  $toPersistence: {
    // Bytes-safe: return the raw ciphertext Buffer directly.
    encryptedCitationsMap: (entity) => entity.encryptedCitationsMap ?? null,
    encryptedGuardrailDecisions: (entity) => entity.encryptedGuardrailDecisions ?? null,
    encryptedRedactionManifest: (entity) => entity.encryptedRedactionManifest ?? null,
  },
  $toDomain: {
    encryptedCitationsMap: (model) => model.encryptedCitationsMap ?? null,
    encryptedGuardrailDecisions: (model) => model.encryptedGuardrailDecisions ?? null,
    encryptedRedactionManifest: (model) => model.encryptedRedactionManifest ?? null,
  },
});
