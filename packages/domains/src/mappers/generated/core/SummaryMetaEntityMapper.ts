import { AutoClassMapper, AutoEntityChangeMapper, BaseMapper, createMapperHandlers } from '../../../common';
import * as Entities from '../../../entities';
import * as Models from '../../../models';

// `SummaryMeta` has `id`, `tenantId`, `_version`, `createdAt`, `updatedAt` but NO
// `_metadata` / `createdBy` / `updatedBy` / resource-status columns. The base
// entity/model carry those inherited fields, so strip them before persistence to
// avoid Prisma "Unknown argument" errors on insert. (`updatedAt` IS a real column.)
const FIELDS_NOT_IN_PRISMA: string[] = ['metaData', 'createdBy', 'updatedBy', 'resourceStatus', 'resourceStatusUpdatedAt', 'resourceStatusUpdatedBy'];

// `_version` became a REAL column (TASK-553 F-11) so the two-phase
// optimistic-delivery backfill (`persistDraft` EARLY → `finalizeAssurance`) can
// compare-and-set. It is DATABASE-OWNED: the only legitimate writer is
// `Repository.updateWithVersion`. Strip it from every write path here so the
// auto-mappers cannot leak it into a Prisma create/update — the same treatment
// `DepartmentEntityMapper` gives it. Reads are unaffected (`toDomainEntity`
// carries the row's real version onto the entity, which is what the CAS needs).
const FIELDS_NOT_WRITABLE: string[] = ['version'];

function stripNonPrismaFields<T extends object>(model: T, fields: string[]): T {
  for (const field of fields) {
    delete (model as Record<string, unknown>)[field];
  }
  return model;
}

function stripNonWritableFields<T extends object>(model: T, fields: string[]): T {
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
    return stripNonWritableFields(stripNonPrismaFields(result, FIELDS_NOT_IN_PRISMA), FIELDS_NOT_WRITABLE);
  }

  public toPersistenceChanges(entity: Entities.SummaryMetaEntity): Partial<Models.SummaryMeta> {
    const result = AutoEntityChangeMapper(entity, Models.SummaryMeta, SummaryMetaEntityMapperHandlers.$toPersistence);
    return stripNonWritableFields(stripNonPrismaFields(result, FIELDS_NOT_IN_PRISMA), FIELDS_NOT_WRITABLE);
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
