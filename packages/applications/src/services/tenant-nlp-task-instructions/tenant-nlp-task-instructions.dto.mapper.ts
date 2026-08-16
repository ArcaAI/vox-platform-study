import { TenantNlpTaskInstructionsEntity } from '@arcaai/domains';
import { TenantNlpTaskInstructionsResponse } from './dto';

export class TenantNlpTaskInstructionsDtoMapper {
  static toResponse(entity: TenantNlpTaskInstructionsEntity): TenantNlpTaskInstructionsResponse {
    return {
      tenantId: entity.tenantId,
      taskKey: entity.taskKey,
      instructionsJson: (entity.instructionsJson as string[] | null | undefined) ?? null,
      resourceStatus: entity.resourceStatus ?? undefined,
      version: entity.version,
      createdAt: entity.createdAt?.toISOString(),
      updatedAt: entity.updatedAt?.toISOString(),
    };
  }

  /**
   * Placeholder for a (tenant, taskKey) with no row yet: version 0. The
   * client GETs this, then PUTs with `expectedVersion: 0` (`If-Match: "0"`) to
   * create the row (mirrors `AiTaskDefaultDtoMapper.placeholder`).
   */
  static placeholder(tenantId: string, taskKey: string): TenantNlpTaskInstructionsResponse {
    return {
      tenantId,
      taskKey,
      instructionsJson: null,
      version: 0,
    };
  }
}
