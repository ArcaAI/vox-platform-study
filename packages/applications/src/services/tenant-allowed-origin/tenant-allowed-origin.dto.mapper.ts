import { SYSTEM_TENANT_ID, TenantAllowedOriginEntity } from '@arcaai/domains';
import { TenantAllowedOriginResponse } from './dto';

export class TenantAllowedOriginDtoMapper {
  static toResponse(entity: TenantAllowedOriginEntity): TenantAllowedOriginResponse {
    return {
      id: entity.id,
      tenantId: entity.tenantId,
      // Derived, not persisted ("prefer omitting [from the entity]").
      // The reserved SYSTEM tenant owns platform-operated origins and is
      // valid for every tenant — the OriginRegistryService/BindingGuard fan-out
      // rule, surfaced here purely as a display convenience.
      isPlatform: entity.tenantId === SYSTEM_TENANT_ID,
      origin: entity.origin,
      label: entity.label,
      description: entity.description ?? undefined,
      resourceStatus: entity.resourceStatus ?? undefined,
      createdAt: entity.createdAt.toISOString(),
      updatedAt: entity.updatedAt.toISOString(),
      version: entity.version,
    };
  }
}
