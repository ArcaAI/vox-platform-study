import { AutoClassMapper, AutoEntityChangeMapper, BaseMapper, createMapperHandlers } from '../../../common';
import * as Entities from '../../../entities';
import * as Models from '../../../models';
import * as Mappers from '../../../mappers';

// TASK-302 Stream D Phase E.5 — `_version` is database-owned (initial
// value at `Prisma.create()` and atomic `version + 1` bump inside the
// repository's Compare-And-Set predicate). Stripping it here on every
// write makes accidental client-supplied `version` payloads no-ops.
const FIELDS_NOT_WRITABLE: string[] = ['version'];

function stripNonWritableFields<T extends object>(model: T, fields: string[]): T {
  for (const field of fields) {
    if (field in model) {
      delete (model as Record<string, unknown>)[field];
    }
  }
  return model;
}

export class WebhookEntityMapper extends BaseMapper<Entities.WebhookEntity, Models.Webhook> {
  constructor() {
    super();
  }

  public toPersistence(entity: Entities.WebhookEntity): Models.Webhook {
    const result = AutoClassMapper(entity, Models.Webhook, WebhookEntityMapperHandlers.$toPersistence);
    return stripNonWritableFields(result, FIELDS_NOT_WRITABLE);
  }

  public toPersistenceChanges(entity: Entities.WebhookEntity): Partial<Models.Webhook> {
    const result = AutoEntityChangeMapper(entity, Models.Webhook, WebhookEntityMapperHandlers.$toPersistence);
    return stripNonWritableFields(result, FIELDS_NOT_WRITABLE);
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
