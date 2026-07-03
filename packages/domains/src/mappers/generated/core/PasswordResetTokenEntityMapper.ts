import { AutoClassMapper, AutoEntityChangeMapper, BaseMapper, createMapperHandlers } from '../../../common';
import * as Entities from '../../../entities';
import * as Models from '../../../models';

// `_version` is DB-owned (only `Repository.updateWithVersion` may write it) —
// strip it from every write path, mirroring `PlanEntitlementEntityMapper`.
const FIELDS_NOT_WRITABLE: string[] = ['version'];

function stripNonWritableFields<T extends object>(model: T, fields: string[]): T {
  for (const field of fields) {
    delete (model as Record<string, unknown>)[field];
  }
  return model;
}

export class PasswordResetTokenEntityMapper extends BaseMapper<Entities.PasswordResetTokenEntity, Models.PasswordResetToken> {
  constructor() {
    super();
  }

  public toPersistence(entity: Entities.PasswordResetTokenEntity): Models.PasswordResetToken {
    const result = AutoClassMapper(entity, Models.PasswordResetToken, PasswordResetTokenEntityMapperHandlers.$toPersistence);
    return stripNonWritableFields(result, FIELDS_NOT_WRITABLE);
  }

  public toPersistenceChanges(entity: Entities.PasswordResetTokenEntity): Partial<Models.PasswordResetToken> {
    const result = AutoEntityChangeMapper(entity, Models.PasswordResetToken, PasswordResetTokenEntityMapperHandlers.$toPersistence);
    return stripNonWritableFields(result, FIELDS_NOT_WRITABLE);
  }

  public toDomainEntity(dataModel: Models.PasswordResetToken): Entities.PasswordResetTokenEntity {
    return AutoClassMapper(dataModel, Entities.PasswordResetTokenEntity, PasswordResetTokenEntityMapperHandlers.$toDomain);
  }
}

export const PasswordResetTokenEntityMapperHandlers = createMapperHandlers<Entities.PasswordResetTokenEntity, Models.PasswordResetToken>({
  $toPersistence: {},
  $toDomain: {},
});
