import { AiModelEntity, AiProviderConnectionEntity } from '@arcaai/domains';
import { AiProviderConnectionResponse, ConnectionModelResponse } from './dto';

/**
 * Entity → masked response projection.
 *
 * The ONLY place a connection entity becomes client-visible. `encryptedApiKey`
 * is never copied onto the response — presence is reported through `hasKey`.
 * A snapshot/deep-key test asserts this (no ciphertext at any depth).
 */
export class AiProviderConnectionDtoMapper {
  static toResponse(entity: AiProviderConnectionEntity, models?: AiModelEntity[]): AiProviderConnectionResponse {
    return {
      ...(models ? { models: models.map((model) => AiProviderConnectionDtoMapper.toModel(model)) } : {}),
      tenantId: entity.tenantId,
      service: entity.service,
      provider: entity.provider,
      baseUrl: entity.baseUrl ?? null,
      region: entity.region ?? null,
      apiVersion: entity.apiVersion ?? null,
      deploymentName: entity.deploymentName ?? null,
      hasKey: entity.hasKey,
      keyVersion: entity.keyVersion ?? null,
      enabled: entity.enabled,
      extraJson: (entity.extraJson as Record<string, unknown> | null) ?? null,
      maxConcurrent: entity.maxConcurrent ?? null,
      rpmLimit: entity.rpmLimit ?? null,
      tpmLimit: entity.tpmLimit ?? null,
      timeoutS: entity.timeoutS ?? null,
      version: entity.version,
      ...(entity.updatedAt ? { updatedAt: entity.updatedAt.toISOString() } : {}),
    };
  }

  /**
   * One declared model, projected (TASK-890 §3.7a). Field by field, like the
   * catalogue mapper and for the same reason: a spread would leak the next
   * registry column somebody adds.
   */
  static toModel(model: AiModelEntity): ConnectionModelResponse {
    const meta = (model.metaData ?? null) as { capabilities?: Record<string, unknown> } | null;
    const caps = (meta?.capabilities ?? {}) as { supportedGenerationParams?: string[]; supportsSsml?: boolean };
    return {
      id: model.id,
      slug: model.slug,
      name: model.name,
      wireModelId: model.wireModelId ?? model.sourceUri,
      taskType: model.taskType,
      capabilities: {
        ...(Array.isArray(caps.supportedGenerationParams) ? { supportedGenerationParams: caps.supportedGenerationParams } : {}),
        ...(typeof caps.supportsSsml === 'boolean' ? { supportsSsml: caps.supportsSsml } : {}),
      },
    };
  }

  /**
   * The "no row yet" shape. The client GETs this, then upserts with
   * `If-Match: "0"` / `expectedVersion: 0` to create — mirroring the
   * `TenantTtsConfigDtoMapper.placeholder` contract.
   */
  static placeholder(service: string, tenantId: string, provider: string): AiProviderConnectionResponse {
    return {
      tenantId,
      service,
      provider,
      baseUrl: null,
      region: null,
      apiVersion: null,
      deploymentName: null,
      hasKey: false,
      keyVersion: null,
      enabled: false,
      extraJson: null,
      maxConcurrent: null,
      rpmLimit: null,
      tpmLimit: null,
      timeoutS: null,
      version: 0,
    };
  }
}
