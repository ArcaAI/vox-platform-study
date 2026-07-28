import { AutoClassMapper, AutoEntityChangeMapper, BaseMapper, createMapperHandlers } from '../../../common';
import * as Entities from '../../../entities';
import * as Models from '../../../models';

// HAND-AUTHORED (the `gen:mapper` generator crashes pre-existingly, stripping
// this very guard before it dies; see the AiProviderConnectionEntityMapper /
// AiTaskDefaultEntityMapper precedents in this folder).
//
// `_version` is owned by the database and the only legitimate writer is
// `Repository.updateWithVersion`. Strip it from every write path here so the
// auto-mappers cannot leak it into a Prisma update. TenantSttProviderCredential
// IS OCC-written (versioned PUT routes) — unlike the TTS credential mapper,
// which omits the strip (TASK-526 divergence, mirrored by TASK-567).
const FIELDS_NOT_WRITABLE: string[] = ['version'];

function stripNonWritableFields<T extends object>(model: T, fields: string[]): T {
  for (const field of fields) delete (model as Record<string, unknown>)[field];
  return model;
}

export class TenantSttProviderCredentialEntityMapper extends BaseMapper<
  Entities.TenantSttProviderCredentialEntity,
  Models.TenantSttProviderCredential
> {
  constructor() {
    super();
  }

  public toPersistence(
    entity: Entities.TenantSttProviderCredentialEntity,
  ): Models.TenantSttProviderCredential {
    const result = AutoClassMapper(
      entity,
      Models.TenantSttProviderCredential,
      TenantSttProviderCredentialEntityMapperHandlers.$toPersistence,
    );
    return stripNonWritableFields(result, FIELDS_NOT_WRITABLE);
  }

  public toPersistenceChanges(
    entity: Entities.TenantSttProviderCredentialEntity,
  ): Partial<Models.TenantSttProviderCredential> {
    const result = AutoEntityChangeMapper(
      entity,
      Models.TenantSttProviderCredential,
      TenantSttProviderCredentialEntityMapperHandlers.$toPersistence,
    );
    return stripNonWritableFields(result, FIELDS_NOT_WRITABLE);
  }

  public toDomainEntity(
    dataModel: Models.TenantSttProviderCredential,
  ): Entities.TenantSttProviderCredentialEntity {
    return AutoClassMapper(
      dataModel,
      Entities.TenantSttProviderCredentialEntity,
      TenantSttProviderCredentialEntityMapperHandlers.$toDomain,
    );
  }
}

export const TenantSttProviderCredentialEntityMapperHandlers = createMapperHandlers<
  Entities.TenantSttProviderCredentialEntity,
  Models.TenantSttProviderCredential
>({
  $toPersistence: {},
  $toDomain: {},
});
