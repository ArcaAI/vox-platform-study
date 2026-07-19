import { AutoClassMapper, AutoEntityChangeMapper, BaseMapper } from '../../../common';
import * as Entities from '../../../entities';
import * as Models from '../../../models';

/**
 * `TranscriptSegment` keeps `_metadata` / `_version` / `createdBy` / `updatedBy`
 * / `createdAt` / `updatedAt` (all real columns) but has NO `resourceStatus*`
 * columns (per-transcript annotation, no soft-delete — see
 * MODELS_WITHOUT_SOFT_DELETE). Two things are stripped before persistence:
 *   1. `resourceStatus*` — inherited from BaseEntity but not backed by a column.
 *   2. `version` — DB-owned OCC token; only `Repository.updateWithVersion`
 *      writes it. It defaults to 1 in the schema, so the create payload must
 *      NOT carry it.
 */
const FIELDS_NOT_IN_PRISMA: string[] = ['version', 'resourceStatus', 'resourceStatusUpdatedAt', 'resourceStatusUpdatedBy'];

function stripNonPrismaFields<T extends object>(model: T, fields: string[]): T {
  for (const field of fields) {
    delete (model as Record<string, unknown>)[field];
  }
  return model;
}

export class TranscriptSegmentEntityMapper extends BaseMapper<Entities.TranscriptSegmentEntity, Models.TranscriptSegment> {
  constructor() {
    super();
  }

  public toPersistence(entity: Entities.TranscriptSegmentEntity): Models.TranscriptSegment {
    const result = AutoClassMapper(entity, Models.TranscriptSegment);
    return stripNonPrismaFields(result, FIELDS_NOT_IN_PRISMA);
  }

  public toPersistenceChanges(entity: Entities.TranscriptSegmentEntity): Partial<Models.TranscriptSegment> {
    const result = AutoEntityChangeMapper(entity, Models.TranscriptSegment);
    return stripNonPrismaFields(result, FIELDS_NOT_IN_PRISMA);
  }

  public toDomainEntity(dataModel: Models.TranscriptSegment): Entities.TranscriptSegmentEntity {
    return AutoClassMapper(dataModel, Entities.TranscriptSegmentEntity);
  }
}
