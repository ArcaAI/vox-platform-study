import { AutoClassMapper, AutoEntityChangeMapper, BaseMapper, createMapperHandlers } from '../../../common';
import * as Entities from '../../../entities';
import * as Models from '../../../models';

// UserChangelogAcknowledgement rows are immutable acknowledgement facts,
// machine-written by the changelog service, never human-edited — non-OCC, no
// `FIELDS_NOT_WRITABLE` strip needed (contrast `ChangelogEntryEntityMapper`,
// the one human-edited model in this registry).
export class UserChangelogAcknowledgementEntityMapper extends BaseMapper<
  Entities.UserChangelogAcknowledgementEntity,
  Models.UserChangelogAcknowledgement
> {
  constructor() {
    super();
  }

  public toPersistence(entity: Entities.UserChangelogAcknowledgementEntity): Models.UserChangelogAcknowledgement {
    return AutoClassMapper(entity, Models.UserChangelogAcknowledgement, UserChangelogAcknowledgementEntityMapperHandlers.$toPersistence);
  }

  public toPersistenceChanges(entity: Entities.UserChangelogAcknowledgementEntity): Partial<Models.UserChangelogAcknowledgement> {
    return AutoEntityChangeMapper(entity, Models.UserChangelogAcknowledgement, UserChangelogAcknowledgementEntityMapperHandlers.$toPersistence);
  }

  public toDomainEntity(dataModel: Models.UserChangelogAcknowledgement): Entities.UserChangelogAcknowledgementEntity {
    return AutoClassMapper(dataModel, Entities.UserChangelogAcknowledgementEntity, UserChangelogAcknowledgementEntityMapperHandlers.$toDomain);
  }
}

export const UserChangelogAcknowledgementEntityMapperHandlers = createMapperHandlers<
  Entities.UserChangelogAcknowledgementEntity,
  Models.UserChangelogAcknowledgement
>({
  $toPersistence: {},
  $toDomain: {},
});
