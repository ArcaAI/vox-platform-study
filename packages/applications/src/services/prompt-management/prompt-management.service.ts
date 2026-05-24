import { Injectable, Inject, BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { ArgumentInvalidException } from '@arcaai/exceptions';
import { ClsService } from 'nestjs-cls';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  PromptTemplateRepository,
  PromptVersionRepository,
  PromptUsageRecordRepository,
  PromptTemplateFactory,
  PromptVersionFactory,
  PromptTemplateEntityMapper,
  PromptTemplateEntity,
  ResourceType,
  ResourceStatusType,
  SysEventType,
} from '@arcaai/domains';
import { IPromptManagementService } from './IPromptManagementService';
import {
  PromptTemplateResponse,
  PromptVersionResponse,
  CreatePromptTemplateRequest,
  UpdatePromptTemplateRequest,
  AssignDepartmentPromptRequest,
} from './dto';
import { PromptManagementDtoMapper } from './prompt-management.dto.mapper';
import { IDepartmentService } from '../department/IDepartmentService';
import { DepartmentResponse } from '../department/dto';
import { BaseService } from '../../common';
import { IActiveUserContext } from '../../interfaces';

const SCOPE_TENANT_DEFAULT = 'TENANT_DEFAULT';
const SCOPE_USER_PERSONAL = 'USER_PERSONAL';

@Injectable()
export class PromptManagementService extends BaseService implements IPromptManagementService {
  constructor(
    private readonly promptTemplateRepository: PromptTemplateRepository,
    private readonly promptVersionRepository: PromptVersionRepository,
    private readonly promptUsageRecordRepository: PromptUsageRecordRepository,
    @Inject(IDepartmentService) private readonly departmentService: IDepartmentService,
    protected override readonly eventEmitter: EventEmitter2,
    protected override readonly clsService: ClsService<IActiveUserContext>,
  ) {
    super(eventEmitter, clsService, ResourceType.PromptTemplate);
  }

  async createPromptTemplate(dto: CreatePromptTemplateRequest): Promise<PromptTemplateResponse> {
    const tenantId = this.tenantId;
    const userId = this.requestUserId;
    if (!tenantId) throw new BadRequestException('Tenant ID is required');
    if (!this.callerCanManageTemplates()) {
      throw new ForbiddenException('Caller cannot create tenant-default prompt templates');
    }

    const existing = await this.promptTemplateRepository.findByName(tenantId, dto.name);
    if (existing) throw new BadRequestException(`Prompt template with name '${dto.name}' already exists`);

    const template = PromptTemplateFactory.CreatePromptTemplate({
      tenantId,
      name: dto.name,
      description: dto.description ?? null,
      content: dto.content,
      category: dto.category,
      variables: dto.variables ?? null,
      departmentId: dto.departmentId ?? null,
      scope: SCOPE_TENANT_DEFAULT,
      ownerUserId: null,
      tags: dto.tags ?? [],
      createdBy: userId ?? null,
    });

    const saved = await this.promptTemplateRepository.create(template);

    const version = PromptVersionFactory.CreatePromptVersion({
      tenantId,
      promptTemplateId: saved.id,
      versionNumber: 1,
      content: dto.content,
      variables: dto.variables ?? null,
      changeReason: 'Initial version',
      changedBy: userId ?? null,
    });

    await this.promptVersionRepository.create(version);

    this.broadcastSysEvent(SysEventType.ResourceCreated, {
      resourceId: saved.id,
      data: { name: dto.name, category: dto.category },
    });

    return PromptManagementDtoMapper.toTemplateResponse(saved);
  }

  async createPersonal(dto: CreatePromptTemplateRequest): Promise<PromptTemplateResponse> {
    const tenantId = this.tenantId;
    const userId = this.requestUserId;
    if (!tenantId) throw new BadRequestException('Tenant ID is required');
    if (!userId) throw new BadRequestException('Caller user ID is required');

    const template = PromptTemplateFactory.CreatePromptTemplate({
      tenantId,
      name: dto.name,
      description: dto.description ?? null,
      content: dto.content,
      category: dto.category,
      variables: dto.variables ?? null,
      departmentId: dto.departmentId ?? null,
      scope: SCOPE_USER_PERSONAL,
      ownerUserId: userId,
      tags: dto.tags ?? [],
      createdBy: userId,
    });

    const saved = await this.promptTemplateRepository.create(template);

    const version = PromptVersionFactory.CreatePromptVersion({
      tenantId,
      promptTemplateId: saved.id,
      versionNumber: 1,
      content: dto.content,
      variables: dto.variables ?? null,
      changeReason: 'Initial personal version',
      changedBy: userId,
    });

    await this.promptVersionRepository.create(version);

    this.broadcastSysEvent(SysEventType.ResourceCreated, {
      resourceId: saved.id,
      data: { name: dto.name, category: dto.category, scope: SCOPE_USER_PERSONAL },
    });

    return PromptManagementDtoMapper.toTemplateResponse(saved);
  }

  async updatePromptTemplate(id: string, dto: UpdatePromptTemplateRequest): Promise<PromptTemplateResponse> {
    const userId = this.requestUserId;

    const template = await this.promptTemplateRepository.findById(id);
    if (!template) throw new NotFoundException(`Prompt template ${id} not found`);

    this.assertOwnedByTenant(template, id);
    this.assertCanMutate(template);

    const hasContentChanges =
      dto.name !== undefined || dto.description !== undefined || dto.content !== undefined || dto.variables !== undefined || dto.tags !== undefined;

    if (hasContentChanges) {
      const version = PromptVersionFactory.CreatePromptVersion({
        tenantId: template.tenantId,
        promptTemplateId: id,
        versionNumber: (template.currentVersionNumber ?? 0) + 1,
        content: dto.content ?? template.content,
        variables: dto.variables ?? template.variables,
        changeReason: dto.changeReason ?? null,
        changedBy: userId ?? null,
      });
      await this.promptVersionRepository.create(version);

      if (dto.name !== undefined) template.name = dto.name;
      if (dto.description !== undefined) template.description = dto.description;
      if (dto.content !== undefined) template.content = dto.content;
      if (dto.variables !== undefined) template.variables = dto.variables;
      if (dto.tags !== undefined) template.tags = dto.tags;
      template.incrementVersion();
    }

    if (dto.resourceStatus !== undefined) {
      if (dto.resourceStatus === ResourceStatusType.DISABLED) {
        template.disable(userId ?? undefined);
      } else if (dto.resourceStatus === ResourceStatusType.ENABLED) {
        template.enable(userId ?? undefined);
      }
    }

    if (!template.hasChanges) {
      throw new ArgumentInvalidException('No changes to write to.');
    }

    const updated = await this.promptTemplateRepository.update(id, template);

    this.broadcastSysEvent(SysEventType.ResourceUpdated, {
      resourceId: id,
      data: { changeReason: dto.changeReason },
    });

    return PromptManagementDtoMapper.toTemplateResponse(updated);
  }

  async getPromptTemplate(id: string): Promise<PromptTemplateResponse | null> {
    const template = await this.promptTemplateRepository.findById(id);
    if (!template) return null;
    if (this.tenantId && template.tenantId !== this.tenantId) return null;
    if (template.scope === SCOPE_USER_PERSONAL && template.ownerUserId !== this.requestUserId) {
      return null;
    }
    return PromptManagementDtoMapper.toTemplateResponse(template);
  }

  async listPromptTemplates(filters?: {
    category?: string;
    departmentId?: string;
    search?: string;
    includeDisabled?: boolean;
  }): Promise<PromptTemplateResponse[]> {
    const tenantId = this.tenantId;
    if (!tenantId) throw new BadRequestException('Tenant ID is required');

    const qb = this.promptTemplateRepository.$();
    qb.Where({ tenantId });
    if (!filters?.includeDisabled) {
      qb.Where({ resourceStatus: ResourceStatusType.ENABLED });
    }
    if (filters?.category) qb.Where({ category: filters.category });
    if (filters?.departmentId) qb.Where({ departmentId: filters.departmentId });
    if (filters?.search) qb.Where({ name: { contains: filters.search, mode: 'insensitive' } });
    const models = await qb.ToList();
    const mapper = PromptTemplateEntityMapper.getInstance();
    const templates = models.map((m) => mapper.toDomainEntity(m));
    return templates.map(PromptManagementDtoMapper.toTemplateResponse);
  }

  async listDefaultsForDepartment(departmentId: string): Promise<PromptTemplateResponse[]> {
    const tenantId = this.tenantId;
    if (!tenantId) throw new BadRequestException('Tenant ID is required');

    const qb = this.promptTemplateRepository.$();
    qb.Where({ tenantId });
    qb.Where({ resourceStatus: ResourceStatusType.ENABLED });
    qb.WhereOr({ scope: SCOPE_TENANT_DEFAULT });
    qb.WhereOr({ scope: 'DEPARTMENT_DEFAULT', departmentId });

    const models = await qb.ToList();
    const mapper = PromptTemplateEntityMapper.getInstance();
    const templates = models.map((m) => mapper.toDomainEntity(m));
    return templates.map(PromptManagementDtoMapper.toTemplateResponse);
  }

  async listMyPersonalForDepartment(departmentId: string): Promise<PromptTemplateResponse[]> {
    const tenantId = this.tenantId;
    const userId = this.requestUserId;
    if (!tenantId) throw new BadRequestException('Tenant ID is required');
    if (!userId) throw new BadRequestException('Caller user ID is required');

    const templates = await this.promptTemplateRepository.findMyPersonalForDepartment(tenantId, userId, departmentId);
    return templates.map(PromptManagementDtoMapper.toTemplateResponse);
  }

  async getVersions(templateId: string): Promise<PromptVersionResponse[]> {
    const versions = await this.promptVersionRepository.findByTemplate(templateId);
    return versions.map(PromptManagementDtoMapper.toVersionResponse);
  }

  async getVersion(templateId: string, versionNumber: number): Promise<PromptVersionResponse | null> {
    const version = await this.promptVersionRepository.findByVersionNumber(templateId, versionNumber);
    if (!version) return null;
    return PromptManagementDtoMapper.toVersionResponse(version);
  }

  async getUsageStats(templateId: string): Promise<{ totalUsages: number; lastUsedAt: string | null }> {
    const records = await this.promptUsageRecordRepository.findByTemplate(templateId);
    const totalUsages = records.length;
    const lastUsedAt = totalUsages > 0 ? (records[0].createdAt?.toISOString() ?? null) : null;
    return { totalUsages, lastUsedAt };
  }

  async softDeletePromptTemplate(id: string): Promise<PromptTemplateResponse> {
    const template = await this.promptTemplateRepository.findById(id);
    if (!template) throw new NotFoundException(`Prompt template ${id} not found`);

    this.assertOwnedByTenant(template, id);
    this.assertCanMutate(template);

    const deleted = await this.promptTemplateRepository.softDelete(id);

    this.broadcastSysEvent(SysEventType.ResourceDeleted, {
      resourceId: id,
    });

    return PromptManagementDtoMapper.toTemplateResponse(deleted);
  }

  async assignToDepartment(dto: AssignDepartmentPromptRequest): Promise<DepartmentResponse> {
    // TASK-302 Stream D Phase E.2 — `updatePromptConfig` now enforces OCC,
    // so the caller MUST carry the Department row's `expectedVersion`.
    // Cross-service callers (e.g. the prompt-management UI) read the
    // Department first and echo back its version on this DTO.
    return this.departmentService.updatePromptConfig(dto.departmentId, {
      newPatientPromptId: dto.newPatientPromptId,
      revisitPromptId: dto.revisitPromptId,
      expectedVersion: dto.expectedVersion,
    });
  }

  // ─── Internal authorization helpers (TASK-294 DEF-C2) ────────────────

  private assertOwnedByTenant(template: PromptTemplateEntity, id: string): void {
    const callerTenant = this.tenantId;
    if (callerTenant && template.tenantId !== callerTenant) {
      throw new NotFoundException(`Prompt template ${id} not found`);
    }
  }

  private assertCanMutate(template: PromptTemplateEntity): void {
    if (template.scope === SCOPE_USER_PERSONAL) {
      if (template.ownerUserId !== this.requestUserId) {
        throw new ForbiddenException('Caller does not own this personal prompt template');
      }
      return;
    }
    if (!this.callerCanManageTemplates()) {
      throw new ForbiddenException('Caller cannot mutate default prompt templates');
    }
  }

  private callerCanManageTemplates(): boolean {
    const ability = this.clsService.get('userAbility') as { can?: (action: string, subject: string) => boolean } | undefined;
    if (!ability || typeof ability.can !== 'function') return false;
    return ability.can('manage', 'PromptTemplate');
  }
}
