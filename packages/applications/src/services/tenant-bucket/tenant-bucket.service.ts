import { Inject, Injectable, BadRequestException, NotFoundException, ForbiddenException, Logger } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { TenantBucketRepository, TenantRepository, TenantBucketFactory, ResourceType, SysEventType } from '@arcaai/domains';
import { ITenantBucketService } from './ITenantBucketService';
import { TenantBucketResponse, CreateTenantBucketRequest, TenantBucketTreeResponse, TenantBucketTreeNodeResponse } from './dto';
import { TenantBucketDtoMapper } from './tenant-bucket.dto.mapper';
import { BaseService } from '../../common';
import { IActiveUserContext } from '../../interfaces';
import { IS3Service } from '../baseServices/storage/s3/IS3Service';

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
    const files = await this.s3Service.listFiles(bucket.name, normalizedPrefix);

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
        await this.s3Service.createBucket(bucket.name);
      } catch (error) {
        this.logger.warn({
          message: 'S3 bucket may already exist, continuing with DB record',
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
      await this.s3Service.createBucket(bucket.name);
    } catch (error) {
      this.logger.warn({
        message: 'S3 bucket creation may have failed, continuing with DB record',
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
