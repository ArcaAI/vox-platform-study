import { AutoClassMapper, AutoEntityChangeMapper, BaseMapper, createMapperHandlers } from '../../../common';
import * as Entities from '../../../entities';
import * as Models from '../../../models';

// `ConsultationApproval` is append-only: no `_version`, no `createdBy` /
// `updatedBy` / `updatedAt`, no `resourceStatus*` columns. All are
// stripped; the row is only ever created.
const FIELDS_NOT_WRITABLE: string[] = [
  'version',
  'createdBy',
  'updatedBy',
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

export class ConsultationApprovalEntityMapper extends BaseMapper<Entities.ConsultationApprovalEntity, Models.ConsultationApproval> {
  constructor() {
    super();
  }

  public toPersistence(entity: Entities.ConsultationApprovalEntity): Models.ConsultationApproval {
    const result = AutoClassMapper(entity, Models.ConsultationApproval, ConsultationApprovalEntityMapperHandlers.$toPersistence);
    return stripNonWritableFields(result, FIELDS_NOT_WRITABLE);
  }

  public toPersistenceChanges(entity: Entities.ConsultationApprovalEntity): Partial<Models.ConsultationApproval> {
    const result = AutoEntityChangeMapper(entity, Models.ConsultationApproval, ConsultationApprovalEntityMapperHandlers.$toPersistence);
    return stripNonWritableFields(result, FIELDS_NOT_WRITABLE);
  }

  public toDomainEntity(dataModel: Models.ConsultationApproval): Entities.ConsultationApprovalEntity {
    return AutoClassMapper(dataModel, Entities.ConsultationApprovalEntity, ConsultationApprovalEntityMapperHandlers.$toDomain);
  }
}

export const ConsultationApprovalEntityMapperHandlers = createMapperHandlers<Entities.ConsultationApprovalEntity, Models.ConsultationApproval>({
  $toPersistence: {},
  $toDomain: {},
});
