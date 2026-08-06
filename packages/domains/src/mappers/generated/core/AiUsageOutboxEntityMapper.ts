import { AutoClassMapper, AutoEntityChangeMapper, BaseMapper } from '../../../common';
import * as Entities from '../../../entities';
import * as Models from '../../../models';

/**
 * `AiUsageOutbox` keeps `_metadata` / `_version` / `createdBy` / `updatedBy` /
 * `createdAt` / `updatedAt` (all real columns) but has NO `resourceStatus*`
 * columns — it is an APPEND-ONLY row (see MODELS_WITHOUT_SOFT_DELETE in
 * packages/database/src/client.ts). Four fields are stripped before persistence:
 *   1. `resourceStatus*` — inherited from BaseEntity but not backed by a
 *      column; leaving them in makes Prisma reject every INSERT.
 *   2. `version` — DB-owned OCC token; only `Repository.updateWithVersion`
 *      writes it. It defaults to 1 in the schema, so the create payload must NOT
 *      carry it (defense in depth on top of the base `updateWithVersion` strip).
 *
 * Mirrors `AgentTrajectoryStepEntityMapper`. NOTE this is NOT the OCC
 * `FIELDS_NOT_WRITABLE` treatment — that one strips `version` only and belongs
 * to `BillingInvoiceEntityMapper`, the single OCC-written model of this ticket.
 */
const FIELDS_NOT_IN_PRISMA: string[] = ['version', 'resourceStatus', 'resourceStatusUpdatedAt', 'resourceStatusUpdatedBy'];

function stripNonPrismaFields<T extends object>(model: T, fields: string[]): T {
  for (const field of fields) {
    delete (model as Record<string, unknown>)[field];
  }
  return model;
}

export class AiUsageOutboxEntityMapper extends BaseMapper<Entities.AiUsageOutboxEntity, Models.AiUsageOutbox> {
  constructor() {
    super();
  }

  public toPersistence(entity: Entities.AiUsageOutboxEntity): Models.AiUsageOutbox {
    const result = AutoClassMapper(entity, Models.AiUsageOutbox);
    return stripNonPrismaFields(result, FIELDS_NOT_IN_PRISMA);
  }

  public toPersistenceChanges(entity: Entities.AiUsageOutboxEntity): Partial<Models.AiUsageOutbox> {
    const result = AutoEntityChangeMapper(entity, Models.AiUsageOutbox);
    return stripNonPrismaFields(result, FIELDS_NOT_IN_PRISMA);
  }

  public toDomainEntity(dataModel: Models.AiUsageOutbox): Entities.AiUsageOutboxEntity {
    return AutoClassMapper(dataModel, Entities.AiUsageOutboxEntity);
  }
}
