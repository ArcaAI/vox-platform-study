import { AutoClassMapper, AutoEntityChangeMapper, BaseMapper, createMapperHandlers } from '../../../common';
import * as Entities from '../../../entities';
import * as Models from '../../../models';

// HAND-AUTHORED (TASK-864; the `gen:mapper` generator is destructive — rule 03). Mirrors the
// `AiProviderConnectionEntityMapper` precedent: `_version` is owned by the database and its only
// legitimate writer is `Repository.updateWithVersion` (rotation is an OCC write), so it is
// stripped from every write path here.
const FIELDS_NOT_WRITABLE: string[] = ['version'];

function stripNonWritableFields<T extends object>(model: T, fields: string[]): T {
  for (const field of fields) delete (model as Record<string, unknown>)[field];
  return model;
}

export class WorkflowWebhookSecretEntityMapper extends BaseMapper<Entities.WorkflowWebhookSecretEntity, Models.WorkflowWebhookSecret> {
  constructor() {
    super();
  }

  public toPersistence(entity: Entities.WorkflowWebhookSecretEntity): Models.WorkflowWebhookSecret {
    const result = AutoClassMapper(entity, Models.WorkflowWebhookSecret, WorkflowWebhookSecretEntityMapperHandlers.$toPersistence);
    return stripNonWritableFields(result, FIELDS_NOT_WRITABLE);
  }

  public toPersistenceChanges(entity: Entities.WorkflowWebhookSecretEntity): Partial<Models.WorkflowWebhookSecret> {
    const result = AutoEntityChangeMapper(entity, Models.WorkflowWebhookSecret, WorkflowWebhookSecretEntityMapperHandlers.$toPersistence);
    return stripNonWritableFields(result, FIELDS_NOT_WRITABLE);
  }

  public toDomainEntity(dataModel: Models.WorkflowWebhookSecret): Entities.WorkflowWebhookSecretEntity {
    return AutoClassMapper(dataModel, Entities.WorkflowWebhookSecretEntity, WorkflowWebhookSecretEntityMapperHandlers.$toDomain);
  }
}

export const WorkflowWebhookSecretEntityMapperHandlers = createMapperHandlers<Entities.WorkflowWebhookSecretEntity, Models.WorkflowWebhookSecret>({
  $toPersistence: {},
  $toDomain: {},
});
