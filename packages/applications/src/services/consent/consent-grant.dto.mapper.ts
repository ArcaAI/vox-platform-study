import { ConsentGrantEntity } from '@arcaai/domains';
import { ConsentGrantResponse } from './dto';

export class ConsentGrantDtoMapper {
  static toResponse(entity: ConsentGrantEntity): ConsentGrantResponse {
    return {
      id: entity.id,
      externalPatientId: entity.externalPatientId,
      purpose: entity.purpose,
      scope: (entity.scope as Record<string, unknown>) ?? undefined,
      grantedAt: entity.grantedAt.toISOString(),
      grantedBy: entity.grantedBy,
      grantMethod: entity.grantMethod,
      evidenceRef: entity.evidenceRef ?? undefined,
      expiresAt: entity.expiresAt?.toISOString() ?? undefined,
      revokedAt: entity.revokedAt?.toISOString() ?? undefined,
      revokedBy: entity.revokedBy ?? undefined,
      revocationReason: entity.revocationReason ?? undefined,
      resourceStatus: entity.resourceStatus ?? undefined,
      createdAt: entity.createdAt.toISOString(),
      updatedAt: entity.updatedAt.toISOString(),
      version: entity.version,
    };
  }
}
