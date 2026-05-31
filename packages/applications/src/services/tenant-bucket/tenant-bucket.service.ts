import { ResourceType, SysEventType, TenantBucketFactory, TenantBucketPurpose, TenantBucketRepository, TenantRepository } from '@arcaai/domains';
import { BadRequestException, ForbiddenException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ClsService } from 'nestjs-cls';
import { BaseService } from '../../common';
import { IActiveUserContext } from '../../interfaces';
import { IBlobStorageService } from '../baseServices/storage/IBlobStorageService';
import { IS3Service } from '../baseServices/storage/s3/IS3Service';
import { ITenantBucketService } from './ITenantBucketService';
import {
  CreateTenantBucketRequest,
  SetTenantBucketDefaultsRequest,
  TenantBucketDefaultsResponse,
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
    const tenantId = this.tenantId;
    if (!tenantId) {
      throw new BadRequestException('Tenant ID is required');
    }

    const buckets = await this.tenantBucketRepository.findAllByTenant(tenantId, options);

    this.broadcastSysEvent(SysEventType.ResourceViewed, {
      data: { count: buckets.length },
    });

    return buckets.map(TenantBucketDtoMapper.toResponse);
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
   * tenant-owned management routes stay 404 for non-tenant callers (W3.2).
   */
  async registerBucket(name: string, description?: string): Promise<TenantBucketResponse | null> {
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

  async deleteBucket(id: string): Promise<TenantBucketResponse> {
    const bucket = await this.tenantBucketRepository.findById(id);
    if (!bucket) {
      throw new NotFoundException(`Bucket ${id} not found`);
    }

    if (bucket.isSystemBucket) {
      throw new ForbiddenException('System buckets cannot be deleted');
    }

    const deleted = await this.tenantBucketRepository.softDelete(id);

    this.broadcastSysEvent(SysEventType.ResourceDeleted, {
      resourceId: deleted.id,
      data: { slug: deleted.slug, name: deleted.name },
    });

    return TenantBucketDtoMapper.toResponse(deleted);
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
