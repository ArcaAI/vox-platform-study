import { AutoClassMapper, AutoEntityChangeMapper, BaseMapper } from '../../../common';
import * as Entities from '../../../entities';
import * as Models from '../../../models';

/**
 * `AgentTrajectoryStep` keeps `_metadata` / `_version` / `createdBy` /
 * `updatedBy` / `createdAt` / `updatedAt` (all real columns) but has NO
 * `resourceStatus*` columns (ops telemetry, hard retention — see
 * MODELS_WITHOUT_SOFT_DELETE). Two things are stripped before persistence:
 *   1. `resourceStatus*` — inherited from BaseEntity but not backed by a column.
 *   2. `version` — DB-owned OCC token; only `Repository.updateWithVersion`
 *      writes it. It defaults to 1 in the schema, so the create payload must
 *      NOT carry it (kept out of both create and change sets here as defense in
 *      depth on top of the base `updateWithVersion` strip).
 */
const FIELDS_NOT_IN_PRISMA: string[] = ['version', 'resourceStatus', 'resourceStatusUpdatedAt', 'resourceStatusUpdatedBy'];

function stripNonPrismaFields<T extends object>(model: T, fields: string[]): T {
  for (const field of fields) {
    delete (model as Record<string, unknown>)[field];
  }
  return model;
}

export class AgentTrajectoryStepEntityMapper extends BaseMapper<Entities.AgentTrajectoryStepEntity, Models.AgentTrajectoryStep> {
  constructor() {
    super();
  }

  public toPersistence(entity: Entities.AgentTrajectoryStepEntity): Models.AgentTrajectoryStep {
    const result = AutoClassMapper(entity, Models.AgentTrajectoryStep);
    return stripNonPrismaFields(result, FIELDS_NOT_IN_PRISMA);
  }

  public toPersistenceChanges(entity: Entities.AgentTrajectoryStepEntity): Partial<Models.AgentTrajectoryStep> {
    const result = AutoEntityChangeMapper(entity, Models.AgentTrajectoryStep);
    return stripNonPrismaFields(result, FIELDS_NOT_IN_PRISMA);
  }

  public toDomainEntity(dataModel: Models.AgentTrajectoryStep): Entities.AgentTrajectoryStepEntity {
    return AutoClassMapper(dataModel, Entities.AgentTrajectoryStepEntity);
  }
}
