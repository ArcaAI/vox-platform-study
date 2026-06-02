import {
  ResourceType,
  SysEventType,
  TenantFrontendConfigEntity,
  TenantFrontendConfigFactory,
  TenantFrontendConfigRepository,
} from '@arcaai/domains';
import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ClsService } from 'nestjs-cls';
import { BaseService } from '../../common';
import { IActiveUserContext } from '../../interfaces';
import { ITenantFrontendConfigService } from './ITenantFrontendConfigService';
import { TenantFrontendConfigResponse, UpsertTenantFrontendConfigRequest } from './dto';
import { TenantFrontendConfigDtoMapper } from './tenant-frontend-config.dto.mapper';

/**
 * Manages per-tenant frontend audio-pipeline defaults (TASK-328 A6).
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
  ) {
    super(eventEmitter, clsService, ResourceType.TenantFrontendConfig);
  }

  async getByTenant(tenantId?: string): Promise<TenantFrontendConfigResponse | null> {
    const scope = this.resolveTenantScope(tenantId);
    const config = await this.configRepository.findByTenant(scope);
    if (!config) return null;

    this.broadcastSysEvent(SysEventType.ResourceViewed, { resourceId: config.id });
    return TenantFrontendConfigDtoMapper.toResponse(config);
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
      },
    });

    return TenantFrontendConfigDtoMapper.toResponse(saved);
  }

  private async createNew(tenantId: string, dto: UpsertTenantFrontendConfigRequest): Promise<TenantFrontendConfigEntity> {
    const entity = TenantFrontendConfigFactory.CreateTenantFrontendConfig({
      tenantId,
      asrModel: dto.asrModel ?? null,
      noiseCancel: dto.noiseCancel ?? false,
      vad: dto.vad ?? false,
      voiceEnrollment: dto.voiceEnrollment ?? false,
      diarization: dto.diarization ?? false,
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
   * A global admin (SUPER_ADMIN / GLOBAL_ADMIN) must target a concrete tenant
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
    return roles.some((r) => r === 'SUPER_ADMIN' || r === 'GLOBAL_ADMIN');
  }
}
