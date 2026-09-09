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
import { LOCAL_RAW_CAPTURE_ENABLED_KEY } from '../settings-registry/descriptors/feature-availability.descriptors';
import { TenantSettingsService } from '../settings-registry/tenant-settings.service';
import { ITenantFrontendConfigService } from './ITenantFrontendConfigService';
import { TenantFrontendConfigResponse, UpsertTenantFrontendConfigRequest } from './dto';
import { TenantFrontendConfigDtoMapper } from './tenant-frontend-config.dto.mapper';
import { captureModeToLocalRawCapture } from './capture-mode.translation';

/**
 * Platform-capability flag for local raw-stream dual-capture.
 *
 * TASK-932 S2-4 — this is now a RE-EXPORT of the settings-registry descriptor
 * key, so the string is spelled once. The name is kept because it is part of
 * this module's public surface (`my-tenant.controller.ts` imports it to label
 * the synthetic row it appends to `GET /tenant/me/config`, which is an SDK wire
 * contract and does not change).
 */
export const LOCAL_RAW_CAPTURE_CAPABILITY_KEY = LOCAL_RAW_CAPTURE_ENABLED_KEY;

/**
 * Manages the per-tenant frontend CAPTURE policy.
 *
 * TASK-883 removed the client-AI toggles (`asrModel` / `noiseCancel` / `vad` /
 * `voiceEnrollment` / `diarization`): the browser never runs a model, so those
 * were controls an admin could set with no effect. What is left is what the
 * browser captures and how the transcription mode is pinned.
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
    // TASK-932 S2-4 — the settings-registry PLATFORM lane, replacing the direct
    // `IAppSettingsService` read. Same underlying cache, but the DEFAULT now
    // comes from the descriptor instead of a literal at the call site.
    private readonly tenantSettings: TenantSettingsService,
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
   * Local (in-browser) transcription is disabled platform-wide.
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

  /**
   * The platform capability, resolved on the registry's PLATFORM lane
   * (`SYSTEM row -> descriptor default`).
   *
   * TASK-932 S2-4 / OD-2 — the key is a `global-kv` `Feature Availability`
   * descriptor with `maxScope: 'system'` and `globalOnly: true`, which is what
   * now makes it platform-admin-only. The row-level `locked` flag said the same
   * thing through a mechanism only this one row used; the descriptor gate
   * replaces it (lane S1 clears `locked` on the seeded row).
   *
   * `resolvePlatform`, not `resolve`: the value is platform-scope by
   * declaration, and the TENANT half of the raw-capture decision is the
   * `TenantFrontendConfig.captureRawAudio` column ANDed below — not a tenant
   * row for this key, which is why the descriptor refuses to offer one.
   *
   * Deliberately NOT wrapped in a try/catch. `resolve` raises only on an
   * unregistered key — a programming error a rename would introduce — and
   * swallowing that would turn a broken gate into a silently disabled feature.
   * The fail-safe end is already the descriptor default (`false`).
   */
  private platformRawCaptureCapable(): boolean {
    return this.tenantSettings.resolvePlatform<boolean>(LOCAL_RAW_CAPTURE_ENABLED_KEY).value === true;
  }

  async upsert(dto: UpsertTenantFrontendConfigRequest, tenantId?: string): Promise<TenantFrontendConfigResponse> {
    const scope = this.resolveTenantScope(tenantId);
    const existing = await this.configRepository.findByTenant(scope);

    const saved = existing ? await this.applyUpdate(existing, dto) : await this.createNew(scope, dto);

    this.broadcastSysEvent(existing ? SysEventType.ResourceUpdated : SysEventType.ResourceCreated, {
      resourceId: saved.id,
      data: {
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
   * A super admin (SUPER_ADMIN) must target a concrete tenant
   * via `tenantId`; a tenant admin is pinned to the CLS tenant.
   */
  private resolveTenantScope(requestedTenantId?: string): string {
    if (this.isGlobalRole()) {
      if (!requestedTenantId) {
        throw new BadRequestException('tenantId is required for super admins');
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
    return roles.includes('SUPER_ADMIN');
  }
}
