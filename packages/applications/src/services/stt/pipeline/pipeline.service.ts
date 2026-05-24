import { AsrPipelineFactory, AsrPipelineRepository, ResourceType, SysEventType } from '@arcaai/domains';
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ClsService } from 'nestjs-cls';
import { parse } from 'yaml';
import { BaseService } from '../../../common';
import { IActiveUserContext } from '../../../interfaces';
import { IPipelineService } from './IPipelineService';
import { CreatePipelineRequest, PaginatedPipelineResponse, PipelineResponse, UpdatePipelineRequest } from './dto';
import { PipelineDtoMapper } from './pipeline.dto.mapper';

@Injectable()
export class PipelineService extends BaseService implements IPipelineService {
  constructor(
    private readonly pipelineRepository: AsrPipelineRepository,
    protected override readonly eventEmitter: EventEmitter2,
    protected override readonly clsService: ClsService<IActiveUserContext>,
  ) {
    super(eventEmitter, clsService, ResourceType.AsrPipeline);
  }

  /**
   * Create a new ASR pipeline
   */
  async create(dto: CreatePipelineRequest): Promise<PipelineResponse> {
    const tenantId = this.tenantId;
    const userId = this.requestUserId;

    if (!tenantId) {
      throw new BadRequestException('Tenant ID is required');
    }

    // Check if slug already exists
    const isUnique = await this.pipelineRepository.isSlugUnique(tenantId, dto.slug);
    if (!isUnique) {
      throw new BadRequestException(`Pipeline with slug '${dto.slug}' already exists`);
    }

    // Validate YAML configuration
    const validation = await this.validateYaml(dto.configYaml);
    if (!validation.valid) {
      throw new BadRequestException(`Invalid pipeline configuration: ${validation.errors?.join(', ')}`);
    }

    const pipeline = AsrPipelineFactory.CreateAsrPipeline({
      tenantId,
      name: dto.name,
      slug: dto.slug,
      description: dto.description,
      configYaml: dto.configYaml,
      tags: dto.tags,
      createdBy: userId ?? undefined,
    });

    const saved = await this.pipelineRepository.create(pipeline);

    this.broadcastSysEvent(SysEventType.ResourceCreated, {
      resourceId: saved.id,
      createdAt: saved.createdAt,
      data: { slug: dto.slug, name: dto.name },
    });

    return PipelineDtoMapper.toResponse(saved);
  }

  /**
   * Update an existing pipeline.
   *
   * TASK-302 Stream D Phase E.4 — OCC migration. Writes via Compare-And-Set
   * against the row's `_version` column. The DTO's `expectedVersion` (or
   * the controller's `If-Match`-folded value) is the CAS predicate; on
   * version drift the repository raises `OptimisticConcurrencyException`,
   * which the `ExceptionInterceptor` maps to `412 Precondition Failed`.
   */
  async update(id: string, dto: UpdatePipelineRequest): Promise<PipelineResponse> {
    const tenantId = this.tenantId;
    const userId = this.requestUserId;

    if (!tenantId) {
      throw new BadRequestException('Tenant ID is required');
    }

    const existing = await this.pipelineRepository.findById(id);
    if (!existing) {
      throw new NotFoundException(`Pipeline ${id} not found`);
    }

    if (dto.slug && dto.slug !== existing.slug) {
      const isUnique = await this.pipelineRepository.isSlugUnique(tenantId, dto.slug, id);
      if (!isUnique) {
        throw new BadRequestException(`Pipeline with slug '${dto.slug}' already exists`);
      }
    }

    if (dto.configYaml) {
      const validation = await this.validateYaml(dto.configYaml);
      if (!validation.valid) {
        throw new BadRequestException(`Invalid pipeline configuration: ${validation.errors?.join(', ')}`);
      }
    }

    if (dto.name !== undefined) existing.name = dto.name;
    if (dto.slug !== undefined) existing.slug = dto.slug;
    if (dto.description !== undefined) existing.description = dto.description;
    if (dto.configYaml !== undefined) existing.configYaml = dto.configYaml;
    if (dto.tags !== undefined) existing.tags = dto.tags;
    existing.updatedBy = userId ?? null;

    // Snapshot the pre-write `_version` BEFORE the CAS bumps it (audit
    // correlation mirrors C.8 / E.1 / E.2 / E.3).
    const previousVersion = existing.version;

    const updated = await this.pipelineRepository.updateWithVersion(id, existing, dto.expectedVersion);

    this.broadcastSysEvent(SysEventType.ResourceUpdated, {
      resourceId: updated.id,
      data: {
        slug: updated.slug,
        name: updated.name,
        previousVersion,
        newVersion: updated.version,
      },
    });

    return PipelineDtoMapper.toResponse(updated);
  }

  /**
   * Get pipeline by ID — tenant-scoped (TASK-298 D-9).
   *
   * Returns `null` when:
   *   • The pipeline does not exist, OR
   *   • The pipeline belongs to a different tenant.
   *
   * The cross-tenant case returns `null` (NOT a 403) so the API surface
   * looks identical to "not found" — this prevents existence-leak via the
   * presence/absence of an authorization error.
   */
  async getById(id: string): Promise<PipelineResponse | null> {
    const tenantId = this.tenantId;
    if (!tenantId) {
      throw new BadRequestException('Tenant ID is required');
    }

    const pipeline = await this.pipelineRepository.findById(id);
    if (!pipeline) return null;

    if (pipeline.tenantId !== tenantId) {
      return null;
    }

    this.broadcastSysEvent(SysEventType.ResourceViewed, {
      resourceId: pipeline.id,
    });

    return PipelineDtoMapper.toResponse(pipeline);
  }

  /**
   * Get pipeline by slug
   */
  async getBySlug(slug: string): Promise<PipelineResponse | null> {
    const tenantId = this.tenantId;
    if (!tenantId) {
      throw new BadRequestException('Tenant ID is required');
    }

    const pipeline = await this.pipelineRepository.findBySlug(tenantId, slug);
    if (!pipeline) return null;

    this.broadcastSysEvent(SysEventType.ResourceViewed, {
      resourceId: pipeline.id,
    });

    return PipelineDtoMapper.toResponse(pipeline);
  }

  /**
   * Get all enabled pipelines
   */
  async getAll(): Promise<PipelineResponse[]> {
    const tenantId = this.tenantId;
    if (!tenantId) {
      throw new BadRequestException('Tenant ID is required');
    }

    const pipelines = await this.pipelineRepository.findEnabledPipelines(tenantId);

    this.broadcastSysEvent(SysEventType.ResourceViewed, {
      data: { count: pipelines.length },
    });

    return pipelines.map(PipelineDtoMapper.toResponse);
  }

  /**
   * Get paginated list of pipelines
   */
  async list(page: number = 1, limit: number = 20): Promise<PaginatedPipelineResponse> {
    const tenantId = this.tenantId;
    if (!tenantId) {
      throw new BadRequestException('Tenant ID is required');
    }

    const pipelines = await this.pipelineRepository.findAll({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      filters: { tenantId } as any,
      page,
      limit,
      sort: [{ name: 'asc' }],
    });

    const total = await this.pipelineRepository.count({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      filters: { tenantId } as any,
    });

    return {
      data: pipelines.map(PipelineDtoMapper.toResponse),
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  /**
   * Soft delete a pipeline
   */
  async delete(id: string): Promise<void> {
    const userId = this.requestUserId;

    const existing = await this.pipelineRepository.findById(id);
    if (!existing) {
      throw new NotFoundException(`Pipeline ${id} not found`);
    }

    existing.delete(userId ?? undefined);
    await this.pipelineRepository.update(id, existing);

    this.broadcastSysEvent(SysEventType.ResourceDeleted, {
      resourceId: id,
      data: { slug: existing.slug },
    });
  }

  /**
   * Validate pipeline YAML configuration
   */
  async validateYaml(yaml: string): Promise<{ valid: boolean; errors?: string[] }> {
    const errors: string[] = [];

    try {
      // Basic YAML structure validation
      if (!yaml || yaml.trim().length === 0) {
        errors.push('YAML configuration is empty');
        return { valid: false, errors };
      }

      const parsed = parse(yaml);
      const root = this.asRecord(parsed);

      if (!root) {
        errors.push('YAML root must be a mapping/object');
        return { valid: false, errors };
      }

      const models = this.asRecord(root.models);
      if (!models) {
        errors.push('Missing required "models" section');
      } else if (!this.hasAsrModelReference(models.asr)) {
        errors.push('Missing required ASR model reference (models.asr)');
      }

      if (errors.length > 0) {
        return { valid: false, errors };
      }

      return { valid: true };
    } catch (error) {
      errors.push(`YAML parsing error: ${error instanceof Error ? error.message : 'Unknown error'}`);
      return { valid: false, errors };
    }
  }

  private asRecord(value: unknown): Record<string, unknown> | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return null;
    }

    return value as Record<string, unknown>;
  }

  private hasAsrModelReference(value: unknown): boolean {
    if (typeof value === 'string') {
      return value.trim().length > 0;
    }

    const asrConfig = this.asRecord(value);
    if (!asrConfig) {
      return false;
    }

    const referenceKeys = ['hf_model_id', 'model_id', 'slug', 'name', 'id'];
    return referenceKeys.some((key) => {
      const candidate = asrConfig[key];
      return typeof candidate === 'string' && candidate.trim().length > 0;
    });
  }
}
