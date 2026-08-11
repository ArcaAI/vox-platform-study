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

// TASK-635 RF-4 — the six capability-keyed columns (newPatientTemplateId,
// revisitTemplateId, preSummaryTemplateId, livePromptTemplateId, toolConfig,
// llmOverrides) need NO handler entries: `AutoClassMapper`/`AutoEntityChangeMapper`
// map same-named fields automatically (stripping the entity's `_` prefix), which
// is why `harnessOverrides`/`goldenSetId` have no entries either. Only RELATIONS
// need suppression. `FIELDS_NOT_WRITABLE = ['version']` above stays untouched —
// DepartmentAgent is OCC-written, and `gen:mapper` (which would strip that guard)
// is NEVER run.
//
// TASK-659 — the seven loop-configuration columns (role, subscribedKinds,
// writeScope, goal, guardrailProfile, alwaysActions, neverActions) are
// same-named scalar/JSONB fields for the same reason: no handler entry
// needed. `Versions` is a relation and, like `Department`/`PromptTemplate`
// above, is simply never surfaced on `DepartmentAgentEntity` — `AutoClassMapper`
// only iterates fields the entity actually has, so the mapper never touches it
// and no suppression entry is required.
export const DepartmentAgentEntityMapperHandlers = createMapperHandlers<Entities.DepartmentAgentEntity, Models.DepartmentAgent>({
  $toPersistence: {
    // Relations are never written through this mapper.
    Department: () => undefined,
    PromptTemplate: () => undefined,
  },
  $toDomain: {},
});
