import { AiRuntimeProfileEntity } from '@arcaai/domains';
import { AiRuntimeProfileResponse } from './dto';

export class AiRuntimeProfileDtoMapper {
  static toResponse(entity: AiRuntimeProfileEntity): AiRuntimeProfileResponse {
    return {
      tenantId: entity.tenantId,
      provider: entity.provider,
      modelSlug: entity.modelSlug,
      temperature: entity.temperature ?? null,
      topP: entity.topP ?? null,
      maxTokens: entity.maxTokens ?? null,
      contextLength: entity.contextLength ?? null,
      maxConcurrent: entity.maxConcurrent ?? null,
      tpmLimit: entity.tpmLimit ?? null,
      rpmLimit: entity.rpmLimit ?? null,
      timeoutS: entity.timeoutS ?? null,
      keepAliveSeconds: entity.keepAliveSeconds ?? null,
      extraJson: (entity.extraJson as Record<string, unknown> | null) ?? null,
      version: entity.version,
      ...(entity.updatedAt ? { updatedAt: entity.updatedAt.toISOString() } : {}),
    };
  }

  /** The "no row yet" shape — client upserts with `expectedVersion: 0` to create. */
  static placeholder(tenantId: string, provider: string, modelSlug: string): AiRuntimeProfileResponse {
    return {
      tenantId,
      provider,
      modelSlug,
      temperature: null,
      topP: null,
      maxTokens: null,
      contextLength: null,
      maxConcurrent: null,
      tpmLimit: null,
      rpmLimit: null,
      timeoutS: null,
      keepAliveSeconds: null,
      extraJson: null,
      version: 0,
    };
  }
}
