import { AutoClassMapper, AutoEntityChangeMapper, BaseMapper, createMapperHandlers } from '../../../common';
import * as Entities from '../../../entities';
import * as Models from '../../../models';
import * as Mappers from '../../../mappers';

export class WebhookRunHistoryEntityMapper extends BaseMapper<Entities.WebhookRunHistoryEntity, Models.WebhookRunHistory> {
  constructor() {
    super();
  }

  public toPersistence(entity: Entities.WebhookRunHistoryEntity): Models.WebhookRunHistory {
    return AutoClassMapper(entity, Models.WebhookRunHistory, WebhookRunHistoryEntityMapperHandlers.$toPersistence);
  }

  public toPersistenceChanges(entity: Entities.WebhookRunHistoryEntity): Partial<Models.WebhookRunHistory> {
    return AutoEntityChangeMapper(entity, Models.WebhookRunHistory, WebhookRunHistoryEntityMapperHandlers.$toPersistence);
  }

  public toDomainEntity(dataModel: Models.WebhookRunHistory): Entities.WebhookRunHistoryEntity {
    return AutoClassMapper(dataModel, Entities.WebhookRunHistoryEntity, WebhookRunHistoryEntityMapperHandlers.$toDomain);
  }
}

export const WebhookRunHistoryEntityMapperHandlers = createMapperHandlers<Entities.WebhookRunHistoryEntity, Models.WebhookRunHistory>({
  $toPersistence: {
    webhookId: (obj: Entities.WebhookRunHistoryEntity) => obj.Webhook?.id || null,
  },
  $toDomain: {
    Webhook: (obj: Models.WebhookRunHistory) => (obj.Webhook ? Mappers.WebhookEntityMapper.getInstance().toDomainEntity(obj.Webhook) : null),
  },
});
