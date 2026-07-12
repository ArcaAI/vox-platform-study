import { TenantTtsConfigEntity } from '@arcaai/domains';
import { TenantTtsConfigResponse } from './dto';

export class TenantTtsConfigDtoMapper {
  static toResponse(entity: TenantTtsConfigEntity): TenantTtsConfigResponse {
    return {
      tenantId: entity.tenantId,
      defaultVoiceEn: entity.defaultVoiceEn ?? null,
      defaultVoiceMl: entity.defaultVoiceMl ?? null,
      routingEn: entity.routingEn ?? [],
      routingMl: entity.routingMl ?? [],
      allowedProviders: entity.allowedProviders ?? [],
      defaultFormat: entity.defaultFormat ?? null,
      defaultSpeed: entity.defaultSpeed ?? null,
      sampleRate: entity.sampleRate ?? null,
      maxInputChars: entity.maxInputChars ?? null,
      sarvamPublicApiAllowed: entity.sarvamPublicApiAllowed,
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
  static placeholder(tenantId: string): TenantTtsConfigResponse {
    return {
      tenantId,
      defaultVoiceEn: null,
      defaultVoiceMl: null,
      routingEn: [],
      routingMl: [],
      allowedProviders: [],
      defaultFormat: null,
      defaultSpeed: null,
      sampleRate: null,
      maxInputChars: null,
      sarvamPublicApiAllowed: false,
      version: 0,
    };
  }
}
