import {
  AgentRepository,
  AgentTask,
  EntityId,
  ResourceType,
  SysEventType,
  UserVoiceProfileEntity,
  UserVoiceProfileFactory,
  UserVoiceProfileRepository,
} from '@arcaai/domains';
import { InternalServerErrorException } from '@arcaai/exceptions';
import type { ResolvedAsrSpec } from '@arcaai/types';
import { HttpService } from '@nestjs/axios';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { isAxiosError } from 'axios';
import { ClsService } from 'nestjs-cls';
import { firstValueFrom } from 'rxjs';
import { BaseService, SERVICE_TOKEN_HEADER, TENANTLESS, TENANT_ID_HEADER, resolveInternalAccessToken, tenantHeaderValue } from '../../../common';
import { IActiveUserContext } from '../../../interfaces';
import { isPlatformHiddenAgentSlug } from '../../agent/platform-hidden-agents';
import { IConfigService } from '../../baseServices/_meta/config';
import { SecretsService } from '../../baseServices/_meta/secrets';
import { AsrAgentResolverService } from '../../stt/agent-resolver';
import { IVoiceProfileService, RuntimeVoiceProfile } from './IVoiceProfileService';
import { EnrollVoiceProfileRequest, VoiceProfileEnrollmentTarget } from './dto';

interface ExtractionResponse {
  embedding: number[];
  model_id: string;
  model_slug: string;
}

/**
 * TASK-887 — there is deliberately NO expected embedding dimension here any more.
 *
 * `UserVoiceProfile.embedding` is a dimension-agnostic pgvector `vector` and each row records
 * the model that produced it, so width is a property of the model the agent named. The gateway
 * used to compare the returned vector against a hardcoded 256 and reject anything else, which
 * is precisely the single platform embedding space the owner removed.
 */

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
    // TASK-887 — the one resolution that decides which embedding model an enrollment lands in.
    @Optional() private readonly asrResolver?: AsrAgentResolverService,
    // TASK-991 (OD-1) — the tenant's OWN published speech-to-text agents, read ONLY when the
    // preferred agent does not diarize. Optional + trailing so existing positional
    // constructions keep compiling; without it the tenant-wide unblock simply finds nothing
    // and the 409 stands, which is the pre-OD-1 answer, never a wrong one.
    @Optional() private readonly agentRepository?: AgentRepository,
  ) {
    super(eventEmitter, clsService, ResourceType.UserVoiceProfile);
    this.sttBaseUrl = this.configService?.config?.STT_URL || 'http://localhost:8861';
  }

  async enroll(request: EnrollVoiceProfileRequest): Promise<UserVoiceProfileEntity> {
    // A voice profile is biometric PHI stamped with its enrollment
    // tenant; reads (incl. the STT-v2 diarization preseed) are tenant-scoped.
    // Tenant attribution is a security boundary: it comes from CLS only.
    const tenantId = this.tenantId;
    if (!tenantId) {
      throw new BadRequestException('Voice profile enrollment requires a tenant context');
    }

    // TASK-887 — the AGENT names the space. Resolving it BEFORE any audio leaves the gateway
    // means an unusable enrollment is refused with a 404/409 that says why, instead of after
    // the user has recorded three samples. TASK-977: that includes a 409 while the agent's
    // diarization is off — no voice embedding is computed for a stage nothing will use.
    const target = await this.enrollmentTarget(request.agentSlug);
    const extraction = await this.extractEmbeddings(request.audioBuffers, target);

    const entity = UserVoiceProfileFactory.CreateUserVoiceProfile({
      tenantId,
      userId: request.userId,
      isActive: false,
      label: request.label,
      // The SLUG the agent declared — the identity a session compares against — echoed by
      // apps/stt so what is stored is exactly what was asked for, never what it substituted.
      modelId: extraction.model_slug || target.modelId,
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

  /**
   * TASK-887 — the embedding model a new enrollment would use.
   *
   * Resolution is the SAME one a session performs (`AsrAgentResolverService`): explicit slug,
   * else the `AgentAssignment` cascade, with 404-over-403 for an agent that is not this
   * tenant's. That is the point — enrolling against a different resolution than the one that
   * will match you is how a profile silently becomes unusable.
   *
   * TASK-977 (owner decision 2026-09-16) — enrollment is REFUSED while the agent's diarization
   * is off. Enrolling computes and stores a voice embedding, and voice embedding is off unless
   * an admin enabled diarization on that agent; this deliberately reverses TASK-887's "enrol
   * ahead of enabling". The refusal is on the SWITCH, not on the absent model: since TASK-977
   * D-4 a disabled stage ships no model at all, so "no model" would otherwise send the admin to
   * set an `embeddingModelSlug` the agent may already declare.
   *
   * TASK-991 (owner decision OD-1, 2026-09-19) — that refusal is now TENANT-WIDE, not
   * per-agent: if ANY published speech-to-text agent of the caller's tenant diarizes,
   * enrollment succeeds against THAT agent's embedding space. The seeded agents ship
   * diarization off, so reading the switch off the assigned agent alone refused most tenants
   * an enrollment the tenant was perfectly able to use.
   *
   * The session is unaffected — it still runs the assigned or explicitly named agent, because a
   * profile is keyed by `modelId` and not by the agent that produced it. Two agents bound to
   * the same embedding model share their profiles; one bound to a different model simply does
   * not see them, exactly as before.
   *
   * An EXPLICIT `agentSlug` is never substituted. The caller named the agent they expect to be
   * matched by, so quietly enrolling them somewhere else would store an embedding that agent
   * can never compare against — the precise failure this whole method exists to prevent.
   */
  async enrollmentTarget(agentSlug?: string): Promise<VoiceProfileEnrollmentTarget> {
    const tenantId = this.tenantId;
    if (!tenantId) {
      throw new BadRequestException('Voice profile enrollment requires a tenant context');
    }
    if (!this.asrResolver) {
      throw new ServiceUnavailableException('ASR agent resolution is not configured on this gateway');
    }
    const named = agentSlug ?? null;
    const { spec: preferred } = await this.asrResolver.resolve({ tenantId, agentSlug: named, departmentId: null });

    // The same 409 body the ASR resolver gives its own refusals (`{ code, message }`), so a
    // client reads one convention for every agent-shaped conflict on this path. The CODE is
    // what clients match on and is unchanged; only the message distinguishes "the agent you
    // named" from "nothing in this tenant".
    let spec: ResolvedAsrSpec = preferred;
    if (!preferred.audioFrontEnd.diarization.enabled) {
      if (named) {
        throw new ConflictException({
          code: 'ASR_AGENT_DIARIZATION_DISABLED',
          message:
            `Agent '${preferred.agent.slug}' has speaker diarization switched off (\`audioFrontEnd.diarization.enabled\` is false), ` +
            `so voice embedding is off for it and no voice profile can be enrolled. ` +
            `Enable \`audioFrontEnd.diarization.enabled\` on the agent first.`,
        });
      }
      const sibling = await this.firstDiarizingSpec(tenantId, preferred.agent.slug);
      if (!sibling) {
        throw new ConflictException({
          code: 'ASR_AGENT_DIARIZATION_DISABLED',
          message:
            `No published speech-to-text agent in this tenant has speaker diarization enabled ` +
            `(\`audioFrontEnd.diarization.enabled\` is false on '${preferred.agent.slug}' and on every other one), ` +
            `so voice embedding is off and no voice profile can be enrolled. ` +
            `Enable \`audioFrontEnd.diarization.enabled\` on an agent first.`,
        });
      }
      spec = sibling;
    }

    const embedding = spec.models.embedding;
    if (!embedding) {
      // Unreachable through `buildResolvedAsrSpec`, which refuses an enabled stage with no
      // embedding model (409 `ASR_AGENT_DIARIZATION_MODEL_MISSING`) and, since TASK-980, any
      // backend but `embedding` (409 `ASR_AGENT_DIARIZATION_BACKEND_UNSUPPORTED`) — the retired
      // `sortformer` backend was the only way here. Kept as an invariant guard with the
      // resolver's OWN answer for this state, never the old 400: the request is fine, the agent is not.
      throw new ConflictException({
        code: 'ASR_AGENT_DIARIZATION_MODEL_MISSING',
        message:
          `Agent '${spec.agent.slug}' enables speaker diarization but its resolved spec binds no speaker-embedding model, ` +
          `so there is no space to enroll a voice profile into. Set \`audioFrontEnd.diarization.embeddingModelSlug\` on the agent.`,
      });
    }
    return {
      agentSlug: spec.agent.slug,
      modelId: embedding.slug,
      modelSourceUri: embedding.sourceUri,
      diarizationEnabled: spec.audioFrontEnd.diarization.enabled,
      matchThreshold: spec.audioFrontEnd.diarization.matchThreshold ?? null,
    };
  }

  /**
   * TASK-991 (OD-1) — the first published, active speech-to-text agent of THIS tenant whose
   * resolved spec diarizes, or `null` when the tenant has none.
   *
   * Every candidate goes back through `AsrAgentResolverService` instead of having its switch
   * read off the row: the spec a session runs is BUILT (compiled config + fallback chain +
   * credentials), and only the built spec names the embedding model an enrollment must land in.
   *
   * `findPublishedActiveVisible` is the SAME read the business plane's agent list uses
   * (`AgentService.listPublished`) — the caller's tenant only, one row per slug, ordered by
   * slug — so the agent a user is enrolled against is deterministic and is one the console
   * already shows them. Platform hidden agents are skipped for the same reason that list skips
   * them: they are never a tenant's to choose.
   *
   * A candidate that will not resolve at all (no primary model, a vetoed credential) is SKIPPED,
   * not fatal: one broken agent must not re-block a tenant that also has a working one.
   */
  private async firstDiarizingSpec(tenantId: string, preferredSlug: string): Promise<ResolvedAsrSpec | null> {
    if (!this.asrResolver || !this.agentRepository) return null;
    const candidates = await this.agentRepository.findPublishedActiveVisible(tenantId, AgentTask.SPEECH_TO_TEXT);
    for (const candidate of candidates) {
      if (candidate.slug === preferredSlug || isPlatformHiddenAgentSlug(candidate.slug)) continue;
      try {
        const { spec } = await this.asrResolver.resolve({ tenantId, agentSlug: candidate.slug, departmentId: null });
        if (spec.audioFrontEnd.diarization.enabled) return spec;
      } catch (error: unknown) {
        this.logger.warn({
          message: 'Speech-to-text agent skipped while looking for one that diarizes',
          tenantId,
          agentSlug: candidate.slug,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return null;
  }

  async listForRuntime(userId: string, tenantId: string, modelId: string): Promise<RuntimeVoiceProfile[]> {
    if (!userId || !tenantId || !modelId) return [];
    try {
      const rows = await this.voiceProfileRepository.findActiveEmbeddingsForUser(userId, tenantId, modelId);
      return rows.map((row) => ({ profile_id: row.id, label: row.label, model_id: row.modelId, embedding: row.embedding }));
    } catch (error: unknown) {
      // Never fatal: without profiles the session diarizes with generic `Speaker N` labels,
      // which is a degraded transcript, not a broken one.
      this.logger.warn({
        message: 'Voice profile resolution for the ASR runtime failed; continuing with generic speaker labels',
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
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

  private async extractEmbeddings(audioBuffers: Buffer[], target: VoiceProfileEnrollmentTarget): Promise<ExtractionResponse> {
    const formData = new FormData();
    for (let i = 0; i < audioBuffers.length; i++) {
      const uint8 = new Uint8Array(audioBuffers[i]);
      const blob = new Blob([uint8], { type: 'audio/wav' });
      formData.append('files', blob, `sample-${i}.wav`);
    }
    // TASK-887 — the model the AGENT declared travels with the samples. `apps/stt` holds no
    // platform embedding model any more: it loads what it is told, echoes the slug back, and
    // refuses the request otherwise. The threshold is the agent's too — sample consistency and
    // speaker matching are the same confidence question, asked at enrollment and at runtime.
    formData.append('model_slug', target.modelId);
    formData.append('model_source_uri', target.modelSourceUri);
    if (target.matchThreshold !== null) formData.append('min_similarity', String(target.matchThreshold));

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
