import {
  ResourceType,
  SysEventType,
  TenantFrontendConfigEntity,
  TenantFrontendConfigFactory,
  TenantFrontendConfigRepository,
  TranscriptionMode,
} from '@arcaai/domains';
import { BadRequestException, Inject, Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ClsService } from 'nestjs-cls';
import { BaseService } from '../../common';
import { IActiveUserContext } from '../../interfaces';
import { IAppSettingsService } from '../baseServices/_meta/appSettings/IAppSettingsService';
import { ITenantFrontendConfigService } from './ITenantFrontendConfigService';
import { TenantFrontendConfigResponse, UpsertTenantFrontendConfigRequest } from './dto';
import { TenantFrontendConfigDtoMapper } from './tenant-frontend-config.dto.mapper';
import { captureModeToLocalRawCapture } from './capture-mode.translation';

/**
 * Platform-capability flag for local raw-stream dual-capture. A
 * single `locked` GlobalSetting owned by `SYSTEM_TENANT_ID` (namespace
 * `feature-flags`). The `AppSettingsService` cache is keyed flat by `key`, so a
 * single platform-scoped row resolves deterministically regardless of tenant.
 */
export const LOCAL_RAW_CAPTURE_CAPABILITY_KEY = 'enable-local-raw-capture';

/**
 * Manages per-tenant frontend audio-pipeline defaults.
 *
 * There is exactly one row per tenant (`tenantId @unique`); `upsert` creates it
 * on first save and updates it thereafter. Updates run via the OCC
 * Compare-And-Set (`updateWithVersion`) so concurrent admin edits cannot
 * silently clobber each other; the create path needs no version.
 */
@Injectable()
export class TenantFrontendConfigService extends BaseService implements ITenantFrontendConfigService {
  private readonly logger = new Logger(TenantFrontendConfigService.name);

  constructor(
    private readonly configRepository: TenantFrontendConfigRepository,
    protected override readonly eventEmitter: EventEmitter2,
    protected override readonly clsService: ClsService<IActiveUserContext>,
    @Inject(IAppSettingsService)
    private readonly appSettings: IAppSettingsService,
  ) {
    super(eventEmitter, clsService, ResourceType.TenantFrontendConfig);
  }

  async getByTenant(tenantId?: string): Promise<TenantFrontendConfigResponse | null> {
    const scope = this.resolveTenantScope(tenantId);
    const config = await this.configRepository.findByTenant(scope);
    if (!config) return null;

    this.broadcastSysEvent(SysEventType.ResourceViewed, { resourceId: config.id });
    return this.clampTranscriptionMode(TenantFrontendConfigDtoMapper.toResponse(config, this.platformRawCaptureCapable()));
  }

  /**
   * TASK-545 — local (in-browser) transcription is disabled platform-wide.
   * Clamps the SERVED value so callers (admin console, SDK tenant-config
   * reads) always see `transcriptionMode: BACKEND` and
   * `transcriptionModeLocked: true`, regardless of what the tenant row
   * stores. The stored column is left untouched — reversible by removing this
   * clamp (and the matching SDK kill switch,
   * `packages/agentic-sdk-v2/src/core/constants.ts#LOCAL_TRANSCRIPTION_ENABLED`),
   * not by migrating data.
   */
  private clampTranscriptionMode(response: TenantFrontendConfigResponse): TenantFrontendConfigResponse {
    return { ...response, transcriptionMode: TranscriptionMode.BACKEND, transcriptionModeLocked: true };
  }

  /**
   * The SDK-facing enablement for local raw-stream capture:
   * `platformCapability AND tenantToggle`, computed server-side. The platform
   * capability comes from the boot-cached `enable-local-raw-capture`
   * GlobalSetting; the tenant toggle is the `captureRawAudio` column. Returns
   * `false` whenever the platform capability is OFF (short-circuits the DB read)
   * or the tenant has no config row.
   */
  async resolveEffectiveLocalRawCapture(tenantId: string): Promise<boolean> {
    if (!this.platformRawCaptureCapable()) return false;
    const config = await this.configRepository.findByTenant(tenantId);
    if (!config) return false;

    // When the tenant has set a `captureMode`, the
    // translation layer is the source of truth for the local raw flag. When
    // `captureMode` is null (no tenant override) we fall back to the legacy
    // `captureRawAudio` column so previously-configured tenants keep today's
    // behaviour (back-compat).
    const fromCaptureMode = captureModeToLocalRawCapture(config.captureMode);
    if (fromCaptureMode !== null) return fromCaptureMode;
    return config.captureRawAudio === true;
  }

  /** The locked platform capability (single SYSTEM_TENANT_ID GlobalSetting). */
  private platformRawCaptureCapable(): boolean {
    return this.appSettings.getValueWithDefault<boolean>(LOCAL_RAW_CAPTURE_CAPABILITY_KEY, false);
  }

  async upsert(dto: UpsertTenantFrontendConfigRequest, tenantId?: string): Promise<TenantFrontendConfigResponse> {
    const scope = this.resolveTenantScope(tenantId);
    const existing = await this.configRepository.findByTenant(scope);

    const saved = existing ? await this.applyUpdate(existing, dto) : await this.createNew(scope, dto);

    this.broadcastSysEvent(existing ? SysEventType.ResourceUpdated : SysEventType.ResourceCreated, {
      resourceId: saved.id,
      data: {
        asrModel: saved.asrModel ?? null,
        noiseCancel: saved.noiseCancel,
        vad: saved.vad,
        voiceEnrollment: saved.voiceEnrollment,
        diarization: saved.diarization,
        captureRawAudio: saved.captureRawAudio,
        transcriptionMode: saved.transcriptionMode,
        transcriptionModeLocked: saved.transcriptionModeLocked,
        captureMode: saved.captureMode ?? null,
      },
    });

    return this.clampTranscriptionMode(TenantFrontendConfigDtoMapper.toResponse(saved, this.platformRawCaptureCapable()));
  }

  private async createNew(tenantId: string, dto: UpsertTenantFrontendConfigRequest): Promise<TenantFrontendConfigEntity> {
    const entity = TenantFrontendConfigFactory.CreateTenantFrontendConfig({
      tenantId,
      asrModel: dto.asrModel ?? null,
      noiseCancel: dto.noiseCancel ?? false,
      vad: dto.vad ?? false,
      voiceEnrollment: dto.voiceEnrollment ?? false,
      diarization: dto.diarization ?? false,
      captureRawAudio: dto.captureRawAudio ?? false,
      // The factory defaults transcriptionMode=BACKEND,
      // transcriptionModeLocked=false, captureMode=null when these are omitted.
      transcriptionMode: dto.transcriptionMode,
      transcriptionModeLocked: dto.transcriptionModeLocked,
      captureMode: dto.captureMode ?? null,
      configJson: (dto.configJson ?? null) as Record<string, unknown> | null,
      createdBy: this.requestUserId ?? undefined,
    });

    return this.configRepository.create(entity);
  }

  private async applyUpdate(entity: TenantFrontendConfigEntity, dto: UpsertTenantFrontendConfigRequest): Promise<TenantFrontendConfigEntity> {
    if (dto.asrModel !== undefined) entity.asrModel = dto.asrModel;
    if (dto.noiseCancel !== undefined) entity.noiseCancel = dto.noiseCancel;
    if (dto.vad !== undefined) entity.vad = dto.vad;
    if (dto.voiceEnrollment !== undefined) entity.voiceEnrollment = dto.voiceEnrollment;
    if (dto.diarization !== undefined) entity.diarization = dto.diarization;
    if (dto.captureRawAudio !== undefined) entity.captureRawAudio = dto.captureRawAudio;
    // CaptureMode is nullable: `null` is a meaningful value
    // (clears the tenant override), so we only skip the assignment when the
    // field is entirely absent from the payload.
    if (dto.transcriptionMode !== undefined) entity.transcriptionMode = dto.transcriptionMode;
    if (dto.transcriptionModeLocked !== undefined) entity.transcriptionModeLocked = dto.transcriptionModeLocked;
    if (dto.captureMode !== undefined) entity.captureMode = dto.captureMode;
    if (dto.configJson !== undefined) entity.configJson = (dto.configJson ?? null) as Record<string, unknown> | null;
    entity.updatedBy = this.requestUserId ?? undefined;

    // OCC: an update against an existing row MUST carry the version it read
    // (folded from `If-Match`). Refuse a versionless update rather than write
    // blind — that would defeat the Compare-And-Set guarantee.
    if (dto.expectedVersion === undefined) {
      throw new BadRequestException('expectedVersion (If-Match) is required to update an existing frontend config');
    }

    return this.configRepository.updateWithVersion(entity.id, entity, dto.expectedVersion);
  }

  /**
   * A global admin (GLOBAL_ADMIN) must target a concrete tenant
   * via `tenantId`; a tenant admin is pinned to the CLS tenant.
   */
  private resolveTenantScope(requestedTenantId?: string): string {
    if (this.isGlobalRole()) {
      if (!requestedTenantId) {
        throw new BadRequestException('tenantId is required for global admins');
      }
      return requestedTenantId;
    }
    const ctxTenant = this.tenantId;
    if (!ctxTenant) {
      throw new BadRequestException('Tenant ID is required');
    }
    return ctxTenant;
  }

  private isGlobalRole(): boolean {
    const roles = this.requestUser?.roles ?? [];
    return roles.includes('GLOBAL_ADMIN');
  }
}
