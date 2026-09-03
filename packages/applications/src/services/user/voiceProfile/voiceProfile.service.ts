import { EntityId, ResourceType, SysEventType, UserVoiceProfileEntity, UserVoiceProfileFactory, UserVoiceProfileRepository } from '@arcaai/domains';
import { InternalServerErrorException } from '@arcaai/exceptions';
import { HttpService } from '@nestjs/axios';
import { BadRequestException, ForbiddenException, Inject, Injectable, Logger, Optional, ServiceUnavailableException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { isAxiosError } from 'axios';
import { ClsService } from 'nestjs-cls';
import { firstValueFrom } from 'rxjs';
import { BaseService, SERVICE_TOKEN_HEADER, TENANTLESS, TENANT_ID_HEADER, resolveInternalAccessToken, tenantHeaderValue } from '../../../common';
import { IActiveUserContext } from '../../../interfaces';
import { IConfigService } from '../../baseServices/_meta/config';
import { SecretsService } from '../../baseServices/_meta/secrets';
import { IVoiceProfileService } from './IVoiceProfileService';
import { EnrollVoiceProfileRequest } from './dto';

interface ExtractionResponse {
  embedding: number[];
  model_id: string;
}

// Must match the ``vector(N)`` dimension of ``core."UserVoiceProfile"."embedding"``
// in the Prisma migration. Changing this requires a coordinated DB migration
// AND a matching change to ``EXPECTED_EMBEDDING_DIM`` in
// ``apps/stt/src/stt/voice_profile/extraction_service.py``.
const EXPECTED_EMBEDDING_DIM = 256;

@Injectable()
export class VoiceProfileService extends BaseService implements IVoiceProfileService {
  private readonly logger = new Logger(VoiceProfileService.name);
  private readonly sttBaseUrl: string;

  constructor(
    private readonly voiceProfileRepository: UserVoiceProfileRepository,
    private readonly httpService: HttpService,
    protected override readonly eventEmitter: EventEmitter2,
    protected override readonly clsService: ClsService<IActiveUserContext>,
    @Optional() @Inject(IConfigService) private readonly configService?: IConfigService,
    // Optional + trailing so existing positional constructions keep compiling.
    @Optional() @Inject(SecretsService) private readonly secretsService?: SecretsService,
  ) {
    super(eventEmitter, clsService, ResourceType.UserVoiceProfile);
    this.sttBaseUrl = this.configService?.config?.STT_URL || 'http://localhost:8861';
  }

  async enroll(request: EnrollVoiceProfileRequest): Promise<UserVoiceProfileEntity> {
    const extraction = await this.extractEmbeddings(request.audioBuffers);

    if (extraction.embedding.length !== EXPECTED_EMBEDDING_DIM) {
      this.logger.warn({
        message: 'Voice profile embedding dimension mismatch',
        received: extraction.embedding.length,
        expected: EXPECTED_EMBEDDING_DIM,
        modelId: extraction.model_id,
      });
      throw new BadRequestException(
        `Embedding dimension mismatch: STT-v2 model '${extraction.model_id}' returned ` +
          `${extraction.embedding.length}-d but database expects ${EXPECTED_EMBEDDING_DIM}-d. ` +
          `Set DIARIZATION_HF_MODEL_ID to a ${EXPECTED_EMBEDDING_DIM}-d model ` +
          `(e.g. 'pyannote/wespeaker-voxceleb-resnet34-LM').`,
      );
    }

    // A voice profile is biometric PHI stamped with its enrollment
    // tenant; reads (incl. the STT-v2 diarization preseed) are tenant-scoped.
    // Tenant attribution is a security boundary: it comes from CLS only.
    const tenantId = this.tenantId;
    if (!tenantId) {
      throw new BadRequestException('Voice profile enrollment requires a tenant context');
    }

    const entity = UserVoiceProfileFactory.CreateUserVoiceProfile({
      tenantId,
      userId: request.userId,
      isActive: false,
      label: request.label,
      modelId: extraction.model_id,
      createdBy: this.requestUser?.id,
    });

    const created = await this.voiceProfileRepository.createWithEmbedding(entity, extraction.embedding);
    if (!created) {
      throw new InternalServerErrorException('Failed to create voice profile');
    }

    // Auto-activate the freshly enrolled profile if the user has none active yet.
    const existingActive = await this.voiceProfileRepository.findActiveByUserId(request.userId);
    if (!existingActive) {
      await this.voiceProfileRepository.activateById(created.id);
      created.isActive = true;
    }

    this.broadcastSysEvent(SysEventType.ResourceCreated, {
      resourceId: created.id,
      createdAt: created.createdAt,
      data: created.toObject() as object,
    });

    return created;
  }

  async listByUserId(userId: string): Promise<UserVoiceProfileEntity[]> {
    return this.voiceProfileRepository.findAllByUserId(userId);
  }

  async activate(profileId: EntityId): Promise<void> {
    const profile = await this.assertOwnership(profileId);

    await this.voiceProfileRepository.deactivateAllForUser(profile.userId);
    await this.voiceProfileRepository.activateById(profileId);

    this.broadcastSysEvent(SysEventType.ResourceUpdated, {
      resourceId: profileId,
      data: { isActive: true },
    });
  }

  async deactivate(profileId: EntityId): Promise<void> {
    const profile = await this.assertOwnership(profileId);

    await this.voiceProfileRepository.deactivateAllForUser(profile.userId);

    this.broadcastSysEvent(SysEventType.ResourceUpdated, {
      resourceId: profileId,
      data: { isActive: false },
    });
  }

  async deleteById(profileId: EntityId): Promise<UserVoiceProfileEntity> {
    await this.assertOwnership(profileId);
    const deleted = await this.voiceProfileRepository.softDelete(profileId);

    this.broadcastSysEvent(SysEventType.ResourceDeleted, {
      resourceId: deleted.id,
      data: deleted.toObject() as object,
    });

    return deleted;
  }

  /**
   * Enforce that the current CLS user owns the targeted profile.
   * Defence-in-depth for biometric PHI mutations. Loaded once and returned so
   * callers can reuse the entity (avoids an extra round-trip).
   */
  private async assertOwnership(profileId: EntityId): Promise<UserVoiceProfileEntity> {
    const profile = await this.voiceProfileRepository.findById(profileId);
    if (profile.userId !== this.requestUser?.id) {
      throw new ForbiddenException('Voice profile does not belong to current user');
    }
    return profile;
  }

  private async extractEmbeddings(audioBuffers: Buffer[]): Promise<ExtractionResponse> {
    const formData = new FormData();
    for (let i = 0; i < audioBuffers.length; i++) {
      const uint8 = new Uint8Array(audioBuffers[i]);
      const blob = new Blob([uint8], { type: 'audio/wav' });
      formData.append('files', blob, `sample-${i}.wav`);
    }

    // D-D: the ONE shared `INTERNAL_ACCESS_TOKEN`. `apps/stt` now runs
    // `ServiceAuthMiddleware` and `/internal/voice-profile/extract` is NOT in its
    // exempt set, so an unauthenticated enrolment 401s in any deployed
    // environment.: `X-Tenant-Id` too — enrolment is a JWT-authenticated
    // user self-service route, so the CLS tenant is populated and authoritative.
    //
    // Built by hand rather than through `internalServiceHeaders()` for ONE
    // reason: this body is a `FormData`, and that builder always stamps
    // `Content-Type: application/json`, which would destroy the multipart
    // boundary axios derives for us.
    const serviceToken = await resolveInternalAccessToken(this.secretsService, 'INTERNAL_ACCESS_TOKEN');
    const headers: Record<string, string> = {
      [SERVICE_TOKEN_HEADER]: serviceToken,
      [TENANT_ID_HEADER]: tenantHeaderValue(this.tenantId, TENANTLESS.PLATFORM_OPERATOR),
    };

    try {
      const { data } = await firstValueFrom(
        this.httpService.post<ExtractionResponse>(`${this.sttBaseUrl}/internal/voice-profile/extract`, formData, {
          timeout: 60000,
          headers,
        }),
      );
      return data;
    } catch (error: unknown) {
      throw this.translateExtractionError(error);
    }
  }

  /**
   * Translate a failed STT-v2 `/internal/voice-profile/extract` call into a
   * meaningful HTTP exception so the UI surfaces the real reason instead of an
   * opaque 500/AxiosError dump.
   *
   * STT-v2 returns `{ detail: string }` for 4xx/5xx (FastAPI default). We map:
   *   - network failure (no response) → 503 ServiceUnavailable
   *   - 400 with `detail` → 400 BadRequest(detail)
   *   - 503 with `detail` → 503 ServiceUnavailable(detail)
   *   - everything else → 500 InternalServerError
   */
  private translateExtractionError(error: unknown): Error {
    if (!isAxiosError(error)) {
      this.logger.error({ message: 'Voice profile extraction failed (non-axios)', error });
      return new InternalServerErrorException('Voice profile extraction failed');
    }

    const status = error.response?.status;
    const detail = (error.response?.data as { detail?: string } | undefined)?.detail;

    this.logger.warn({
      message: 'Voice profile extraction failed',
      status,
      detail,
      code: error.code,
      url: error.config?.url,
    });

    if (!error.response) {
      return new ServiceUnavailableException('Voice profile extraction service is unavailable. Please try again later.');
    }
    if (status === 400 && detail) {
      return new BadRequestException(detail);
    }
    if (status === 503) {
      return new ServiceUnavailableException(detail ?? 'Voice profile extraction service is unavailable');
    }
    return new InternalServerErrorException('Voice profile extraction failed');
  }
}
