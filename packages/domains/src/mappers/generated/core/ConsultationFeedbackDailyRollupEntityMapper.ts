import { AutoClassMapper, AutoEntityChangeMapper, BaseMapper, createMapperHandlers } from '../../../common';
import * as Entities from '../../../entities';
import * as Models from '../../../models';

// `ConsultationFeedbackDailyRollup` is derived data: no `_metadata`,
// `_version`, audit or `resourceStatus*` columns — all stripped.
const FIELDS_NOT_WRITABLE: string[] = [
  'metaData',
  'version',
  'createdBy',
  'updatedBy',
  'createdAt',
  'updatedAt',
  'resourceStatus',
  'resourceStatusUpdatedAt',
  'resourceStatusUpdatedBy',
];

function stripNonWritableFields<T extends object>(model: T, fields: string[]): T {
  for (const field of fields) {
    delete (model as Record<string, unknown>)[field];
  }
  return model;
}

export class ConsultationFeedbackDailyRollupEntityMapper extends BaseMapper<
  Entities.ConsultationFeedbackDailyRollupEntity,
  Models.ConsultationFeedbackDailyRollup
> {
  constructor() {
    super();
  }

  public toPersistence(entity: Entities.ConsultationFeedbackDailyRollupEntity): Models.ConsultationFeedbackDailyRollup {
    const result = AutoClassMapper(
      entity,
      Models.ConsultationFeedbackDailyRollup,
      ConsultationFeedbackDailyRollupEntityMapperHandlers.$toPersistence,
    );
    return stripNonWritableFields(result, FIELDS_NOT_WRITABLE);
  }

  public toPersistenceChanges(entity: Entities.ConsultationFeedbackDailyRollupEntity): Partial<Models.ConsultationFeedbackDailyRollup> {
    const result = AutoEntityChangeMapper(
      entity,
      Models.ConsultationFeedbackDailyRollup,
      ConsultationFeedbackDailyRollupEntityMapperHandlers.$toPersistence,
    );
    return stripNonWritableFields(result, FIELDS_NOT_WRITABLE);
  }

  public toDomainEntity(dataModel: Models.ConsultationFeedbackDailyRollup): Entities.ConsultationFeedbackDailyRollupEntity {
    return AutoClassMapper(dataModel, Entities.ConsultationFeedbackDailyRollupEntity, ConsultationFeedbackDailyRollupEntityMapperHandlers.$toDomain);
  }
}

export const ConsultationFeedbackDailyRollupEntityMapperHandlers = createMapperHandlers<
  Entities.ConsultationFeedbackDailyRollupEntity,
  Models.ConsultationFeedbackDailyRollup
>({
  $toPersistence: {},
  $toDomain: {},
});
