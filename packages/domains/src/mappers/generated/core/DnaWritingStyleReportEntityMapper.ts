import { AutoClassMapper, AutoEntityChangeMapper, BaseMapper, createMapperHandlers } from '../../../common';
import * as Entities from '../../../entities';
import * as Models from '../../../models';
import * as Mappers from '../../../mappers';

// TASK-326 X7 / D-2 — `_version` is owned by the database and the only
// legitimate writer is `Repository.updateWithVersion`. Strip it from every
// write path here so the auto-mappers cannot leak it into a Prisma update.
// Mirrors the E.2 / E.3 treatment on `DepartmentEntityMapper` and
// `PromptTemplateEntityMapper`. Note: the `_version` OCC token is DISTINCT
// from `currentVersionNumber` / the `DnaWritingStyleVersion` history — they
// are distinct concepts and must not be conflated.
const FIELDS_NOT_WRITABLE: string[] = ['version'];

function stripNonWritableFields<T extends object>(model: T, fields: string[]): T {
  for (const field of fields) {
    delete (model as Record<string, unknown>)[field];
  }
  return model;
}

export class DnaWritingStyleReportEntityMapper extends BaseMapper<Entities.DnaWritingStyleReportEntity, Models.DnaWritingStyleReport> {
  constructor() {
    super();
  }

  public toPersistence(entity: Entities.DnaWritingStyleReportEntity): Models.DnaWritingStyleReport {
    const result = AutoClassMapper(entity, Models.DnaWritingStyleReport, DnaWritingStyleReportEntityMapperHandlers.$toPersistence);
    return stripNonWritableFields(result, FIELDS_NOT_WRITABLE);
  }

  public toPersistenceChanges(entity: Entities.DnaWritingStyleReportEntity): Partial<Models.DnaWritingStyleReport> {
    const result = AutoEntityChangeMapper(entity, Models.DnaWritingStyleReport, DnaWritingStyleReportEntityMapperHandlers.$toPersistence);
    return stripNonWritableFields(result, FIELDS_NOT_WRITABLE);
  }

  public toDomainEntity(dataModel: Models.DnaWritingStyleReport): Entities.DnaWritingStyleReportEntity {
    return AutoClassMapper(dataModel, Entities.DnaWritingStyleReportEntity, DnaWritingStyleReportEntityMapperHandlers.$toDomain);
  }
}

export const DnaWritingStyleReportEntityMapperHandlers = createMapperHandlers<Entities.DnaWritingStyleReportEntity, Models.DnaWritingStyleReport>({
  $toPersistence: {},
  $toDomain: {},
});
