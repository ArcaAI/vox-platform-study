import { TenantSttConfigEntity } from '@arcaai/domains';
import { TenantSttConfigResponse } from './dto';

/** Read the persisted `consecutiveFailureThreshold` out of `configJson` (if any). */
function thresholdOf(entity: TenantSttConfigEntity): number | null {
  const raw = entity.configJson?.['consecutiveFailureThreshold'];
  return typeof raw === 'number' ? raw : null;
}

export class TenantSttConfigDtoMapper {
  static toResponse(entity: TenantSttConfigEntity): TenantSttConfigResponse {
    return {
      tenantId: entity.tenantId,
      fallbackPipelineId: entity.fallbackPipelineId ?? null,
      autoSwitchEnabled: entity.autoSwitchEnabled,
      consecutiveFailureThreshold: thresholdOf(entity),
      configJson: entity.configJson ?? null,
      resourceStatus: entity.resourceStatus ?? undefined,
      version: entity.version,
      createdAt: entity.createdAt?.toISOString(),
      updatedAt: entity.updatedAt?.toISOString(),
    };
  }

  /**
   * Placeholder for a tenant with no row yet: an all-inherit spec at version 0.
   * The client GETs this, then PUTs with `expectedVersion: 0` (`If-Match: "0"`)
   * to create the row.
   */
  static placeholder(tenantId: string): TenantSttConfigResponse {
    return {
      tenantId,
      fallbackPipelineId: null,
      autoSwitchEnabled: true,
      consecutiveFailureThreshold: null,
      configJson: null,
      version: 0,
    };
  }
}
