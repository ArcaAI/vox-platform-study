import { AutoClassMapper, AutoEntityChangeMapper, BaseMapper, createMapperHandlers } from '../../../common';
import * as Entities from '../../../entities';
import * as Models from '../../../models';

// HAND-AUTHORED (the `gen:mapper` generator crashes pre-existingly, stripping
// this very guard before it dies; see the AiProviderConnectionEntityMapper /
// TenantSttConfigEntityMapper precedents in this folder).
//
// `_version` is owned by the database and the only legitimate writer is
// `Repository.updateWithVersion`. Strip it from every write path here so the
// auto-mappers cannot leak it into a Prisma update. TenantGuardrailPolicy IS
// OCC-written (the versioned `PUT /admin/guardrail/availability/:tenantId`).
const FIELDS_NOT_WRITABLE: string[] = ['version'];

function stripNonWritableFields<T extends object>(model: T, fields: string[]): T {
  for (const field of fields) delete (model as Record<string, unknown>)[field];
  return model;
}

export class TenantGuardrailPolicyEntityMapper extends BaseMapper<Entities.TenantGuardrailPolicyEntity, Models.TenantGuardrailPolicy> {
  constructor() {
    super();
  }

  public toPersistence(entity: Entities.TenantGuardrailPolicyEntity): Models.TenantGuardrailPolicy {
    const result = AutoClassMapper(entity, Models.TenantGuardrailPolicy, TenantGuardrailPolicyEntityMapperHandlers.$toPersistence);
    return stripNonWritableFields(result, FIELDS_NOT_WRITABLE);
  }

  public toPersistenceChanges(entity: Entities.TenantGuardrailPolicyEntity): Partial<Models.TenantGuardrailPolicy> {
    const result = AutoEntityChangeMapper(entity, Models.TenantGuardrailPolicy, TenantGuardrailPolicyEntityMapperHandlers.$toPersistence);
    return stripNonWritableFields(result, FIELDS_NOT_WRITABLE);
  }

  public toDomainEntity(dataModel: Models.TenantGuardrailPolicy): Entities.TenantGuardrailPolicyEntity {
    return AutoClassMapper(dataModel, Entities.TenantGuardrailPolicyEntity, TenantGuardrailPolicyEntityMapperHandlers.$toDomain);
  }
}

export const TenantGuardrailPolicyEntityMapperHandlers = createMapperHandlers<
  Entities.TenantGuardrailPolicyEntity,
  Models.TenantGuardrailPolicy
>({
  $toPersistence: {},
  $toDomain: {},
});
