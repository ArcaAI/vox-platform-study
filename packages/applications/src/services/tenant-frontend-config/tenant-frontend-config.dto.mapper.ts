import { TenantFrontendConfigEntity } from '@arcaai/domains';
import { FrontendPipelineConfigJson, TenantFrontendConfigResponse } from './dto';

export class TenantFrontendConfigDtoMapper {
  /**
   * @param platformRawCaptureCapable The server-computed platform
   *   capability (the locked SYSTEM_TENANT_ID `enable-local-raw-capture`
   *   GlobalSetting). It is NOT a column on the entity, so the service resolves
   *   it from `AppSettingsService` and threads it in here.
   */
  static toResponse(entity: TenantFrontendConfigEntity, platformRawCaptureCapable: boolean): TenantFrontendConfigResponse {
    return {
      id: entity.id,
      tenantId: entity.tenantId as string,
      captureRawAudio: entity.captureRawAudio,
      platformRawCaptureCapable,
      transcriptionMode: entity.transcriptionMode,
      transcriptionModeLocked: entity.transcriptionModeLocked,
      captureMode: entity.captureMode ?? null,
      // The frozen column is `Json?`; we model its shape with the typed
      // FrontendPipelineConfigJson interface — no `any`.
      configJson: (entity.configJson as FrontendPipelineConfigJson | null | undefined) ?? null,
      resourceStatus: entity.resourceStatus ?? undefined,
      createdAt: entity.createdAt.toISOString(),
      updatedAt: entity.updatedAt.toISOString(),
      version: entity.version,
    };
  }
}
