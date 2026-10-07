import { AutoClassMapper, AutoEntityChangeMapper, BaseMapper, createMapperHandlers } from '../../../common';
import * as Entities from '../../../entities';
import * as Models from '../../../models';

// TASK-1050 — `GuardrailNotice` is OCC-written (acknowledge / resolve / approve race on it), so
// rule 03 requires the `_version` strip; it has no `resourceStatus*` columns
// (MODELS_WITHOUT_SOFT_DELETE), which are stripped too.
const FIELDS_NOT_WRITABLE: string[] = ['version', 'resourceStatus', 'resourceStatusUpdatedAt', 'resourceStatusUpdatedBy'];

function stripNonWritableFields<T extends object>(model: T, fields: string[]): T {
  for (const field of fields) {
    delete (model as Record<string, unknown>)[field];
  }
  return model;
}

export class GuardrailNoticeEntityMapper extends BaseMapper<Entities.GuardrailNoticeEntity, Models.GuardrailNotice> {
  constructor() {
    super();
  }

  public toPersistence(entity: Entities.GuardrailNoticeEntity): Models.GuardrailNotice {
    const result = AutoClassMapper(entity, Models.GuardrailNotice, GuardrailNoticeEntityMapperHandlers.$toPersistence);
    return stripNonWritableFields(result, FIELDS_NOT_WRITABLE);
  }

  public toPersistenceChanges(entity: Entities.GuardrailNoticeEntity): Partial<Models.GuardrailNotice> {
    const result = AutoEntityChangeMapper(entity, Models.GuardrailNotice, GuardrailNoticeEntityMapperHandlers.$toPersistence);
    return stripNonWritableFields(result, FIELDS_NOT_WRITABLE);
  }

  public toDomainEntity(dataModel: Models.GuardrailNotice): Entities.GuardrailNoticeEntity {
    return AutoClassMapper(dataModel, Entities.GuardrailNoticeEntity, GuardrailNoticeEntityMapperHandlers.$toDomain);
  }
}

export const GuardrailNoticeEntityMapperHandlers = createMapperHandlers<Entities.GuardrailNoticeEntity, Models.GuardrailNotice>({
  $toPersistence: {},
  $toDomain: {},
});
