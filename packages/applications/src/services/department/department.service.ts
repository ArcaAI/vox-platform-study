import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { DepartmentRepository, DepartmentFactory, ResourceType, SysEventType } from '@arcaai/domains';
import { ArgumentInvalidException } from '@arcaai/exceptions';
import { IDepartmentService } from './IDepartmentService';
import { DepartmentResponse, CreateDepartmentRequest, UpdateDepartmentRequest, UpdateDepartmentPromptConfigRequest } from './dto';
import { DepartmentDtoMapper } from './department.dto.mapper';
import { BaseService, assertParentInScope } from '../../common';
import { IActiveUserContext } from '../../interfaces';

@Injectable()
export class DepartmentService extends BaseService implements IDepartmentService {
  constructor(
    private readonly departmentRepository: DepartmentRepository,
    protected override readonly eventEmitter: EventEmitter2,
    protected override readonly clsService: ClsService<IActiveUserContext>,
  ) {
    super(eventEmitter, clsService, ResourceType.Department);
  }

  /**
   * Get all departments for the current tenant
   */
  async getAll(options?: { includeDisabled?: boolean }): Promise<DepartmentResponse[]> {
    const tenantId = this.tenantId;
    if (!tenantId) {
      throw new BadRequestException('Tenant ID is required');
    }

    const departments = await this.departmentRepository.findAllByTenant(tenantId, {
      includeDisabled: options?.includeDisabled,
    });

    this.broadcastSysEvent(SysEventType.ResourceViewed, {
      data: { count: departments.length },
    });

    return departments.map(DepartmentDtoMapper.toResponse);
  }

  /**
   * Get department by ID
   */
  async getById(id: string): Promise<DepartmentResponse | null> {
    const department = await this.departmentRepository.findById(id);
    if (!department) return null;

    this.broadcastSysEvent(SysEventType.ResourceViewed, {
      resourceId: department.id,
    });

    return DepartmentDtoMapper.toResponse(department);
  }

  /**
   * Get department by code
   */
  async getByCode(code: string): Promise<DepartmentResponse | null> {
    const tenantId = this.tenantId;
    if (!tenantId) {
      throw new BadRequestException('Tenant ID is required');
    }

    const department = await this.departmentRepository.findByCode(tenantId, code);
    if (!department) return null;

    this.broadcastSysEvent(SysEventType.ResourceViewed, {
      resourceId: department.id,
    });

    return DepartmentDtoMapper.toResponse(department);
  }

  /**
   * Get root departments (no parent)
   */
  async getRootDepartments(): Promise<DepartmentResponse[]> {
    const tenantId = this.tenantId;
    if (!tenantId) {
      throw new BadRequestException('Tenant ID is required');
    }

    const departments = await this.departmentRepository.findRootDepartments(tenantId);

    this.broadcastSysEvent(SysEventType.ResourceViewed, {
      data: { rootDepartments: true, count: departments.length },
    });

    return departments.map(DepartmentDtoMapper.toResponse);
  }

  /**
   * Get children of a department
   */
  async getChildren(parentId: string): Promise<DepartmentResponse[]> {
    const departments = await this.departmentRepository.findChildren(parentId);

    this.broadcastSysEvent(SysEventType.ResourceViewed, {
      resourceId: parentId,
      data: { parentId, childCount: departments.length },
    });

    return departments.map(DepartmentDtoMapper.toResponse);
  }

  /**
   * Create a new department
   */
  async create(dto: CreateDepartmentRequest): Promise<DepartmentResponse> {
    const tenantId = this.tenantId;
    const userId = this.requestUserId;

    if (!tenantId) {
      throw new BadRequestException('Tenant ID is required');
    }

    // Check if code already exists (only if code is provided)
    if (dto.code) {
      const existing = await this.departmentRepository.findByCode(tenantId, dto.code);
      if (existing) {
        throw new BadRequestException(`Department with code '${dto.code}' already exists`);
      }
    }

    // TASK-305 D.6 (audit C-7) — verify the parent both exists AND lives
    // in the caller's tenant. `assertParentInScope` throws
    // `NotFoundException` (not `ForbiddenException`) on tenant mismatch
    // to avoid leaking the existence of a cross-tenant parent. SUPER_ADMIN
    // is intentionally NOT bypassed: a cross-tenant parent would produce
    // a malformed tree regardless of caller role.
    if (dto.parentDepartmentId) {
      await assertParentInScope(this.departmentRepository, dto.parentDepartmentId, tenantId);
    }

    const department = DepartmentFactory.CreateDepartment({
      tenantId,
      code: dto.code,
      name: dto.name,
      description: dto.description,
      parentDepartmentId: dto.parentDepartmentId,
      // CC-04 (TASK-336) — forward the create modal's default summary template
      // (the factory defaults it to null when absent).
      defaultSummaryTemplate: dto.defaultSummaryTemplate,
      createdBy: userId ?? undefined,
    });

    const saved = await this.departmentRepository.create(department);

    this.broadcastSysEvent(SysEventType.ResourceCreated, {
      resourceId: saved.id,
      createdAt: saved.createdAt,
      data: { code: dto.code, name: dto.name },
    });

    return DepartmentDtoMapper.toResponse(saved);
  }

  /**
   * Update an existing department.
   *
   * TASK-302 Stream D Phase E.2 — write path is now Compare-And-Set
   * against `_version`. The `expectedVersion` carried on the DTO is the
   * CAS predicate input (a `@RequiresIfMatch()` HTTP route folds the
   * `If-Match` header value over the body-field at the controller).
   *
   * @throws OptimisticConcurrencyException — version drift; HTTP 412.
   */
  async update(id: string, dto: UpdateDepartmentRequest): Promise<DepartmentResponse> {
    const tenantId = this.tenantId;
    if (!tenantId) {
      throw new BadRequestException('Tenant ID is required');
    }

    const department = await this.departmentRepository.findById(id);
    if (!department) {
      throw new NotFoundException(`Department ${id} not found`);
    }

    // Verify tenant ownership
    if (department.tenantId !== tenantId) {
      throw new NotFoundException(`Department ${id} not found`);
    }

    // Check if new code conflicts with existing (only if code is being changed)
    if (dto.code && dto.code !== department.code) {
      const existing = await this.departmentRepository.findByCode(tenantId, dto.code);
      if (existing && existing.id !== id) {
        throw new BadRequestException(`Department with code '${dto.code}' already exists`);
      }
    }

    // TASK-305 D.6 (audit C-7) — same cross-tenant guard as `create`. The
    // self-parent circular-reference check stays as-is; only the existence
    // check is replaced with the tenant-aware helper.
    if (dto.parentDepartmentId !== undefined && dto.parentDepartmentId !== null) {
      if (dto.parentDepartmentId === id) {
        throw new BadRequestException('Department cannot be its own parent');
      }
      await assertParentInScope(this.departmentRepository, dto.parentDepartmentId, tenantId);
    }

    // Track changes for audit
    const previousData = department.toObject();

    // `expectedVersion` is the CAS predicate input only — keep it out of
    // `updateEntity` so it is never staged onto the entity. The
    // `_version` getter on BaseEntity (B.5) is read-only.
    const { expectedVersion, ...editableDto } = dto;
    await this.updateEntity(department, editableDto as UpdateDepartmentRequest);

    if (!department.hasChanges) {
      throw new ArgumentInvalidException('No changes to write to.');
    }

    // Snapshot pre-write version BEFORE the CAS bumps it (mirrors C.8 / E.1).
    const previousVersion = department.version;

    const updated = await this.departmentRepository.updateWithVersion(id, department, expectedVersion);

    this.broadcastSysEvent(SysEventType.ResourceUpdated, {
      resourceId: updated.id,
      data: {
        ...department.changes,
        previousVersion,
        newVersion: updated.version,
      },
      previousData: previousData as object,
    });

    return DepartmentDtoMapper.toResponse(updated);
  }

  /**
   * Update department prompt configuration (pre-summary, new patient, revisit prompts).
   *
   * TASK-294 DEF-C3: enforce tenant ownership before mutating. Mismatched tenant
   * raises NotFoundException (not Forbidden) to avoid leaking existence.
   *
   * TASK-302 Stream D Phase E.2 — also enforces OCC; the route requires
   * `If-Match` and the body-field `expectedVersion` is the CAS predicate.
   *
   * @throws OptimisticConcurrencyException — version drift; HTTP 412.
   */
  async updatePromptConfig(id: string, dto: UpdateDepartmentPromptConfigRequest): Promise<DepartmentResponse> {
    const tenantId = this.tenantId;
    if (!tenantId) {
      throw new BadRequestException('Tenant ID is required');
    }

    const department = await this.departmentRepository.findById(id);
    if (!department) {
      throw new NotFoundException(`Department ${id} not found`);
    }

    if (department.tenantId !== tenantId) {
      throw new NotFoundException(`Department ${id} not found`);
    }

    if (dto.preSummaryPromptId !== undefined) department.preSummaryPromptId = dto.preSummaryPromptId;
    if (dto.newPatientPromptId !== undefined) department.newPatientPromptId = dto.newPatientPromptId;
    if (dto.revisitPromptId !== undefined) department.revisitPromptId = dto.revisitPromptId;

    if (!department.hasChanges) {
      throw new ArgumentInvalidException('No changes to write to.');
    }

    const previousVersion = department.version;
    const updated = await this.departmentRepository.updateWithVersion(id, department, dto.expectedVersion);

    this.broadcastSysEvent(SysEventType.ResourceUpdated, {
      resourceId: updated.id,
      data: {
        ...department.changes,
        previousVersion,
        newVersion: updated.version,
      },
    });

    return DepartmentDtoMapper.toResponse(updated);
  }

  /**
   * Soft delete a department
   */
  async deleteById(id: string): Promise<DepartmentResponse> {
    const tenantId = this.tenantId;
    if (!tenantId) {
      throw new BadRequestException('Tenant ID is required');
    }

    const department = await this.departmentRepository.findById(id);
    if (!department) {
      throw new NotFoundException(`Department ${id} not found`);
    }

    // Verify tenant ownership
    if (department.tenantId !== tenantId) {
      throw new NotFoundException(`Department ${id} not found`);
    }

    // Check if department has children
    const children = await this.departmentRepository.findChildren(id);
    if (children.length > 0) {
      throw new BadRequestException(`Cannot delete department with ${children.length} child department(s). Delete or reassign children first.`);
    }

    const deleted = await this.departmentRepository.softDelete(id);

    this.broadcastSysEvent(SysEventType.ResourceDeleted, {
      resourceId: deleted.id,
      data: deleted.toObject() as object,
    });

    return DepartmentDtoMapper.toResponse(deleted);
  }
}
