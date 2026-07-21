import { GlobalSettingEntity } from '@arcaai/domains';
import { TenantConfigResponse, PaginatedTenantConfigResponse } from './dto';
import { FetchResponse } from '../../common';

/**
 * Maps tenant configuration rows — persisted as tenant-scoped `GlobalSetting`
 * entities — into the standalone {@link TenantConfigResponse} DTO.
 *
 * This mapper replaces the fragile
 * `GlobalSettingDtoMapper.ToPaginatedResponse(...) as PaginatedTenantConfigResponse`
 * superset cast used by the tenant-config endpoints. That cast only compiled
 * while `GlobalSettingResponse` stayed structurally assignable-into
 * `TenantConfigResponse`, so any future *required* field on `GlobalSettingResponse`
 * would break `build:api` with `TS2352`. By mapping the underlying entity
 * explicitly, `TenantConfigResponse` is fully decoupled from
 * `GlobalSettingResponse`'s shape and the two DTOs can evolve independently.
 *
 * The mapping is deliberately field-by-field (no `AutoClassMapper` reflection):
 * it surfaces the tenant-facing fields the entity legitimately carries —
 * including `tenantId`, `defaultValue`, and `locked` — rather than whatever
 * happens to structurally overlap with an unrelated response class.
 */
export class TenantConfigDtoMapper {
  static ToResponse(entity: GlobalSettingEntity): TenantConfigResponse {
    return new TenantConfigResponse({
      id: entity.id,
      projectId: null,
      createdAt: entity.createdAt,
      updatedAt: entity.updatedAt,
      resourceStatus: entity.resourceStatus,
      resourceStatusUpdatedAt: entity.resourceStatusUpdatedAt,
      resourceStatusUpdatedBy: entity.resourceStatusUpdatedBy ?? '',
      createdBy: entity.createdBy,
      updatedBy: entity.updatedBy,
      name: entity.name,
      description: entity.description,
      key: entity.key,
      defaultValue: entity.defaultValue,
      value: entity.value,
      dataType: entity.dataType,
      namespace: entity.namespace,
      tenantId: entity.tenantId,
      locked: entity.locked,
      version: entity.version,
    });
  }

  static ToPaginatedResponse({ page, limit, count, data }: FetchResponse<GlobalSettingEntity>): PaginatedTenantConfigResponse {
    return new PaginatedTenantConfigResponse({
      page,
      limit,
      count,
      data: data.map((setting) => this.ToResponse(setting)),
    });
  }
}
