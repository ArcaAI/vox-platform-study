import { AutoClassMapper, AutoEntityChangeMapper, BaseMapper, createMapperHandlers } from '../../../common';
import * as Entities from '../../../entities';
import * as Models from '../../../models';
import * as Mappers from '../../../mappers';

export class WebhookEntityMapper extends BaseMapper<Entities.WebhookEntity, Models.Webhook> {
  constructor() {
    super();
  }

  public toPersistence(entity: Entities.WebhookEntity): Models.Webhook {
    return AutoClassMapper(entity, Models.Webhook, WebhookEntityMapperHandlers.$toPersistence);
  }

  public toPersistenceChanges(entity: Entities.WebhookEntity): Partial<Models.Webhook> {
    return AutoEntityChangeMapper(entity, Models.Webhook, WebhookEntityMapperHandlers.$toPersistence);
  }

  public toDomainEntity(dataModel: Models.Webhook): Entities.WebhookEntity {
    return AutoClassMapper(dataModel, Entities.WebhookEntity, WebhookEntityMapperHandlers.$toDomain);
  }
}

export const WebhookEntityMapperHandlers = createMapperHandlers<Entities.WebhookEntity, Models.Webhook>({
  $toPersistence: {},
  $toDomain: {
    WebhookRunHistorys: (obj: Models.Webhook) =>
      obj.WebhookRunHistorys?.map((item) => Mappers.WebhookRunHistoryEntityMapper.getInstance().toDomainEntity(item)) || [],
  },
});
