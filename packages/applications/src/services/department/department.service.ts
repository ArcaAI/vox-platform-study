import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { DepartmentRepository, DepartmentFactory, ResourceType, SysEventType } from '@arcaai/domains';
import { ArgumentInvalidException } from '@arcaai/exceptions';
import { IDepartmentService } from './IDepartmentService';
import { DepartmentResponse, CreateDepartmentRequest, UpdateDepartmentRequest, UpdateDepartmentPromptConfigRequest } from './dto';
import { DepartmentDtoMapper } from './department.dto.mapper';
import { BaseService } from '../../common';
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

    // Verify parent exists if provided
    if (dto.parentDepartmentId) {
      const parent = await this.departmentRepository.findById(dto.parentDepartmentId);
      if (!parent) {
        throw new NotFoundException(`Parent department ${dto.parentDepartmentId} not found`);
      }
    }

    const department = DepartmentFactory.CreateDepartment({
      tenantId,
      code: dto.code,
      name: dto.name,
      description: dto.description,
      parentDepartmentId: dto.parentDepartmentId,
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
   * Update an existing department
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

    // Verify new parent exists if provided
    if (dto.parentDepartmentId !== undefined && dto.parentDepartmentId !== null) {
      // Prevent circular reference
      if (dto.parentDepartmentId === id) {
        throw new BadRequestException('Department cannot be its own parent');
      }
      const parent = await this.departmentRepository.findById(dto.parentDepartmentId);
      if (!parent) {
        throw new NotFoundException(`Parent department ${dto.parentDepartmentId} not found`);
      }
    }

    // Track changes for audit
    const previousData = department.toObject();

    await this.updateEntity(department, dto);

    if (!department.hasChanges) {
      throw new ArgumentInvalidException('No changes to write to.');
    }

    const updated = await this.departmentRepository.update(id, department);

    this.broadcastSysEvent(SysEventType.ResourceUpdated, {
      resourceId: updated.id,
      data: department.changes,
      previousData: previousData as object,
    });

    return DepartmentDtoMapper.toResponse(updated);
  }

  /**
   * Update department prompt configuration (pre-summary, new patient, revisit prompts)
   */
  async updatePromptConfig(id: string, dto: UpdateDepartmentPromptConfigRequest): Promise<DepartmentResponse> {
    const department = await this.departmentRepository.findById(id);
    if (!department) {
      throw new NotFoundException(`Department ${id} not found`);
    }

    if (dto.preSummaryPromptId !== undefined) department.preSummaryPromptId = dto.preSummaryPromptId;
    if (dto.newPatientPromptId !== undefined) department.newPatientPromptId = dto.newPatientPromptId;
    if (dto.revisitPromptId !== undefined) department.revisitPromptId = dto.revisitPromptId;

    if (!department.hasChanges) {
      throw new ArgumentInvalidException('No changes to write to.');
    }

    const updated = await this.departmentRepository.update(id, department);

    this.broadcastSysEvent(SysEventType.ResourceUpdated, {
      resourceId: updated.id,
      data: department.changes,
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
