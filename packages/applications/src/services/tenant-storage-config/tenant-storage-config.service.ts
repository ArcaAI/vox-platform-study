import {
  ResourceType,
  SYSTEM_TENANT_ID,
  SysEventType,
  TenantBucketRepository,
  TenantStorageConfigEntity,
  TenantStorageConfigFactory,
  TenantStorageConfigRepository,
} from '@arcaai/domains';
import { OptimisticConcurrencyException } from '@arcaai/exceptions';
import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ClsService } from 'nestjs-cls';
import { BaseService, isSuperAdmin } from '../../common';
import { IActiveUserContext } from '../../interfaces';
import { BlobStorageProviderFactory } from '../baseServices/storage/providers/blob-storage.provider.factory';
import { ITenantStorageConfigService } from './ITenantStorageConfigService';
import { UpsertPlatformStorageConfigRequest, UpsertTenantStorageConfigRequest, TenantStorageConfigResponse } from './dto';
import { TenantStorageConfigDtoMapper } from './tenant-storage-config.dto.mapper';

/** Editable, non-scope fields shared by the tenant and platform write paths. */
const CONFIG_FIELDS = [
  'topology',
  'endpoint',
  'publicEndpoint',
  'region',
  'forcePathStyle',
  'accountName',
  'endpointSuffix',
  'containerPrefix',
  'credentialsRef',
] as const;

/**
 * `publicEndpoint` arrives from a text field: surrounding whitespace is noise
 * and an empty value means "clear it" (sign with `endpoint` again). Anything
 * else is left for `TenantStorageConfigEntity.validate()` to accept or 400.
 */
function withNormalizedPublicEndpoint<T extends { publicEndpoint?: string | null }>(dto: T): T {
  if (typeof dto.publicEndpoint !== 'string') return dto;
  return { ...dto, publicEndpoint: dto.publicEndpoint.trim() || null };
}

/**
 * Manages per-tenant / per-bucket storage configuration AND the platform
 * default that sits under it.
 *
 * Resolution precedence (read side, applied by {@link BlobStorageProviderFactory}):
 *   per-bucket override → tenant default → SYSTEM default row → env.
 *
 * The SYSTEM default is an ordinary `TenantStorageConfig` row owned by the
 * reserved SYSTEM tenant with `bucketId = NULL` — deliberately NOT a second
 * table, because the model already carries every field the platform needs and
 * already declares this exact resolution order. It is SUPER_ADMIN-managed: the
 * permission decorators express `action + subject` and cannot express "global
 * admins only", so that boundary is enforced imperatively here (rule 05;
 * `globalOnly: true` on the `storage.platformDefault` descriptor).
 *
 * Credentials NEVER enter the database. `credentialsRef` is a Vault kv-v2 path
 * resolved at use time by `SecretsService`.
 *
 * Every mutation busts the factory's provider cache (per-tenant, or the
 * process-wide platform provider for the SYSTEM row) so the next file operation
 * picks up the new backend immediately — no redeploy.
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

    const tenantDefault = await this.configRepository.findTenantDefault(tenantId);
    if (tenantDefault) return TenantStorageConfigDtoMapper.toResponse(tenantDefault);

    // Third tier: the platform default. `null` from here means the runtime
    // falls through to the env bootstrap tier (see `platform-storage-config.ts`).
    const platformDefault = await this.configRepository.findSystemDefault();
    return platformDefault ? TenantStorageConfigDtoMapper.toResponse(platformDefault) : null;
  }

  async upsertConfig(request: UpsertTenantStorageConfigRequest): Promise<TenantStorageConfigResponse> {
    const dto = withNormalizedPublicEndpoint(request);
    const tenantId = this.requireTenantId();
    this.assertNotPlatformScope(tenantId);
    const bucketId = dto.bucketId ?? null;

    if (bucketId) {
      await this.assertBucketOwnedByTenant(bucketId, tenantId);
    }

    const existing = bucketId
      ? await this.configRepository.findForBucket(tenantId, bucketId)
      : await this.configRepository.findTenantDefault(tenantId);

    if (!existing && !bucketId) {
      await this.assertSingleTenantDefault(tenantId);
    }

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
    this.assertNotPlatformScope(tenantId);

    const existing = await this.configRepository.findById(id).catch(() => null);
    // 404-over-403: a config belonging to another tenant is reported as
    // missing, never as forbidden, so the caller cannot probe for existence.
    if (!existing || existing.tenantId !== tenantId) {
      throw new NotFoundException(`Storage config ${id} not found`);
    }

    const deleted = await this.configRepository.softDelete(id, this.requestUserId ?? undefined);

    this.providerFactory.invalidate(tenantId);

    this.broadcastSysEvent(SysEventType.ResourceDeleted, {
      resourceId: deleted.id,
      data: { bucketId: deleted.bucketId ?? null },
    });

    return TenantStorageConfigDtoMapper.toResponse(deleted);
  }

  // ---------------------------------------------------------------------------
  // Platform default (SYSTEM tenant row) — SUPER_ADMIN only
  // ---------------------------------------------------------------------------

  async getPlatformDefault(): Promise<TenantStorageConfigResponse> {
    this.assertSuperAdmin('read the platform storage default');

    const row = await this.configRepository.findSystemDefault();
    return row ? TenantStorageConfigDtoMapper.toResponse(row) : TenantStorageConfigDtoMapper.platformPlaceholder();
  }

  async upsertPlatformDefault(request: UpsertPlatformStorageConfigRequest): Promise<TenantStorageConfigResponse> {
    this.assertSuperAdmin('change the platform storage default');
    const dto = withNormalizedPublicEndpoint(request);

    const existing = await this.configRepository.findSystemDefault();

    if (!existing) {
      // No row yet — a create. The client must declare `expectedVersion: 0`
      // (`If-Match: "0"`), mirroring the TenantTtsConfig platform-default path.
      if (dto.expectedVersion !== 0) {
        throw new OptimisticConcurrencyException('TenantStorageConfig', SYSTEM_TENANT_ID, {
          expectedVersion: dto.expectedVersion,
          currentVersion: 0,
        });
      }
      const created = await this.createNew(SYSTEM_TENANT_ID, null, dto);
      this.providerFactory.invalidatePlatform();
      this.broadcastSysEvent(SysEventType.ResourceCreated, {
        resourceId: created.id,
        data: { scope: 'platform-default', provider: created.provider, topology: created.topology },
      });
      return TenantStorageConfigDtoMapper.toResponse(created);
    }

    existing.provider = dto.provider;
    for (const field of CONFIG_FIELDS) {
      const value = (dto as unknown as Record<string, unknown>)[field];
      if (value !== undefined) {
        (existing as unknown as Record<string, unknown>)[field] = value;
      }
    }
    // `hasChanges` is checked BEFORE stamping `updatedBy` — stamping first
    // would make every no-op PUT look like a change and burn a version.
    // OCC precondition BEFORE the no-changes short-circuit: a stale client must
    // get 412 ("you are stale, refetch"), not 400/200, even when the payload
    // would change nothing. RFC 7232 evaluates preconditions independently of
    // the payload; the CAS below still guards concurrent writers.
    this.assertExpectedVersion(existing, dto.expectedVersion);
    if (!existing.hasChanges) {
      // PUT is idempotent by contract (RFC 9110 §9.2.2): re-sending a value that is
      // already stored must yield the SAME observable result as the first send, not a
      // 400. Returning the current representation satisfies BOTH that and the
      // phantom-write rule — no version bump, no `updatedAt` rewrite, no
      // ResourceUpdated event. (PATCH routes keep throwing `ArgumentInvalidException`;
      // there "you sent me nothing to change" IS the documented answer.)
      // The OCC precondition above has already run, so a STALE token still gets 412
      // rather than a misleading 200.
      return TenantStorageConfigDtoMapper.toResponse(existing);
    }
    existing.updatedBy = this.requestUserId ?? undefined;
    this.validateOrThrow(existing);

    const previousVersion = existing.version;
    const updated = await this.configRepository.updateWithVersion(existing.id, existing, dto.expectedVersion);

    this.providerFactory.invalidatePlatform();
    this.broadcastSysEvent(SysEventType.ResourceUpdated, {
      resourceId: updated.id,
      data: { scope: 'platform-default', previousVersion, newVersion: updated.version },
    });

    this.logger.log({ message: 'Platform storage default updated', provider: updated.provider, endpoint: updated.endpoint ?? null });
    return TenantStorageConfigDtoMapper.toResponse(updated);
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private async createNew(
    tenantId: string,
    bucketId: string | null,
    dto: UpsertTenantStorageConfigRequest | UpsertPlatformStorageConfigRequest,
  ): Promise<TenantStorageConfigEntity> {
    const entity = TenantStorageConfigFactory.CreateConfig({
      tenantId,
      bucketId,
      provider: dto.provider,
      topology: dto.topology,
      endpoint: dto.endpoint,
      publicEndpoint: dto.publicEndpoint,
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
    if (dto.publicEndpoint !== undefined) entity.publicEndpoint = dto.publicEndpoint;
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

  /**
   * The model allows at most ONE tenant-wide default (`bucketId IS NULL`) per
   * tenant, but Postgres cannot enforce it — NULLs are distinct in a unique
   * index, so `@@unique([tenantId, bucketId])` does not constrain the NULL
   * case. Enforce it here, as the model comment requires.
   */
  private async assertSingleTenantDefault(tenantId: string): Promise<void> {
    const defaults = await this.configRepository.findAllTenantDefaults(tenantId);
    if (defaults.length > 0) {
      throw new ConflictException('A tenant-wide default storage config already exists; update it instead of creating a second one.');
    }
  }

  /**
   * The SYSTEM row has exactly one authoritative editor — the platform routes.
   * Reject an attempt to reach it through the tenant routes (only possible for
   * a super admin whose elevated working tenant IS the SYSTEM tenant).
   */
  private assertNotPlatformScope(tenantId: string): void {
    if (tenantId === SYSTEM_TENANT_ID) {
      throw new BadRequestException('The platform storage default is managed through the platform routes, not the tenant routes.');
    }
  }

  /**
   * AUTH-NOTE: SUPER_ADMIN-only boundary. The permission decorators express
   * `action + subject` and cannot express "super admins only" — a tenant admin
   * legitimately holds `manage:Storage` for its OWN rows. This is a 403
   * (privilege), NOT the 404-over-403 cross-tenant posture.
   */
  private assertSuperAdmin(action: string): void {
    if (!isSuperAdmin(this.requestUser)) {
      throw new ForbiddenException(`Only a super administrator may ${action}.`);
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
