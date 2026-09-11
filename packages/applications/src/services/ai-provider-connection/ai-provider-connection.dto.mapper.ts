import { AiModelEntity, AiProviderConnectionEntity } from '@arcaai/domains';
import { AiProviderConnectionResponse, ConnectionModelResponse } from './dto';
import { sanitizeProviderExtras } from './provider-extras';

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
      // TASK-952 — SANITISED on the way out, not raw.
      //
      // `provider-extras.ts` declares the read path as "anything inadmissible is
      // DROPPED, never thrown ... a row stored before this validator existed must
      // degrade to 'that key is missing', never to a failed request". The wire
      // fold honours that; this projection did not, so the console received keys
      // the adapter would never be given — and, once the console started echoing
      // the stored envelope back on save (D-6, so it stops wiping keys it has no
      // field for), an inadmissible legacy value would come straight back as a
      // 400 on the next save. That is the same failure class the sanitiser exists
      // to prevent, reached from the other direction.
      //
      // `null` is PRESERVED rather than flattened to `{}`: "no extras" and "an
      // empty extras object" are different stored states, and the response DTO
      // has always distinguished them.
      extraJson: entity.extraJson == null ? null : sanitizeProviderExtras(entity.extraJson),
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
