import { Injectable, Logger, NotFoundException, BadRequestException } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  RbacRoleFactory,
  RbacRoleRepository,
  ResourceStatusType,
  ResourceType,
  ROLE_POLICIES_INCLUDE,
  RolePolicyFactory,
  RolePolicyRepository,
  SysEventType,
} from '@arcaai/domains';
import { BaseService } from '../../../common';
import { IActiveUserContext } from '../../../interfaces';
import { PolicyEngine } from '../../../authorization/policy.engine';
import {
  CreateRbacRoleRequest,
  IRbacRoleService,
  RbacRoleListQuery,
  RbacRoleListResult,
  RbacRolePolicyAssignmentInput,
  RbacRoleRecord,
  UpdateRbacRoleRequest,
} from './IRoleService';

/**
 * TASK-307 W6.3 — Service that absorbs the direct-Prisma access that
 * `RolesController` used to perform (audit C-10 / F-1 / H-9). Prefixed
 * `Rbac` to disambiguate from the legacy `services/security/role/RoleService`
 * (still in the barrel, unused; renaming was out of W6 scope).
 *
 * TASK-311 (closes the §H-9 deferral W7.A.15) — direct
 * `CoreDatabaseService` access removed. Persistence now flows through
 * `RbacRoleRepository` + `RolePolicyRepository` (plus their factories).
 * Behaviour is unchanged: every Prisma call shape, every audit-event
 * payload, every cache invalidation matches the W6 wiring (verified by
 * the existing TASK-307 W6.3 test suite, re-pointed at the new
 * repository mocks). See `docs/implementation/TASK-311-Policy-Role-
 * Repository-Extraction/README.md` for the inventory + design rationale.
 */
@Injectable()
export class RbacRoleService extends BaseService implements IRbacRoleService {
  private readonly logger = new Logger(RbacRoleService.name);

  constructor(
    private readonly roleRepository: RbacRoleRepository,
    private readonly rolePolicyRepository: RolePolicyRepository,
    private readonly policyEngine: PolicyEngine,
    protected override readonly eventEmitter: EventEmitter2,
    protected override readonly clsService: ClsService<IActiveUserContext>,
  ) {
    super(eventEmitter, clsService, ResourceType.Role);
  }

  async findAll(query: RbacRoleListQuery): Promise<RbacRoleListResult> {
    const { page, pageSize, search } = query;
    const skip = (page - 1) * pageSize;

    const where = {
      resourceStatus: ResourceStatusType.ENABLED,
      ...(search && {
        OR: [{ name: { contains: search, mode: 'insensitive' as const } }, { description: { contains: search, mode: 'insensitive' as const } }],
      }),
    };

    const [data, total] = await Promise.all([
      this.roleRepository.findMany({
        where,
        skip,
        take: pageSize,
        include: ROLE_POLICIES_INCLUDE,
        orderBy: { name: 'asc' },
      }),
      this.roleRepository.count({ where }),
    ]);

    return { data: data as unknown as RbacRoleRecord[], total };
  }

  async findOne(id: string): Promise<RbacRoleRecord | null> {
    const role = await this.roleRepository.findByIdWithPolicies(id);
    return (role as RbacRoleRecord | null) ?? null;
  }

  async create(request: CreateRbacRoleRequest): Promise<RbacRoleRecord> {
    if (request.parentRoleId) {
      await this.validateParentRole(request.parentRoleId);
    }

    const user = this.requestUser;
    const data = RbacRoleFactory.buildCreateInput({
      name: request.name,
      description: request.description,
      externalName: request.externalName,
      externalId: request.externalId,
      parentRoleId: request.parentRoleId,
      createdBy: user?.id,
    });
    const role = (await this.roleRepository.create(data)) as RbacRoleRecord;

    this.broadcastSysEvent(SysEventType.ResourceCreated, {
      resourceId: role.id,
      data: role as unknown as object,
    });

    this.logger.log({
      message: 'Role created',
      roleId: role.id,
      roleName: role.name,
      createdBy: user?.id,
    });

    return { ...role, RolePolicies: [] };
  }

  async update(id: string, request: UpdateRbacRoleRequest): Promise<RbacRoleRecord> {
    const existing = await this.roleRepository.findByIdGuardSelect(id);

    if (!existing) {
      throw new NotFoundException('Role not found');
    }

    if (existing.isSystemRole) {
      throw new BadRequestException(`Cannot modify system role '${existing.name}'. System roles are protected from modification.`);
    }

    if (request.parentRoleId !== undefined && request.parentRoleId !== null) {
      await this.validateParentRole(request.parentRoleId, id);
    }

    const user = this.requestUser;
    const data = RbacRoleFactory.buildUpdateInput(request, user?.id);
    const role = (await this.roleRepository.update(id, data)) as RbacRoleRecord;

    await this.policyEngine.invalidateRole(id);
    this.broadcastSysEvent(SysEventType.ResourceUpdated, {
      resourceId: id,
      data: role as unknown as object,
      previousData: existing as unknown as object,
    });

    this.logger.log({
      message: 'Role updated',
      roleId: role.id,
      roleName: role.name,
      updatedBy: user?.id,
    });

    return role;
  }

  async patch(id: string, request: UpdateRbacRoleRequest): Promise<RbacRoleRecord> {
    const existing = await this.roleRepository.findByIdGuardSelect(id);

    if (!existing) {
      throw new NotFoundException('Role not found');
    }

    if (existing.isSystemRole) {
      throw new BadRequestException(`Cannot modify system role '${existing.name}'. System roles are protected from modification.`);
    }

    if (request.parentRoleId !== undefined && request.parentRoleId !== null) {
      await this.validateParentRole(request.parentRoleId, id);
    }

    const user = this.requestUser;
    const data = RbacRoleFactory.buildUpdateInput(request, user?.id);
    const role = (await this.roleRepository.update(id, data)) as RbacRoleRecord;

    await this.policyEngine.invalidateRole(id);
    this.broadcastSysEvent(SysEventType.ResourceUpdated, {
      resourceId: id,
      data: role as unknown as object,
      previousData: existing as unknown as object,
    });

    this.logger.log({
      message: 'Role updated',
      roleId: role.id,
      roleName: role.name,
      updatedBy: user?.id,
    });

    return role;
  }

  async softDelete(id: string): Promise<{ id: string; name: string }> {
    const role = await this.roleRepository.findByIdGuardSelect(id);

    if (!role) {
      throw new NotFoundException('Role not found');
    }

    if (role.isSystemRole) {
      throw new BadRequestException('Cannot delete system role');
    }

    const user = this.requestUser;
    await this.roleRepository.softDelete(id, user?.id);

    await this.policyEngine.invalidateRole(id);
    this.broadcastSysEvent(SysEventType.ResourceDeleted, {
      resourceId: id,
      data: { name: role.name },
    });

    this.logger.log({
      message: 'Role deleted',
      roleId: id,
      roleName: role.name,
      deletedBy: user?.id,
    });

    return { id, name: role.name };
  }

  async assignPolicy(roleId: string, policyId: string, dto: RbacRolePolicyAssignmentInput): Promise<void> {
    const user = this.requestUser;

    const existing = (await this.rolePolicyRepository.findFirstByRoleAndPolicy(roleId, policyId)) as { id: string; priority: number } | null;

    if (existing) {
      await this.rolePolicyRepository.reEnable(
        existing.id,
        RolePolicyFactory.buildReEnableInput({
          priority: dto.priority ?? existing.priority,
          updatedBy: user?.id,
        }),
      );
    } else {
      await this.rolePolicyRepository.create(
        RolePolicyFactory.buildCreateInput({
          roleId,
          policyId,
          priority: dto.priority ?? 0,
          createdBy: user?.id,
        }),
      );
    }

    await this.policyEngine.invalidateRole(roleId);
    this.broadcastSysEvent(SysEventType.ResourceCreated, {
      resourceId: `${roleId}:${policyId}`,
      resourceType: ResourceType.RolePermission,
      data: { roleId, policyId, priority: dto.priority ?? 0 },
    });

    this.logger.log({
      message: 'Policy assigned to role',
      policyId,
      roleId,
      priority: dto.priority ?? 0,
      assignedBy: user?.id,
    });
  }

  async removePolicy(roleId: string, policyId: string): Promise<void> {
    const user = this.requestUser;

    await this.rolePolicyRepository.softDeleteByRoleAndPolicy(roleId, policyId, user?.id);

    await this.policyEngine.invalidateRole(roleId);
    this.broadcastSysEvent(SysEventType.ResourceDeleted, {
      resourceId: `${roleId}:${policyId}`,
      resourceType: ResourceType.RolePermission,
      data: { roleId, policyId },
    });

    this.logger.log({
      message: 'Policy removed from role',
      policyId,
      roleId,
      removedBy: user?.id,
    });
  }

  /**
   * Validates parentRoleId: ensures the parent exists and there are no
   * circular references. Behaviour mirrors the prior W6 helper
   * verbatim — TASK-311 moved the two `findUnique` lookups behind
   * `roleRepository.findParentRoleById` / `findParentRoleIdById`.
   *
   * @param currentRoleId - The ID of the role being updated (for cycle
   *                        detection). Omit for create operations.
   */
  private async validateParentRole(parentRoleId: string, currentRoleId?: string): Promise<void> {
    if (currentRoleId && parentRoleId === currentRoleId) {
      throw new BadRequestException('A role cannot be its own parent');
    }

    const parent = await this.roleRepository.findParentRoleById(parentRoleId);

    if (!parent) {
      throw new NotFoundException(`Parent role '${parentRoleId}' not found`);
    }

    if (currentRoleId) {
      let ancestorId: string | null = parent.parentRoleId;
      const visited = new Set<string>([parentRoleId]);
      while (ancestorId) {
        if (ancestorId === currentRoleId) {
          throw new BadRequestException('Circular reference detected in role hierarchy');
        }
        if (visited.has(ancestorId)) break;
        visited.add(ancestorId);
        const ancestor = await this.roleRepository.findParentRoleIdById(ancestorId);
        ancestorId = ancestor?.parentRoleId ?? null;
      }
    }
  }
}
