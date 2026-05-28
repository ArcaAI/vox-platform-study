import { Injectable, Logger, NotFoundException, BadRequestException, Inject } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { CoreDatabaseService, ResourceStatusType, ResourceType, SysEventType } from '@arcaai/domains';
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
 * `RolesController` used to perform (audit C-10 / F-1 / H-9). The
 * implementation is a straight port of the prior controller logic to
 * preserve the existing E2E RBAC suite (`apps/api/tests/e2e/rbac.spec.ts`):
 * every Prisma call, every audit-event payload, every cache invalidation
 * matches the pre-W6 wiring.
 *
 * Direct `CoreDatabaseService` access here is legitimate (service layer)
 * and intentionally NOT a candidate for the W6.4 ESLint allow-list —
 * that rule scopes the ban to `apps/api/src/modules/**`.
 *
 * The class is prefixed `Rbac` to disambiguate from the legacy
 * `services/security/role/RoleService` (unused but still exported via
 * the package barrel; renaming the legacy skeleton was out of W6 scope).
 *
 * TASK-307 W7.A.15 (carryover note from W6 review) — §H-9 partial
 * closure: the original audit recommended migrating role + role-
 * policy management through `RoleRepository` / `RolePolicyRepository`
 * facades so soft-delete, audit hooks, and tenant scoping land
 * uniformly with the rest of the domain layer. W6 chose verbatim
 * behaviour preservation to keep the RBAC E2E suite green without
 * introducing repository surface that no other consumer needs today.
 * A dedicated `RoleRepository` + extraction PR is tracked as a §10
 * deferral in `docs/implementation/TASK-307-API-Gateway-Hardening/
 * README.md`.
 */
@Injectable()
export class RbacRoleService extends BaseService implements IRbacRoleService {
  private readonly logger = new Logger(RbacRoleService.name);

  private static readonly ROLE_POLICIES_INCLUDE = {
    RolePolicies: {
      where: { resourceStatus: ResourceStatusType.ENABLED },
      include: {
        Policy: {
          select: { id: true, name: true },
        },
      },
      orderBy: { priority: 'asc' as const },
    },
  };

  constructor(
    @Inject('CORE_DATABASE_SERVICE') private readonly databaseService: CoreDatabaseService,
    private readonly policyEngine: PolicyEngine,
    protected override readonly eventEmitter: EventEmitter2,
    protected override readonly clsService: ClsService<IActiveUserContext>,
  ) {
    super(eventEmitter, clsService, ResourceType.Role);
  }

  async findAll(query: RbacRoleListQuery): Promise<RbacRoleListResult> {
    const { page, pageSize, search } = query;
    const prisma = this.databaseService.client;
    const skip = (page - 1) * pageSize;

    const where = {
      resourceStatus: ResourceStatusType.ENABLED,
      ...(search && {
        OR: [
          { name: { contains: search, mode: 'insensitive' as const } },
          { description: { contains: search, mode: 'insensitive' as const } },
        ],
      }),
    };

    const [data, total] = await Promise.all([
      prisma.role.findMany({
        where,
        skip,
        take: pageSize,
        include: RbacRoleService.ROLE_POLICIES_INCLUDE,
        orderBy: { name: 'asc' },
      }),
      prisma.role.count({ where }),
    ]);

    return { data: data as unknown as RbacRoleRecord[], total };
  }

  async findOne(id: string): Promise<RbacRoleRecord | null> {
    const role = await this.databaseService.client.role.findUnique({
      where: { id },
      include: RbacRoleService.ROLE_POLICIES_INCLUDE,
    });
    return (role as RbacRoleRecord | null) ?? null;
  }

  async create(request: CreateRbacRoleRequest): Promise<RbacRoleRecord> {
    if (request.parentRoleId) {
      await this.validateParentRole(request.parentRoleId);
    }

    const user = this.requestUser;
    const role = await this.databaseService.client.role.create({
      data: {
        name: request.name,
        description: request.description,
        externalName: request.externalName,
        externalId: request.externalId,
        parentRoleId: request.parentRoleId,
        isSystemRole: false,
        resourceStatus: ResourceStatusType.ENABLED,
        createdBy: user?.id,
      },
    });

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

    return { ...(role as unknown as RbacRoleRecord), RolePolicies: [] };
  }

  async update(id: string, request: UpdateRbacRoleRequest): Promise<RbacRoleRecord> {
    const existing = await this.databaseService.client.role.findUnique({
      where: { id },
      select: { isSystemRole: true, name: true },
    });

    if (!existing) {
      throw new NotFoundException('Role not found');
    }

    if (existing.isSystemRole) {
      throw new BadRequestException(
        `Cannot modify system role '${existing.name}'. System roles are protected from modification.`,
      );
    }

    if (request.parentRoleId !== undefined && request.parentRoleId !== null) {
      await this.validateParentRole(request.parentRoleId, id);
    }

    const user = this.requestUser;
    const role = await this.databaseService.client.role.update({
      where: { id },
      data: {
        ...(request.name && { name: request.name }),
        ...(request.description !== undefined && { description: request.description }),
        ...(request.externalName !== undefined && { externalName: request.externalName }),
        ...(request.externalId !== undefined && { externalId: request.externalId }),
        ...(request.parentRoleId !== undefined && { parentRoleId: request.parentRoleId }),
        updatedBy: user?.id,
      },
      include: RbacRoleService.ROLE_POLICIES_INCLUDE,
    });

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

    return role as unknown as RbacRoleRecord;
  }

  async patch(id: string, request: UpdateRbacRoleRequest): Promise<RbacRoleRecord> {
    const existing = await this.databaseService.client.role.findUnique({
      where: { id },
      select: { isSystemRole: true, name: true },
    });

    if (!existing) {
      throw new NotFoundException('Role not found');
    }

    if (existing.isSystemRole) {
      throw new BadRequestException(
        `Cannot modify system role '${existing.name}'. System roles are protected from modification.`,
      );
    }

    if (request.parentRoleId !== undefined && request.parentRoleId !== null) {
      await this.validateParentRole(request.parentRoleId, id);
    }

    const user = this.requestUser;
    const role = await this.databaseService.client.role.update({
      where: { id },
      data: {
        ...(request.name && { name: request.name }),
        ...(request.description !== undefined && { description: request.description }),
        ...(request.externalName !== undefined && { externalName: request.externalName }),
        ...(request.externalId !== undefined && { externalId: request.externalId }),
        ...(request.parentRoleId !== undefined && { parentRoleId: request.parentRoleId }),
        ...(request.resourceStatus && {
          resourceStatus: request.resourceStatus as ResourceStatusType,
          resourceStatusUpdatedAt: new Date(),
          resourceStatusUpdatedBy: user?.id,
        }),
        updatedBy: user?.id,
      },
      include: RbacRoleService.ROLE_POLICIES_INCLUDE,
    });

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

    return role as unknown as RbacRoleRecord;
  }

  async softDelete(id: string): Promise<{ id: string; name: string }> {
    const role = await this.databaseService.client.role.findUnique({
      where: { id },
      select: { isSystemRole: true, name: true },
    });

    if (!role) {
      throw new NotFoundException('Role not found');
    }

    if (role.isSystemRole) {
      throw new BadRequestException('Cannot delete system role');
    }

    const user = this.requestUser;
    await this.databaseService.client.role.update({
      where: { id },
      data: {
        resourceStatus: ResourceStatusType.DELETED,
        resourceStatusUpdatedAt: new Date(),
        resourceStatusUpdatedBy: user?.id,
      },
    });

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
    const prisma = this.databaseService.client;
    const user = this.requestUser;

    const existing = await prisma.rolePolicy.findFirst({
      where: { roleId, policyId },
    });

    if (existing) {
      await prisma.rolePolicy.update({
        where: { id: existing.id },
        data: {
          priority: dto.priority ?? existing.priority,
          resourceStatus: ResourceStatusType.ENABLED,
          updatedBy: user?.id,
        },
      });
    } else {
      await prisma.rolePolicy.create({
        data: {
          roleId,
          policyId,
          priority: dto.priority ?? 0,
          resourceStatus: ResourceStatusType.ENABLED,
          createdBy: user?.id,
        },
      });
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

    await this.databaseService.client.rolePolicy.updateMany({
      where: { roleId, policyId },
      data: {
        resourceStatus: ResourceStatusType.DELETED,
        resourceStatusUpdatedAt: new Date(),
        resourceStatusUpdatedBy: user?.id,
      },
    });

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
   * circular references. Behaviour mirrors the prior controller helper
   * verbatim — only the receiver changed (CoreDatabaseService injected
   * via constructor rather than passed by argument).
   *
   * @param currentRoleId - The ID of the role being updated (for cycle
   *                        detection). Omit for create operations.
   */
  private async validateParentRole(parentRoleId: string, currentRoleId?: string): Promise<void> {
    if (currentRoleId && parentRoleId === currentRoleId) {
      throw new BadRequestException('A role cannot be its own parent');
    }

    const prisma = this.databaseService.client;
    const parent = await prisma.role.findUnique({
      where: { id: parentRoleId },
      select: { id: true, parentRoleId: true },
    });

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
        const ancestor = await prisma.role.findUnique({
          where: { id: ancestorId },
          select: { parentRoleId: true },
        });
        ancestorId = ancestor?.parentRoleId ?? null;
      }
    }
  }
}
