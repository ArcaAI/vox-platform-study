import {
  ResourceType,
  SysEventType,
  TenantBucketRepository,
  TenantStorageConfigEntity,
  TenantStorageConfigFactory,
  TenantStorageConfigRepository,
} from '@arcaai/domains';
import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ClsService } from 'nestjs-cls';
import { BaseService } from '../../common';
import { IActiveUserContext } from '../../interfaces';
import { BlobStorageProviderFactory } from '../baseServices/storage/providers/blob-storage.provider.factory';
import { ITenantStorageConfigService } from './ITenantStorageConfigService';
import { UpsertTenantStorageConfigRequest, TenantStorageConfigResponse } from './dto';
import { TenantStorageConfigDtoMapper } from './tenant-storage-config.dto.mapper';

/**
 * Manages per-tenant / per-bucket storage configuration (TASK-318 / R5).
 *
 * Resolution precedence (read side, applied by {@link BlobStorageProviderFactory}):
 *   per-bucket override → tenant default → global/shared config.
 *
 * Every mutation busts the factory's provider cache for the tenant so the next
 * file operation picks up the new backend immediately.
 */
@Injectable()
export class TenantStorageConfigService extends BaseService implements ITenantStorageConfigService {
  private readonly logger = new Logger(TenantStorageConfigService.name);

  constructor(
    private readonly configRepository: TenantStorageConfigRepository,
    private readonly bucketRepository: TenantBucketRepository,
    private readonly providerFactory: BlobStorageProviderFactory,
    protected override readonly eventEmitter: EventEmitter2,
    protected override readonly clsService: ClsService<IActiveUserContext>,
  ) {
    super(eventEmitter, clsService, ResourceType.TenantStorageConfig);
  }

  async listConfigs(options?: { includeDisabled?: boolean }): Promise<TenantStorageConfigResponse[]> {
    const tenantId = this.requireTenantId();
    const configs = await this.configRepository.findAllByTenant(tenantId, options);

    this.broadcastSysEvent(SysEventType.ResourceViewed, {
      data: { count: configs.length },
    });

    return configs.map(TenantStorageConfigDtoMapper.toResponse);
  }

  async getEffectiveConfig(bucketId?: string): Promise<TenantStorageConfigResponse | null> {
    const tenantId = this.requireTenantId();

    if (bucketId) {
      const override = await this.configRepository.findForBucket(tenantId, bucketId);
      if (override) return TenantStorageConfigDtoMapper.toResponse(override);
    }

    const fallback = await this.configRepository.findTenantDefault(tenantId);
    return fallback ? TenantStorageConfigDtoMapper.toResponse(fallback) : null;
  }

  async upsertConfig(dto: UpsertTenantStorageConfigRequest): Promise<TenantStorageConfigResponse> {
    const tenantId = this.requireTenantId();
    const bucketId = dto.bucketId ?? null;

    if (bucketId) {
      await this.assertBucketOwnedByTenant(bucketId, tenantId);
    }

    const existing = bucketId
      ? await this.configRepository.findForBucket(tenantId, bucketId)
      : await this.configRepository.findTenantDefault(tenantId);

    const saved = existing ? await this.applyUpdate(existing, dto) : await this.createNew(tenantId, bucketId, dto);

    this.providerFactory.invalidate(tenantId);

    this.broadcastSysEvent(existing ? SysEventType.ResourceUpdated : SysEventType.ResourceCreated, {
      resourceId: saved.id,
      data: { bucketId, provider: saved.provider, topology: saved.topology },
    });

    return TenantStorageConfigDtoMapper.toResponse(saved);
  }

  async deleteConfig(id: string): Promise<TenantStorageConfigResponse> {
    const tenantId = this.requireTenantId();

    const existing = await this.configRepository.findById(id).catch(() => null);
    if (!existing) {
      throw new NotFoundException(`Storage config ${id} not found`);
    }
    if (existing.tenantId !== tenantId) {
      throw new ForbiddenException('You do not have access to this storage config');
    }

    const deleted = await this.configRepository.softDelete(id, this.requestUserId ?? undefined);

    this.providerFactory.invalidate(tenantId);

    this.broadcastSysEvent(SysEventType.ResourceDeleted, {
      resourceId: deleted.id,
      data: { bucketId: deleted.bucketId ?? null },
    });

    return TenantStorageConfigDtoMapper.toResponse(deleted);
  }

  private async createNew(tenantId: string, bucketId: string | null, dto: UpsertTenantStorageConfigRequest): Promise<TenantStorageConfigEntity> {
    const entity = TenantStorageConfigFactory.CreateConfig({
      tenantId,
      bucketId,
      provider: dto.provider,
      topology: dto.topology,
      endpoint: dto.endpoint,
      region: dto.region,
      forcePathStyle: dto.forcePathStyle,
      accountName: dto.accountName,
      endpointSuffix: dto.endpointSuffix,
      containerPrefix: dto.containerPrefix,
      credentialsRef: dto.credentialsRef,
      createdBy: this.requestUserId ?? undefined,
    });

    this.validateOrThrow(entity);
    return this.configRepository.create(entity);
  }

  private async applyUpdate(entity: TenantStorageConfigEntity, dto: UpsertTenantStorageConfigRequest): Promise<TenantStorageConfigEntity> {
    entity.provider = dto.provider;
    if (dto.topology !== undefined) entity.topology = dto.topology;
    if (dto.endpoint !== undefined) entity.endpoint = dto.endpoint;
    if (dto.region !== undefined) entity.region = dto.region;
    if (dto.forcePathStyle !== undefined) entity.forcePathStyle = dto.forcePathStyle;
    if (dto.accountName !== undefined) entity.accountName = dto.accountName;
    if (dto.endpointSuffix !== undefined) entity.endpointSuffix = dto.endpointSuffix;
    if (dto.containerPrefix !== undefined) entity.containerPrefix = dto.containerPrefix;
    if (dto.credentialsRef !== undefined) entity.credentialsRef = dto.credentialsRef;
    entity.updatedBy = this.requestUserId ?? undefined;

    this.validateOrThrow(entity);
    return this.configRepository.update(entity.id, entity);
  }

  /** Surface entity invariant violations (e.g. DEDICATED needs credentialsRef) as 400s. */
  private validateOrThrow(entity: TenantStorageConfigEntity): void {
    try {
      entity.validate();
    } catch (error) {
      throw new BadRequestException(error instanceof Error ? error.message : 'Invalid storage configuration');
    }
  }

  private async assertBucketOwnedByTenant(bucketId: string, tenantId: string): Promise<void> {
    const bucket = await this.bucketRepository.findById(bucketId).catch(() => null);
    if (!bucket || bucket.tenantId !== tenantId) {
      throw new NotFoundException(`Bucket ${bucketId} not found`);
    }
  }

  private requireTenantId(): string {
    const tenantId = this.tenantId;
    if (!tenantId) {
      throw new BadRequestException('Tenant ID is required');
    }
    return tenantId;
  }
}
