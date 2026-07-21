import { AutoClassMapper, AutoEntityChangeMapper, BaseMapper, createMapperHandlers } from '../../../common';
import * as Entities from '../../../entities';
import * as Models from '../../../models';
import * as Mappers from '../../../mappers';

// `_version` is owned by the database and the
// only legitimate writer is `Repository.updateWithVersion`. Strip it from every
// write path here so the auto-mappers cannot leak it into a Prisma update.
// Note: `PromptTemplate` has its own version-history sibling (`PromptVersion`).
// The `_version` column tracked here is the OCC token; `PromptVersion` is the
// human-meaningful version history — they are distinct concepts and must not
// be conflated.
const FIELDS_NOT_WRITABLE: string[] = ['version'];

function stripNonWritableFields<T extends object>(model: T, fields: string[]): T {
  for (const field of fields) {
    delete (model as Record<string, unknown>)[field];
  }
  return model;
}

export class PromptTemplateEntityMapper extends BaseMapper<Entities.PromptTemplateEntity, Models.PromptTemplate> {
  constructor() {
    super();
  }

  public toPersistence(entity: Entities.PromptTemplateEntity): Models.PromptTemplate {
    const result = AutoClassMapper(entity, Models.PromptTemplate, PromptTemplateEntityMapperHandlers.$toPersistence);
    return stripNonWritableFields(result, FIELDS_NOT_WRITABLE);
  }

  public toPersistenceChanges(entity: Entities.PromptTemplateEntity): Partial<Models.PromptTemplate> {
    const result = AutoEntityChangeMapper(entity, Models.PromptTemplate, PromptTemplateEntityMapperHandlers.$toPersistence);
    return stripNonWritableFields(result, FIELDS_NOT_WRITABLE);
  }

  public toDomainEntity(dataModel: Models.PromptTemplate): Entities.PromptTemplateEntity {
    return AutoClassMapper(dataModel, Entities.PromptTemplateEntity, PromptTemplateEntityMapperHandlers.$toDomain);
  }
}

export const PromptTemplateEntityMapperHandlers = createMapperHandlers<Entities.PromptTemplateEntity, Models.PromptTemplate>({
  $toPersistence: {
    // Return the raw ciphertext Buffer directly so the
    // generic auto-mapper does not destructure the typed array.
    encryptedLastTestOutput: (entity) => entity.encryptedLastTestOutput ?? null,
  },
  $toDomain: {
    encryptedLastTestOutput: (model) => model.encryptedLastTestOutput ?? null,
  },
});
