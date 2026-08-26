import { AutoClassMapper, AutoEntityChangeMapper, BaseMapper, createMapperHandlers } from '../../../common';
import * as Entities from '../../../entities';
import * as Models from '../../../models';

// `_version` is owned by the database and the only legitimate writer is
// `Repository.updateWithVersion`. This model IS OCC-written (the admin PATCH
// route carries If-Match), so the strip is load-bearing: without it the
// auto-mappers leak `version` into a Prisma update and every compare-and-set
// silently stops meaning anything. Mirrors `AiTaskDefaultEntityMapper` /
// `ConsultationContextSchemaEntityMapper` — deliberately NOT
// `HarnessPolicyEntityMapper` or `PipelinePolicyEntityMapper`, both of which
// are OCC-written and are MISSING this guard (D-23).
const FIELDS_NOT_WRITABLE: string[] = ['version'];

function stripNonWritableFields<T extends object>(model: T, fields: string[]): T {
  for (const field of fields) {
    delete (model as Record<string, unknown>)[field];
  }
  return model;
}

export class DocumentTemplateEntityMapper extends BaseMapper<Entities.DocumentTemplateEntity, Models.DocumentTemplate> {
  constructor() {
    super();
  }

  public toPersistence(entity: Entities.DocumentTemplateEntity): Models.DocumentTemplate {
    const result = AutoClassMapper(entity, Models.DocumentTemplate, DocumentTemplateEntityMapperHandlers.$toPersistence);
    return stripNonWritableFields(result, FIELDS_NOT_WRITABLE);
  }

  public toPersistenceChanges(entity: Entities.DocumentTemplateEntity): Partial<Models.DocumentTemplate> {
    const result = AutoEntityChangeMapper(entity, Models.DocumentTemplate, DocumentTemplateEntityMapperHandlers.$toPersistence);
    return stripNonWritableFields(result, FIELDS_NOT_WRITABLE);
  }

  public toDomainEntity(dataModel: Models.DocumentTemplate): Entities.DocumentTemplateEntity {
    return AutoClassMapper(dataModel, Entities.DocumentTemplateEntity, DocumentTemplateEntityMapperHandlers.$toDomain);
  }
}

export const DocumentTemplateEntityMapperHandlers = createMapperHandlers<Entities.DocumentTemplateEntity, Models.DocumentTemplate>({
  $toPersistence: {},
  $toDomain: {},
});
