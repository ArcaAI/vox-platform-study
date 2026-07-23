import { AutoClassMapper, AutoEntityChangeMapper, BaseMapper, createMapperHandlers } from '../../../common';
import * as Entities from '../../../entities';
import * as Models from '../../../models';

// `_version` is owned by the database and the only legitimate writer is
// `Repository.updateWithVersion` (the OCC Compare-And-Set). Strip it from every
// write path here so the auto-mappers cannot leak it into a Prisma update.
// DepartmentAgent IS OCC-written (versioned PATCH route), so this guard is
// mandatory. Mirrors the `AiTaskDefaultEntityMapper` / `AsrPipelineEntityMapper`
// treatment.
const FIELDS_NOT_WRITABLE: string[] = ['version'];

function stripNonWritableFields<T extends object>(model: T, fields: string[]): T {
  for (const field of fields) {
    if (field in model) {
      delete (model as Record<string, unknown>)[field];
    }
  }
  return model;
}

export class DepartmentAgentEntityMapper extends BaseMapper<Entities.DepartmentAgentEntity, Models.DepartmentAgent> {
  constructor() {
    super();
  }

  public toPersistence(entity: Entities.DepartmentAgentEntity): Models.DepartmentAgent {
    const result = AutoClassMapper(entity, Models.DepartmentAgent, DepartmentAgentEntityMapperHandlers.$toPersistence);
    return stripNonWritableFields(result, FIELDS_NOT_WRITABLE);
  }

  public toPersistenceChanges(entity: Entities.DepartmentAgentEntity): Partial<Models.DepartmentAgent> {
    const result = AutoEntityChangeMapper(entity, Models.DepartmentAgent, DepartmentAgentEntityMapperHandlers.$toPersistence);
    return stripNonWritableFields(result, FIELDS_NOT_WRITABLE);
  }

  public toDomainEntity(dataModel: Models.DepartmentAgent): Entities.DepartmentAgentEntity {
    return AutoClassMapper(dataModel, Entities.DepartmentAgentEntity, DepartmentAgentEntityMapperHandlers.$toDomain);
  }
}

export const DepartmentAgentEntityMapperHandlers = createMapperHandlers<Entities.DepartmentAgentEntity, Models.DepartmentAgent>({
  $toPersistence: {
    // Relations are never written through this mapper.
    Department: () => undefined,
    PromptTemplate: () => undefined,
  },
  $toDomain: {},
});
