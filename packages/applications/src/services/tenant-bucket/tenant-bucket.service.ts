import {
  isPlatformBucket,
  ResourceType,
  SysEventType,
  TenantBucketFactory,
  TenantBucketPurpose,
  TenantBucketRepository,
  TenantPlan,
  TenantRepository,
} from '@arcaai/domains';
import { BadRequestException, ForbiddenException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ClsService } from 'nestjs-cls';
import { BaseService, isSuperAdmin } from '../../common';
import { IActiveUserContext } from '../../interfaces';
import { IBlobStorageService } from '../baseServices/storage/IBlobStorageService';
import { IS3Service } from '../baseServices/storage/s3/IS3Service';
import { ITenantBucketService } from './ITenantBucketService';
// Plan-tier storageQuotaBytes matrix (STARTER default etc.).
// Imported directly (not IEntitlementsService) since bucket provisioning runs
// before any per-tenant TenantEntitlement override can exist, so the seeded
// per-plan default IS the resolved value at tenant-creation time.
import { PLAN_ENTITLEMENT_DEFAULTS } from '../entitlements/entitlements.constants';
import {
  CreateTenantBucketRequest,
  DeleteTenantBucketObjectResponse,
  SetTenantBucketDefaultsRequest,
  TenantBucketDefaultsResponse,
  TenantBucketObjectResponse,
  TenantBucketPhysicalResponse,
  TenantBucketResponse,
  TenantBucketTreeNodeResponse,
  TenantBucketTreeResponse,
} from './dto';
import { TenantBucketDtoMapper } from './tenant-bucket.dto.mapper';

/** Lifetime of presigned download URLs (mirrors the S3 service default). */
const PRESIGNED_GET_EXPIRY_SECONDS = 3600;

interface TreeNodeAccumulator {
  node: TenantBucketTreeNodeResponse;
  children: Map<string, TreeNodeAccumulator>;
}

/**
 * Whether a provider error means "the bucket is not there" — the one bucket
 * removal failure that still counts as reaching the desired end state. Same
 * discrimination `S3BlobProvider.bucketExists` already makes; Azure's
 * `deleteIfExists` never surfaces this shape at all.
 */
function isBucketAlreadyGone(error: unknown): boolean {
  const status = (error as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
  const name = (error as { name?: string })?.name;
  return status === 404 || name === 'NotFound' || name === 'NoSuchBucket';
}

@Injectable()
export class TenantBucketService extends BaseService implements ITenantBucketService {
  private readonly logger = new Logger(TenantBucketService.name);

  constructor(
    private readonly tenantBucketRepository: TenantBucketRepository,
    private readonly tenantRepository: TenantRepository,
    // Tenant-aware data plane (object list/upload/presign + bucket create) routes
    // to the per-tenant provider (S3/MinIO or Azure) via the resolved config.
    @Inject(IBlobStorageService) private readonly blobStorage: IBlobStorageService,
    // Retained only for S3/MinIO bucket-policy hardening, which has no
    // provider-agnostic equivalent (Azure containers are private by default).
    @Inject(IS3Service) private readonly s3Service: IS3Service,
    protected override readonly eventEmitter: EventEmitter2,
    protected override readonly clsService: ClsService<IActiveUserContext>,
  ) {
    super(eventEmitter, clsService, ResourceType.TenantBucket);
  }

  async listBuckets(options?: { includeDisabled?: boolean }): Promise<TenantBucketResponse[]> {
    // An unscoped SUPER_ADMIN (no working tenant selected) lists
    // buckets CROSS-TENANT; every other caller keeps the strict tenant
    // requirement.
    const tenantId = this.tenantId;
    const crossTenant = !tenantId && isSuperAdmin(this.clsService.get('user'));
    if (!tenantId && !crossTenant) {
      throw new BadRequestException('Tenant ID is required');
    }

    const buckets = crossTenant
      ? await this.tenantBucketRepository.findAllCrossTenant(options)
      : await this.tenantBucketRepository.findAllByTenant(tenantId as string, options);

    this.broadcastSysEvent(SysEventType.ResourceViewed, {
      data: { count: buckets.length },
    });

    return buckets.map(TenantBucketDtoMapper.toResponse);
  }

  /**
   * "All tenants" storage-browser listing (TASK-932 Lane T): every registered
   * `TenantBucket` row across every tenant, MERGED with the physical bucket
   * list from the storage provider (`IS3Service.listAllBuckets`) so a
   * platform admin can also see orphaned/unregistered physical buckets and
   * registered rows whose physical bucket has vanished.
   *
   * Restricted to an unscoped SUPER_ADMIN (no working tenant) — unlike
   * `listBuckets()`, a tenant-bound caller (even a super admin who picked a
   * working tenant) gets a 400 rather than falling back to its own tenant's
   * buckets: this method's whole point is cross-tenant + physical
   * enumeration, and a tenant-bound caller must never reach it.
   */
  async listBucketsCrossTenantWithPhysical(): Promise<TenantBucketPhysicalResponse[]> {
    const tenantId = this.tenantId;
    if (tenantId || !isSuperAdmin(this.clsService.get('user'))) {
      throw new BadRequestException('includePhysical is only available to a platform admin with no tenant context');
    }

    const [registeredRows, physicalBuckets] = await Promise.all([
      this.tenantBucketRepository.findAllCrossTenant(),
      this.s3Service.listAllBuckets(),
    ]);

    const uniqueTenantIds = [...new Set(registeredRows.map((bucket) => bucket.tenantId))];
    const tenants = uniqueTenantIds.length ? await this.tenantRepository.findAll({ filters: { id: { in: uniqueTenantIds } } }) : [];
    const tenantNameById = new Map(tenants.map((tenant) => [tenant.id, tenant.name]));

    const physicalByName = new Map(physicalBuckets.map((bucket) => [bucket.name, bucket]));
    const registeredNames = new Set(registeredRows.map((bucket) => bucket.name));

    const registered: TenantBucketPhysicalResponse[] = registeredRows.map((bucket) => ({
      name: bucket.name,
      creationDate: bucket.createdAt.toISOString(),
      tenantId: bucket.tenantId,
      tenantName: tenantNameById.get(bucket.tenantId) ?? null,
      registered: true,
      physicalMissing: !physicalByName.has(bucket.name),
      // A registered row can only carry a platform name if one was adopted
      // before `adoptPhysicalBucket`'s guard existed — flag it rather than
      // hide it, so the console can show what needs unwinding.
      platform: isPlatformBucket(bucket.name),
    }));

    const unregistered: TenantBucketPhysicalResponse[] = physicalBuckets
      .filter((bucket) => !registeredNames.has(bucket.name))
      .map((bucket) => ({
        name: bucket.name,
        creationDate: bucket.creationDate,
        tenantId: null,
        tenantName: null,
        registered: false,
        physicalMissing: false,
        platform: isPlatformBucket(bucket.name),
      }));

    const combined = [...registered, ...unregistered];

    this.broadcastSysEvent(SysEventType.ResourceViewed, {
      data: { count: combined.length, registeredCount: registered.length, unregisteredCount: unregistered.length },
    });

    return combined;
  }

  async getBucketById(id: string): Promise<TenantBucketResponse | null> {
    const bucket = await this.tenantBucketRepository.findById(id);
    if (!bucket) return null;

    this.broadcastSysEvent(SysEventType.ResourceViewed, {
      resourceId: bucket.id,
    });

    return TenantBucketDtoMapper.toResponse(bucket);
  }

  async getBucketTree(id: string, prefix = ''): Promise<TenantBucketTreeResponse> {
    const bucket = await this.tenantBucketRepository.findById(id);
    if (!bucket) {
      throw new NotFoundException(`Bucket ${id} not found`);
    }

    const tenantId = this.tenantId;
    if (tenantId && bucket.tenantId !== tenantId) {
      throw new ForbiddenException('You do not have access to this bucket');
    }

    const normalizedPrefix = this.normalizePrefix(prefix);
    await this.ensureProviderBucket(bucket.name);
    const { objects: files } = await this.blobStorage.listObjects({ bucket: bucket.name, prefix: normalizedPrefix });

    const nodes = this.buildTreeNodes(files, normalizedPrefix);

    this.broadcastSysEvent(SysEventType.ResourceViewed, {
      resourceId: bucket.id,
      data: {
        rootPath: normalizedPrefix,
        nodeCount: nodes.length,
      },
    });

    return {
      bucketId: bucket.id,
      bucketName: bucket.name,
      rootPath: normalizedPrefix,
      nodes,
    };
  }

  async getBucketBySlug(slug: string): Promise<TenantBucketResponse | null> {
    const tenantId = this.tenantId;
    if (!tenantId) {
      throw new BadRequestException('Tenant ID is required');
    }

    const bucket = await this.tenantBucketRepository.findBySlug(tenantId, slug);
    if (!bucket) return null;

    this.broadcastSysEvent(SysEventType.ResourceViewed, {
      resourceId: bucket.id,
    });

    return TenantBucketDtoMapper.toResponse(bucket);
  }

  async getBucketByName(name: string): Promise<TenantBucketResponse | null> {
    const bucket = await this.tenantBucketRepository.findByName(name);
    if (!bucket) return null;

    const tenantId = this.tenantId;
    if (tenantId && bucket.tenantId !== tenantId) {
      return null;
    }

    return TenantBucketDtoMapper.toResponse(bucket);
  }

  async getBucketByPurpose(purpose: TenantBucketPurpose): Promise<TenantBucketResponse | null> {
    const tenantId = this.tenantId;
    if (!tenantId) {
      throw new BadRequestException('Tenant ID is required');
    }

    const bucket = await this.tenantBucketRepository.findByPurpose(tenantId, purpose);
    return bucket ? TenantBucketDtoMapper.toResponse(bucket) : null;
  }

  async getDefaultBuckets(): Promise<TenantBucketDefaultsResponse> {
    const tenantId = this.tenantId;
    if (!tenantId) {
      throw new BadRequestException('Tenant ID is required');
    }

    const [audio, attachments, misc] = await Promise.all([
      this.tenantBucketRepository.findByPurpose(tenantId, TenantBucketPurpose.AUDIO),
      this.tenantBucketRepository.findByPurpose(tenantId, TenantBucketPurpose.ATTACHMENTS),
      this.tenantBucketRepository.findByPurpose(tenantId, TenantBucketPurpose.MISC),
    ]);

    return {
      audio: audio ? TenantBucketDtoMapper.toResponse(audio) : null,
      attachments: attachments ? TenantBucketDtoMapper.toResponse(attachments) : null,
      misc: misc ? TenantBucketDtoMapper.toResponse(misc) : null,
    };
  }

  async setDefaultBuckets(dto: SetTenantBucketDefaultsRequest): Promise<TenantBucketDefaultsResponse> {
    const tenantId = this.tenantId;
    if (!tenantId) {
      throw new BadRequestException('Tenant ID is required');
    }

    if (dto.audioBucketId) {
      await this.assignPurpose(tenantId, dto.audioBucketId, TenantBucketPurpose.AUDIO);
    }
    if (dto.attachmentsBucketId) {
      await this.assignPurpose(tenantId, dto.attachmentsBucketId, TenantBucketPurpose.ATTACHMENTS);
    }
    if (dto.miscBucketId) {
      await this.assignPurpose(tenantId, dto.miscBucketId, TenantBucketPurpose.MISC);
    }

    this.broadcastSysEvent(SysEventType.ResourceUpdated, {
      data: {
        audioBucketId: dto.audioBucketId ?? null,
        attachmentsBucketId: dto.attachmentsBucketId ?? null,
        miscBucketId: dto.miscBucketId ?? null,
      },
    });

    return this.getDefaultBuckets();
  }

  /**
   * Make `bucketId` the tenant's default bucket for `purpose`. Idempotent when
   * the bucket already holds it; otherwise the previous holder is reverted to
   * CUSTOM so `findByPurpose` resolution stays unambiguous.
   */
  private async assignPurpose(tenantId: string, bucketId: string, purpose: TenantBucketPurpose): Promise<void> {
    const target = await this.tenantBucketRepository.findById(bucketId).catch(() => null);
    if (!target || target.tenantId !== tenantId) {
      throw new NotFoundException(`Bucket ${bucketId} not found`);
    }
    if (target.purpose === purpose) {
      return;
    }

    const current = await this.tenantBucketRepository.findByPurpose(tenantId, purpose);
    if (current && current.id !== target.id) {
      current.purpose = TenantBucketPurpose.CUSTOM;
      current.updatedBy = this.requestUserId ?? undefined;
      await this.tenantBucketRepository.update(current.id, current);
    }

    target.purpose = purpose;
    target.updatedBy = this.requestUserId ?? undefined;
    await this.tenantBucketRepository.update(target.id, target);
  }

  async provisionSystemBuckets(tenantId: string): Promise<TenantBucketResponse[]> {
    const tenant = await this.tenantRepository.findById(tenantId);
    if (!tenant) {
      throw new NotFoundException(`Tenant ${tenantId} not found`);
    }

    const existingSystemBuckets = await this.tenantBucketRepository.findSystemBuckets(tenantId);
    const existingSlugs = new Set(existingSystemBuckets.map((b) => b.slug));

    const allSystemBuckets = TenantBucketFactory.CreateDefaultSystemBuckets(tenantId, tenant.key as string);

    const toCreate = allSystemBuckets.filter((b) => !existingSlugs.has(b.slug));

    if (toCreate.length === 0) {
      this.logger.log({
        message: 'System buckets already provisioned',
        tenantId,
      });
      return [];
    }

    const created: TenantBucketResponse[] = [];
    for (const bucket of toCreate) {
      try {
        await this.blobStorage.createBucket(bucket.name);
      } catch (error) {
        this.logger.warn({
          message: 'Bucket may already exist, continuing with DB record',
          bucketName: bucket.name,
          error: error instanceof Error ? error.message : String(error),
        });
      }

      // Best-effort S3/MinIO tenant-isolation policy on the SHARED store. No-op
      // for tenants on a DEDICATED Azure/S3 provider (no global bucket to target);
      // failures are swallowed below.
      try {
        await this.s3Service.setBucketPolicy(bucket.name, {
          Version: '2012-10-17',
          Statement: [
            {
              Effect: 'Allow',
              Principal: { AWS: ['*'] },
              Action: ['s3:GetObject', 's3:PutObject', 's3:ListBucket'],
              Resource: [`arn:aws:s3:::${bucket.name}`, `arn:aws:s3:::${bucket.name}/*`],
              Condition: { StringEquals: { 'aws:PrincipalTag/tenantId': tenantId } },
            },
          ],
        });
      } catch (error) {
        this.logger.warn({
          message: 'Failed to set bucket policy, continuing',
          bucketName: bucket.name,
          error: error instanceof Error ? error.message : String(error),
        });
      }

      const saved = await this.tenantBucketRepository.create(bucket);
      created.push(TenantBucketDtoMapper.toResponse(saved));
    }

    this.logger.log({
      message: 'System buckets provisioned',
      tenantId,
      buckets: created.map((b) => b.slug),
    });

    return created;
  }

  /**
   * Writes the plan's `storageQuotaBytes` onto the tenant's
   * primary (AUDIO) system bucket as `TenantBucket.quotaBytes`, so
   * `getUsageStats`'s `SUM(TenantBucket.quotaBytes)` reflects the plan's
   * capacity. Best-effort/idempotent: a `null` plan (ungated/system tenant),
   * a missing AUDIO bucket, an already-quota'd bucket, or a `null`
   * (unlimited-tier) `storageQuotaBytes` are all safe no-ops.
   */
  async applyPlanStorageQuota(tenantId: string, plan: TenantPlan | null): Promise<void> {
    if (!plan) {
      return;
    }

    const systemBuckets = await this.tenantBucketRepository.findSystemBuckets(tenantId);
    const primary = systemBuckets.find((b) => b.purpose === TenantBucketPurpose.AUDIO) ?? systemBuckets[0];
    if (!primary || primary.quotaBytes != null) {
      return;
    }

    const storageQuotaBytes = PLAN_ENTITLEMENT_DEFAULTS[plan]?.storageQuotaBytes;
    if (storageQuotaBytes == null) {
      return;
    }

    primary.quotaBytes = BigInt(storageQuotaBytes);
    await this.tenantBucketRepository.update(primary.id, primary);
  }

  async createCustomBucket(dto: CreateTenantBucketRequest): Promise<TenantBucketResponse> {
    const tenantId = this.tenantId;
    const userId = this.requestUserId;

    if (!tenantId) {
      throw new BadRequestException('Tenant ID is required');
    }

    const existing = await this.tenantBucketRepository.findBySlug(tenantId, dto.slug);
    if (existing) {
      throw new BadRequestException(`Bucket with slug '${dto.slug}' already exists for this tenant`);
    }

    const tenant = await this.tenantRepository.findById(tenantId);
    if (!tenant) {
      throw new NotFoundException(`Tenant ${tenantId} not found`);
    }

    const bucket = TenantBucketFactory.CreateCustomBucket(tenantId, tenant.key as string, dto.slug, dto.description, userId ?? undefined);

    // The DERIVED name is checked, not the slug: `buildBucketName` produces
    // `hope-<slug>-<tenantKey>`, so a tenant keyed `chunks` asking for slug
    // `audio` lands exactly on the global `hope-audio-chunks`. Without this
    // the create would adopt STT's streaming-chunk bucket as a tenant bucket
    // and hand that tenant a delete button for it.
    this.assertNotPlatformBucket(bucket.name, 'used as a tenant bucket name');

    try {
      await this.blobStorage.createBucket(bucket.name);
    } catch (error) {
      this.logger.warn({
        message: 'Bucket creation may have failed, continuing with DB record',
        bucketName: bucket.name,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    const saved = await this.tenantBucketRepository.create(bucket);

    this.broadcastSysEvent(SysEventType.ResourceCreated, {
      resourceId: saved.id,
      createdAt: saved.createdAt,
      data: { slug: dto.slug, name: saved.name },
    });

    return TenantBucketDtoMapper.toResponse(saved);
  }

  /**
   * Persist a TenantBucket row for an already-named S3 bucket created via
   * `POST /storage/buckets`. Without this row the bucket is invisible to the
   * `@TenantOwnedResource('TenantBucket', lookup: 'name')` guard on the
   * GET/PATCH/DELETE routes, so a freshly-created bucket would 404 on every
   * management call. Idempotent: re-registering an existing name owned by the
   * caller returns it unchanged; a name owned by another tenant is rejected.
   *
   * When there is no tenant context (e.g. a platform SUPER_ADMIN creating a
   * bucket without a tenant-scoped JWT) there is no owner to attribute the row
   * to, so registration is skipped and `null` is returned — the S3 bucket is
   * still created by the caller, it just isn't a tenant-owned managed resource.
   * This keeps `POST /storage/buckets` succeeding for platform admins while the
   * tenant-owned management routes stay 404 for non-tenant callers.
   */
  async registerBucket(name: string, description?: string): Promise<TenantBucketResponse | null> {
    // A platform bucket is never tenant-ownable. Rejected BEFORE the
    // no-tenant-context early return: a platform admin creating
    // `hope-models` through `POST /storage/buckets` must get an error, not a
    // silent skip that leaves an untracked physical bucket behind.
    this.assertNotPlatformBucket(name, 'registered to a tenant');

    const tenantId = this.tenantId;
    if (!tenantId) {
      this.logger.debug(`registerBucket skipped for '${name}': no tenant context (platform-level caller)`);
      return null;
    }

    const existing = await this.tenantBucketRepository.findByName(name);
    if (existing) {
      if (existing.tenantId !== tenantId) {
        throw new BadRequestException(`Bucket '${name}' already exists`);
      }
      return TenantBucketDtoMapper.toResponse(existing);
    }

    const userId = this.requestUserId;
    const bucket = TenantBucketFactory.CreateNamedBucket(tenantId, name, description, userId ?? undefined);
    const saved = await this.tenantBucketRepository.create(bucket);

    this.broadcastSysEvent(SysEventType.ResourceCreated, {
      resourceId: saved.id,
      createdAt: saved.createdAt,
      data: { slug: saved.slug, name: saved.name },
    });

    return TenantBucketDtoMapper.toResponse(saved);
  }

  /**
   * Refuse any write that would make a PLATFORM bucket tenant-owned (or
   * destroy it). Shared by `registerBucket`, `adoptPhysicalBucket` and
   * `deleteBucket` so the three entry points cannot drift apart.
   */
  private assertNotPlatformBucket(name: string, action: string): void {
    if (!isPlatformBucket(name)) return;
    throw new BadRequestException(
      `'${name}' is a platform bucket and cannot be ${action}. It is owned by the platform (model weights, MLflow artifacts, backups or the workflow claim check), not by any tenant.`,
    );
  }

  /**
   * Adopt an EXISTING physical bucket into a tenant — the admin-plane
   * counterpart of `registerBucket`, which can only ever attribute a bucket
   * to the caller's own tenant context.
   *
   * The storage browser's "All tenants" view is an UNSCOPED platform admin
   * (`listBucketsCrossTenantWithPhysical` rejects a tenant-bound caller
   * outright), so there is no ambient tenant to inherit and the owning
   * tenant arrives explicitly — the same shape `provisionSystemBuckets`
   * already uses for the same reason.
   *
   * Adoption is REGISTRY-ONLY: the physical bucket already exists and is left
   * exactly as it is. Nothing is created, moved or rewritten.
   */
  async adoptPhysicalBucket(name: string, tenantId: string, description?: string): Promise<TenantBucketResponse> {
    const trimmed = name.trim();
    if (!trimmed) {
      throw new BadRequestException('Bucket name is required');
    }
    this.assertNotPlatformBucket(trimmed, 'registered to a tenant');

    const tenant = await this.tenantRepository.findById(tenantId);
    if (!tenant) {
      throw new NotFoundException(`Tenant ${tenantId} not found`);
    }

    const existing = await this.tenantBucketRepository.findByName(trimmed);
    if (existing) {
      // Idempotent for the same owner; a different owner is a conflict the
      // caller must resolve, never a silent re-attribution.
      if (existing.tenantId !== tenantId) {
        throw new BadRequestException(`Bucket '${trimmed}' is already registered to another tenant`);
      }
      return TenantBucketDtoMapper.toResponse(existing);
    }

    // Adopt only what the provider actually has: registering a name with no
    // physical bucket behind it manufactures a row that every object route
    // then 404s on, which is the `physicalMissing` state the browser exists
    // to surface — not something an adopt action should create.
    const physicalBuckets = await this.s3Service.listAllBuckets();
    if (!physicalBuckets.some((bucket) => bucket.name === trimmed)) {
      throw new NotFoundException(`No physical bucket named '${trimmed}' exists in the storage provider`);
    }

    const bucket = TenantBucketFactory.CreateNamedBucket(tenantId, trimmed, description, this.requestUserId ?? undefined);
    const saved = await this.tenantBucketRepository.create(bucket);

    this.broadcastSysEvent(SysEventType.ResourceCreated, {
      resourceId: saved.id,
      createdAt: saved.createdAt,
      data: { slug: saved.slug, name: saved.name, tenantId, adopted: true },
    });

    this.logger.log({ message: 'Adopted an existing physical bucket', bucketName: saved.name, tenantId });

    return TenantBucketDtoMapper.toResponse(saved);
  }

  async deleteBucket(id: string): Promise<TenantBucketResponse> {
    const bucket = await this.tenantBucketRepository.findById(id);
    if (!bucket) {
      throw new NotFoundException(`Bucket ${id} not found`);
    }

    if (bucket.isSystemBucket) {
      throw new ForbiddenException('System buckets cannot be deleted');
    }

    // `CreateNamedBucket` stamps CUSTOM, so an adopted platform bucket (one
    // registered before the guard above existed) would otherwise pass the
    // system-bucket check and reach `blobStorage.deleteBucket`.
    this.assertNotPlatformBucket(bucket.name, 'deleted');

    // Remove the physical bucket/container via the tenant-resolved provider
    // (S3/MinIO/Azure). A bucket that is ALREADY GONE is the one tolerable
    // failure — the desired end state is reached, so the soft-delete proceeds
    // rather than stranding a row that points at nothing.
    //
    // Every other provider failure is re-raised instead of being swallowed.
    // Swallowing it soft-deletes the row while the bucket survives, so the
    // registry says "deleted" and the objects are still there, reachable by
    // anything holding credentials — a divergence nothing downstream can
    // detect. Object lock (`hope-models`) and a non-empty bucket both land
    // here, and both are exactly the cases an operator must be told about.
    try {
      await this.blobStorage.deleteBucket(bucket.name);
    } catch (error) {
      if (!isBucketAlreadyGone(error)) {
        this.logger.error({
          message: 'Provider bucket removal failed; refusing to soft-delete the row',
          bucketName: bucket.name,
          error: error instanceof Error ? error.message : String(error),
        });
        throw new BadRequestException(
          `Could not remove the physical bucket '${bucket.name}': ${error instanceof Error ? error.message : String(error)}. The bucket record was left in place so it keeps matching what is actually in storage.`,
        );
      }
      this.logger.warn({
        message: 'Provider bucket was already gone; continuing with soft-delete',
        bucketName: bucket.name,
      });
    }

    const deleted = await this.tenantBucketRepository.softDelete(id);

    this.broadcastSysEvent(SysEventType.ResourceDeleted, {
      resourceId: deleted.id,
      data: { slug: deleted.slug, name: deleted.name },
    });

    return TenantBucketDtoMapper.toResponse(deleted);
  }

  async listObjects(bucketId: string, prefix = ''): Promise<TenantBucketObjectResponse[]> {
    const bucket = await this.tenantBucketRepository.findById(bucketId);
    if (!bucket) {
      throw new NotFoundException(`Bucket ${bucketId} not found`);
    }

    const tenantId = this.tenantId;
    if (tenantId && bucket.tenantId !== tenantId) {
      throw new ForbiddenException('You do not have access to this bucket');
    }

    const normalizedPrefix = this.normalizePrefix(prefix);
    await this.ensureProviderBucket(bucket.name);
    const { objects } = await this.blobStorage.listObjects({ bucket: bucket.name, prefix: normalizedPrefix });

    this.broadcastSysEvent(SysEventType.ResourceViewed, {
      resourceId: bucket.id,
      data: { prefix: normalizedPrefix, count: objects.length },
    });

    return objects.map((object) => ({
      key: object.key,
      size: object.size,
      lastModified: object.lastModified ? new Date(object.lastModified).toISOString() : undefined,
    }));
  }

  async uploadObject(bucketId: string, fileKey: string, body: Buffer, contentType?: string): Promise<TenantBucketObjectResponse> {
    const bucket = await this.tenantBucketRepository.findById(bucketId);
    if (!bucket) {
      throw new NotFoundException(`Bucket ${bucketId} not found`);
    }

    const tenantId = this.tenantId;
    if (tenantId && bucket.tenantId !== tenantId) {
      throw new ForbiddenException('You do not have access to this bucket');
    }

    // Reject `..` traversal but allow `/` so nested folder keys (e.g.
    // `patients/2026/file.wav`) upload correctly — mirrors deleteObject.
    if (/[.]{2}/.test(fileKey)) {
      throw new BadRequestException('Invalid file key: path traversal not allowed');
    }

    // Provider-side object write (NOT a SQL op — there is no per-object DB row).
    await this.ensureProviderBucket(bucket.name);
    await this.blobStorage.putObject({ bucket: bucket.name, key: fileKey, body, contentType });

    this.broadcastSysEvent(SysEventType.ResourceCreated, {
      resourceId: bucket.id,
      data: { fileKey },
    });

    return { key: fileKey, size: body.length, lastModified: new Date().toISOString() };
  }

  async deleteObject(bucketId: string, fileKey: string): Promise<DeleteTenantBucketObjectResponse> {
    const bucket = await this.tenantBucketRepository.findById(bucketId);
    if (!bucket) {
      throw new NotFoundException(`Bucket ${bucketId} not found`);
    }

    const tenantId = this.tenantId;
    if (tenantId && bucket.tenantId !== tenantId) {
      throw new ForbiddenException('You do not have access to this bucket');
    }

    if (/[.]{2}/.test(fileKey)) {
      throw new BadRequestException('Invalid file key: path traversal not allowed');
    }

    // Provider-side object removal (NOT a SQL op — there is no per-object DB row).
    await this.ensureProviderBucket(bucket.name);
    await this.blobStorage.deleteObject({ bucket: bucket.name, key: fileKey });

    this.broadcastSysEvent(SysEventType.ResourceDeleted, {
      resourceId: bucket.id,
      data: { fileKey },
    });

    return { key: fileKey, deleted: true };
  }

  async getPresignedUrl(bucketId: string, fileKey: string): Promise<{ url: string }> {
    const bucket = await this.tenantBucketRepository.findById(bucketId);
    if (!bucket) {
      throw new NotFoundException(`Bucket ${bucketId} not found`);
    }

    const tenantId = this.tenantId;
    if (tenantId && bucket.tenantId !== tenantId) {
      throw new ForbiddenException('You do not have access to this bucket');
    }

    if (/[.]{2}/.test(fileKey)) {
      throw new BadRequestException('Invalid file key: path traversal not allowed');
    }

    const url = await this.blobStorage.presignGet({
      bucket: bucket.name,
      key: fileKey,
      expiresInSeconds: PRESIGNED_GET_EXPIRY_SECONDS,
    });

    this.broadcastSysEvent(SysEventType.ResourceViewed, {
      resourceId: bucket.id,
      data: { fileKey },
    });

    return { url };
  }

  /**
   * Seeded/system bucket rows can predate the physical bucket (the
   * DB seed provisions rows only and defers provider buckets to "the storage
   * flow"). Ensure the provider-side bucket exists before a data-plane call so
   * a freshly-seeded bucket lists as empty instead of failing with
   * NoSuchBucket. When the existence check itself fails (storage down,
   * credentials) we skip creation and let the data-plane call surface the real
   * error; a lost create race ("already exists/owned") is logged and ignored.
   */
  private async ensureProviderBucket(bucketName: string): Promise<void> {
    const exists = await this.blobStorage.bucketExists(bucketName).catch(() => true);
    if (exists) return;

    try {
      await this.blobStorage.createBucket(bucketName);
      this.logger.log({ message: 'Provisioned missing provider bucket on demand', bucketName });
    } catch (error) {
      this.logger.warn({
        message: 'On-demand provider bucket creation failed; continuing',
        bucketName,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private normalizePrefix(prefix?: string): string {
    const raw = (prefix ?? '').trim().replace(/\\/g, '/');
    if (!raw) return '';
    if (raw.includes('..')) {
      throw new BadRequestException('Invalid prefix: path traversal is not allowed');
    }

    const normalized = raw.replace(/^\/+/, '');
    return normalized.endsWith('/') ? normalized : `${normalized}/`;
  }

  private buildTreeNodes(
    files: Array<{ key?: string; size?: number; lastModified?: string | Date }>,
    rootPath: string,
  ): TenantBucketTreeNodeResponse[] {
    const root = new Map<string, TreeNodeAccumulator>();

    for (const file of files) {
      const key = file.key?.trim();
      if (!key) continue;

      const relativePath = rootPath && key.startsWith(rootPath) ? key.slice(rootPath.length) : key;
      const cleanRelativePath = relativePath.replace(/^\/+/, '');
      if (!cleanRelativePath) continue;

      const rawParts = cleanRelativePath.split('/').filter(Boolean);
      if (rawParts.length === 0) continue;

      const isFolderMarker = key.endsWith('/');
      const parts = rawParts;
      let currentMap = root;
      let currentPath = rootPath;

      for (let index = 0; index < parts.length; index += 1) {
        const part = parts[index]!;
        const isLast = index === parts.length - 1;
        const shouldBeFile = isLast && !isFolderMarker;

        if (shouldBeFile) {
          currentPath = `${currentPath}${part}`;
          if (!currentMap.has(part)) {
            currentMap.set(part, {
              node: {
                id: `file:${currentPath}`,
                name: part,
                type: 'file',
                path: currentPath,
                size: typeof file.size === 'number' ? file.size : 0,
                lastModified: file.lastModified ? new Date(file.lastModified).toISOString() : undefined,
              },
              children: new Map(),
            });
          }
          continue;
        }

        currentPath = `${currentPath}${part}/`;
        let folderEntry = currentMap.get(part);
        if (!folderEntry) {
          folderEntry = {
            node: {
              id: `folder:${currentPath}`,
              name: part,
              type: 'folder',
              path: currentPath,
              children: [],
            },
            children: new Map(),
          };
          currentMap.set(part, folderEntry);
        }
        currentMap = folderEntry.children;
      }
    }

    return this.serializeTree(root);
  }

  private serializeTree(tree: Map<string, TreeNodeAccumulator>): TenantBucketTreeNodeResponse[] {
    const nodes = Array.from(tree.values()).map(({ node, children }) => {
      if (node.type === 'folder') {
        return {
          ...node,
          children: this.serializeTree(children),
        };
      }
      return node;
    });

    return nodes.sort((a, b) => {
      if (a.type !== b.type) {
        return a.type === 'folder' ? -1 : 1;
      }
      return a.name.localeCompare(b.name);
    });
  }
}
