import { TenantFrontendConfigEntity } from '@arcaai/domains';
import { FrontendPipelineConfigJson, TenantFrontendConfigResponse } from './dto';

export class TenantFrontendConfigDtoMapper {
  static toResponse(entity: TenantFrontendConfigEntity): TenantFrontendConfigResponse {
    return {
      id: entity.id,
      tenantId: entity.tenantId as string,
      asrModel: entity.asrModel ?? null,
      noiseCancel: entity.noiseCancel,
      vad: entity.vad,
      voiceEnrollment: entity.voiceEnrollment,
      diarization: entity.diarization,
      // The frozen column is `Json?`; we model its shape with the typed
      // FrontendPipelineConfigJson interface (TASK-328 A6 — no `any`).
      configJson: (entity.configJson as FrontendPipelineConfigJson | null | undefined) ?? null,
      resourceStatus: entity.resourceStatus ?? undefined,
      createdAt: entity.createdAt.toISOString(),
      updatedAt: entity.updatedAt.toISOString(),
      version: entity.version,
    };
  }
}
