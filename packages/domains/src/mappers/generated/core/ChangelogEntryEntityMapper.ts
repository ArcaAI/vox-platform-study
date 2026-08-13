import { AutoClassMapper, AutoEntityChangeMapper, BaseMapper, createMapperHandlers } from '../../../common';
import * as Entities from '../../../entities';
import * as Models from '../../../models';

// ChangelogEntry is the ONE human-edited model in the Service Version &
// Release Registry — the "What's New" curated release notes. It
// carries real OCC: `_version` is owned by the database and the only
// legitimate writer is `Repository.updateWithVersion`. Strip it from every
// write path here so the auto-mappers cannot leak it into a Prisma update.
// Mirrors the `DepartmentEntityMapper` / `AiTaskDefaultEntityMapper`
// treatment. Contrast `ServiceReleaseEntityMapper` / `ServiceInstanceEntityMapper`
// / `UserChangelogAcknowledgementEntityMapper`, which are machine-written and
// non-OCC and therefore do NOT strip `version`.
const FIELDS_NOT_WRITABLE: string[] = ['version'];

function stripNonWritableFields<T extends object>(model: T, fields: string[]): T {
  for (const field of fields) {
    delete (model as Record<string, unknown>)[field];
  }
  return model;
}

export class ChangelogEntryEntityMapper extends BaseMapper<Entities.ChangelogEntryEntity, Models.ChangelogEntry> {
  constructor() {
    super();
  }

  public toPersistence(entity: Entities.ChangelogEntryEntity): Models.ChangelogEntry {
    const result = AutoClassMapper(entity, Models.ChangelogEntry, ChangelogEntryEntityMapperHandlers.$toPersistence);
    return stripNonWritableFields(result, FIELDS_NOT_WRITABLE);
  }

  public toPersistenceChanges(entity: Entities.ChangelogEntryEntity): Partial<Models.ChangelogEntry> {
    const result = AutoEntityChangeMapper(entity, Models.ChangelogEntry, ChangelogEntryEntityMapperHandlers.$toPersistence);
    return stripNonWritableFields(result, FIELDS_NOT_WRITABLE);
  }

  public toDomainEntity(dataModel: Models.ChangelogEntry): Entities.ChangelogEntryEntity {
    return AutoClassMapper(dataModel, Entities.ChangelogEntryEntity, ChangelogEntryEntityMapperHandlers.$toDomain);
  }
}

export const ChangelogEntryEntityMapperHandlers = createMapperHandlers<Entities.ChangelogEntryEntity, Models.ChangelogEntry>({
  $toPersistence: {},
  $toDomain: {},
});
