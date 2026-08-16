import { AutoClassMapper, AutoEntityChangeMapper, BaseMapper } from '../../../common';
import * as Entities from '../../../entities';
import * as Models from '../../../models';

/**
 * `WorkflowRun` keeps `_metadata` / `_version` / `createdBy` / `updatedBy` /
 * `createdAt` / `updatedAt` (all real columns) but has NO `resourceStatus*`
 * columns (ops telemetry — see MODELS_WITHOUT_SOFT_DELETE), the exact posture
 * as `AgentTrajectoryStepEntityMapper`. Two things are stripped before
 * persistence:
 *   1. `resourceStatus*` — inherited from BaseEntity but not backed by a column.
 *   2. `version` — DB-owned OCC token; only `Repository.updateWithVersion`
 *      writes it. Kept out of both create and change sets here as defense in
 *      depth on top of the base `updateWithVersion` strip (rule 03's
 *      `FIELDS_NOT_WRITABLE` requirement).
 */
const FIELDS_NOT_IN_PRISMA: string[] = ['version', 'resourceStatus', 'resourceStatusUpdatedAt', 'resourceStatusUpdatedBy'];

function stripNonPrismaFields<T extends object>(model: T, fields: string[]): T {
  for (const field of fields) {
    delete (model as Record<string, unknown>)[field];
  }
  return model;
}

export class WorkflowRunEntityMapper extends BaseMapper<Entities.WorkflowRunEntity, Models.WorkflowRun> {
  constructor() {
    super();
  }

  public toPersistence(entity: Entities.WorkflowRunEntity): Models.WorkflowRun {
    const result = AutoClassMapper(entity, Models.WorkflowRun);
    return stripNonPrismaFields(result, FIELDS_NOT_IN_PRISMA);
  }

  public toPersistenceChanges(entity: Entities.WorkflowRunEntity): Partial<Models.WorkflowRun> {
    const result = AutoEntityChangeMapper(entity, Models.WorkflowRun);
    return stripNonPrismaFields(result, FIELDS_NOT_IN_PRISMA);
  }

  public toDomainEntity(dataModel: Models.WorkflowRun): Entities.WorkflowRunEntity {
    return AutoClassMapper(dataModel, Entities.WorkflowRunEntity);
  }
}
