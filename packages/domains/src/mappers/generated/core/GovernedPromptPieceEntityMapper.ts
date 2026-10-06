import { AutoClassMapper, AutoEntityChangeMapper, BaseMapper, createMapperHandlers } from '../../../common';
import * as Entities from '../../../entities';
import * as Models from '../../../models';

// `_version` is owned by the database. The registry is upserted (not OCC-written), but the strip
// costs nothing and keeps the auto-mappers from ever leaking the counter into a write. NOTE —
// `policyVersion` is a real column (guardrail's policy version) and is NOT stripped.
const FIELDS_NOT_WRITABLE: string[] = ['version'];

function stripNonWritableFields<T extends object>(model: T, fields: string[]): T {
  for (const field of fields) {
    delete (model as Record<string, unknown>)[field];
  }
  return model;
}

export class GovernedPromptPieceEntityMapper extends BaseMapper<Entities.GovernedPromptPieceEntity, Models.GovernedPromptPiece> {
  constructor() {
    super();
  }

  public toPersistence(entity: Entities.GovernedPromptPieceEntity): Models.GovernedPromptPiece {
    const result = AutoClassMapper(entity, Models.GovernedPromptPiece, GovernedPromptPieceEntityMapperHandlers.$toPersistence);
    return stripNonWritableFields(result, FIELDS_NOT_WRITABLE);
  }

  public toPersistenceChanges(entity: Entities.GovernedPromptPieceEntity): Partial<Models.GovernedPromptPiece> {
    const result = AutoEntityChangeMapper(entity, Models.GovernedPromptPiece, GovernedPromptPieceEntityMapperHandlers.$toPersistence);
    return stripNonWritableFields(result, FIELDS_NOT_WRITABLE);
  }

  public toDomainEntity(dataModel: Models.GovernedPromptPiece): Entities.GovernedPromptPieceEntity {
    return AutoClassMapper(dataModel, Entities.GovernedPromptPieceEntity, GovernedPromptPieceEntityMapperHandlers.$toDomain);
  }
}

export const GovernedPromptPieceEntityMapperHandlers = createMapperHandlers<Entities.GovernedPromptPieceEntity, Models.GovernedPromptPiece>({
  $toPersistence: {},
  $toDomain: {},
});
