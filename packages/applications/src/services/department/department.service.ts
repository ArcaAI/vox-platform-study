import { Injectable, BadRequestException, NotFoundException, Inject, Optional } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  DepartmentRepository,
  DepartmentFactory,
  ResourceType,
  ResourceStatusType,
  SysEventType,
  UserRepository,
  UserDepartmentRepository,
} from '@arcaai/domains';
import { ArgumentInvalidException } from '@arcaai/exceptions';
import { IEntitlementsService } from '../entitlements/IEntitlementsService';
import { IDepartmentService } from './IDepartmentService';
import { DepartmentResponse, CreateDepartmentRequest, UpdateDepartmentRequest, UpdateDepartmentPromptConfigRequest } from './dto';
import { DepartmentDtoMapper } from './department.dto.mapper';
import { BaseService, assertParentInScope, isSuperAdmin, PaginatedQuery, withFormattedPaginatedProps, withFormattedCountProps } from '../../common';
import { IActiveUserContext } from '../../interfaces';
import { UserDtoMapper } from '../user/user/user.dto.mapper';
import { PaginatedUserResponse } from '../user/user/dto';

@Injectable()
export class DepartmentService extends BaseService implements IDepartmentService {
  constructor(
    private readonly departmentRepository: DepartmentRepository,
    protected override readonly eventEmitter: EventEmitter2,
    protected override readonly clsService: ClsService<IActiveUserContext>,
    // Appended last (append-only DI) so existing positional
    // callers / unit tests keep working. Used to list users of a department via
    // the `UserDepartment` join without a cross-service injection.
    private readonly userRepository: UserRepository,
    // Optional so existing positional constructors in
    // unit tests keep working; when present, `create` enforces the plan
    // `maxDepartments` quota (kill-switch-gated, no-op when OFF).
    @Optional() @Inject(IEntitlementsService) private readonly entitlements?: IEntitlementsService,
    // Appended last (append-only DI). Used to surface a per-member
    // `isLead` flag on the department-members listing, derived from the
    // `UserDepartment.isPrimary` column. Optional so existing positional
    // constructors in other unit tests keep working.
    @Optional() private readonly userDepartmentRepository?: UserDepartmentRepository,
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
   * Get children of a department.
   *
   * Tenant scope (F-07): the parent is loaded first and asserted to exist
   * (and, for a non-super-admin, to belong to the caller's tenant) — mirrors
   * `getDepartmentUsers` below. Without this, a bogus or cross-tenant parent
   * id was indistinguishable from a real parent with zero children: both
   * answered `200 []`.
   */
  async getChildren(parentId: string): Promise<DepartmentResponse[]> {
    const parent = await this.departmentRepository.findById(parentId);
    if (!parent) {
      throw new NotFoundException(`Department ${parentId} not found`);
    }
    if (!isSuperAdmin(this.requestUser) && parent.tenantId !== this.tenantId) {
      throw new NotFoundException(`Department ${parentId} not found`);
    }

    const departments = await this.departmentRepository.findChildren(parentId);

    this.broadcastSysEvent(SysEventType.ResourceViewed, {
      resourceId: parentId,
      data: { parentId, childCount: departments.length },
    });

    return departments.map(DepartmentDtoMapper.toResponse);
  }

  /**
   * Reverse listing of the users assigned to a department,
   * paginated with the house `PaginatedQuery` / `PaginatedResponse` shape.
   *
   * Tenant scope: the department is loaded first; a non-super-admin caller may
   * only read a department in their own tenant (else `NotFoundException`, to
   * avoid leaking a foreign department's existence). SUPER_ADMIN reads
   * cross-tenant. The user query filters through the `UserDepartment` join and
   * excludes soft-deleted memberships (mirrors `UserService.fetchAllByTenantId`).
   */
  async getDepartmentUsers(departmentId: string, query: PaginatedQuery): Promise<PaginatedUserResponse> {
    const department = await this.departmentRepository.findById(departmentId);
    if (!department) {
      throw new NotFoundException(`Department ${departmentId} not found`);
    }

    if (!isSuperAdmin(this.requestUser) && department.tenantId !== this.tenantId) {
      throw new NotFoundException(`Department ${departmentId} not found`);
    }

    // Prisma relational filter — `DbFilters` doesn't model `some`. Scope by the
    // DEPARTMENT's tenant so a super-admin operator (no CLS tenant) still gets
    // the right rows. `resourceStatus: { not: DELETED }` drops soft-deleted
    // memberships.
    const deptWhere = {
      UserDepartments: { some: { departmentId, tenantId: department.tenantId, resourceStatus: { not: ResourceStatusType.DELETED } } },
    } as Record<string, unknown>;

    const { limit, page } = query;
    const users = await this.userRepository.findAll({
      ...withFormattedPaginatedProps(query),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      where: deptWhere as any,
    });
    const count = await this.userRepository.count({
      ...withFormattedCountProps(query),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      where: deptWhere as any,
    });

    // `isPrimary` models the user's primary department; here it is
    // surfaced as `isLead` for the department-members view (closest available
    // signal — no dedicated per-department lead field exists). Scope by the
    // DEPARTMENT's tenant (matches the user query above) and drop soft-deleted
    // memberships.
    const primaryMemberships =
      (await this.userDepartmentRepository?.findAll({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        where: { departmentId, tenantId: department.tenantId, isPrimary: true, resourceStatus: { not: ResourceStatusType.DELETED } } as any,
      })) ?? [];
    const primaryUserIds = new Set(primaryMemberships.map((m) => m.userId));

    this.broadcastSysEvent(SysEventType.ResourceViewed, {
      resourceId: departmentId,
      data: { departmentId, items: users.map((user) => user.id) },
    });

    const data = users.map((user) => {
      const response = UserDtoMapper.ToResponse(user);
      response.isLead = primaryUserIds.has(user.id);
      return response;
    });

    return new PaginatedUserResponse({ page: page ?? 0, limit: limit ?? 0, count, data });
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

    // Plan quota precheck. Only pay the COUNT when the
    // kill-switch is ON (Q9); `assertQuantityQuota` throws `QuotaExceededException`
    // (→ 409) when creating one more would exceed `maxDepartments`, grandfathering
    // existing rows (Q10 block-new-only). Unlimited/ungated tenants are a no-op.
    if (this.entitlements?.isEnforcementEnabled()) {
      const currentCount = await this.departmentRepository.count({ where: { tenantId } });
      await this.entitlements.assertQuantityQuota(tenantId, 'maxDepartments', currentCount);
    }

    // Check if code already exists (only if code is provided)
    if (dto.code) {
      const existing = await this.departmentRepository.findByCode(tenantId, dto.code);
      if (existing) {
        throw new BadRequestException(`Department with code '${dto.code}' already exists`);
      }
    }

    // (audit C-7) — verify the parent both exists AND lives
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
      // CC-04 — forward the create modal's default summary template
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
   * Write path is now Compare-And-Set
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

    // (audit C-7) — same cross-tenant guard as `create`. The
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

    // OCC precondition BEFORE the no-changes short-circuit: a stale client must
    // get 412 ("you are stale, refetch"), not 400/200, even when the payload
    // would change nothing. RFC 7232 evaluates preconditions independently of
    // the payload; the CAS below still guards concurrent writers.
    this.assertExpectedVersion(department, expectedVersion);
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
   * Enforce tenant ownership before mutating. Mismatched tenant
   * raises NotFoundException (not Forbidden) to avoid leaking existence.
   *
   * Also enforces OCC; the route requires
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
    // Default DNA writing-style prompt slot.
    if (dto.dnaWritingStylePromptId !== undefined) department.dnaWritingStylePromptId = dto.dnaWritingStylePromptId;

    // OCC precondition BEFORE the no-changes short-circuit: a stale client must
    // get 412 ("you are stale, refetch"), not 400/200, even when the payload
    // would change nothing. RFC 7232 evaluates preconditions independently of
    // the payload; the CAS below still guards concurrent writers.
    this.assertExpectedVersion(department, dto.expectedVersion);
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
