import { AutoClassMapper, AutoEntityChangeMapper, BaseMapper } from '../../../common';
import * as Entities from '../../../entities';
import * as Models from '../../../models';

/**
 * `ProviderReconciliationRun` keeps `_metadata` / `_version` / `createdBy` /
 * `updatedBy` / `createdAt` / `updatedAt` but has NO `resourceStatus*` columns —
 * it is APPEND-ONLY (see MODELS_WITHOUT_SOFT_DELETE in
 * packages/database/src/client.ts). Same strip set as
 * `AiUsageRollupDailyEntityMapper`:
 *   1. `resourceStatus*` — inherited from BaseEntity but not backed by a
 *      column; leaving them in makes Prisma reject every INSERT.
 *   2. `version` — DB-owned OCC token, schema-defaulted to 1, so the create
 *      payload must not carry it.
 */
const FIELDS_NOT_IN_PRISMA: string[] = ['version', 'resourceStatus', 'resourceStatusUpdatedAt', 'resourceStatusUpdatedBy'];

function stripNonPrismaFields<T extends object>(model: T, fields: string[]): T {
  for (const field of fields) {
    delete (model as Record<string, unknown>)[field];
  }
  return model;
}

export class ProviderReconciliationRunEntityMapper extends BaseMapper<
  Entities.ProviderReconciliationRunEntity,
  Models.ProviderReconciliationRun
> {
  constructor() {
    super();
  }

  public toPersistence(entity: Entities.ProviderReconciliationRunEntity): Models.ProviderReconciliationRun {
    const result = AutoClassMapper(entity, Models.ProviderReconciliationRun);
    return stripNonPrismaFields(result, FIELDS_NOT_IN_PRISMA);
  }

  public toPersistenceChanges(entity: Entities.ProviderReconciliationRunEntity): Partial<Models.ProviderReconciliationRun> {
    const result = AutoEntityChangeMapper(entity, Models.ProviderReconciliationRun);
    return stripNonPrismaFields(result, FIELDS_NOT_IN_PRISMA);
  }

  public toDomainEntity(dataModel: Models.ProviderReconciliationRun): Entities.ProviderReconciliationRunEntity {
    return AutoClassMapper(dataModel, Entities.ProviderReconciliationRunEntity);
  }
}
