import { Injectable, Inject, Logger, NotFoundException, BadRequestException, ForbiddenException } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  PolicyRepository,
  RbacRoleFactory,
  RbacRoleRepository,
  ResourceStatusType,
  ResourceType,
  ROLE_POLICIES_INCLUDE,
  RolePolicyFactory,
  RolePolicyRepository,
  SysEventType,
  SYSTEM_TENANT_ID,
  UserRepository,
} from '@arcaai/domains';
import { BaseService, isSuperAdmin } from '../../../common';
import { IActiveUserContext } from '../../../interfaces';
import { PolicyEngine } from '../../../authorization/policy.engine';
import { ICryptoService } from '../../crypto/ICryptoService';
import { BreakGlassCredentials, BreakGlassOutcome, checkBreakGlass, RBAC_BREAK_GLASS_AUDIT_ACTION } from '../breakGlass';
import {
  CloneRbacRoleRequest,
  CreateRbacRoleRequest,
  IRbacRoleService,
  RbacRoleListQuery,
  RbacRoleListResult,
  RbacRolePolicyAssignmentInput,
  RbacRoleRecord,
  UpdateRbacRoleRequest,
} from './IRoleService';

/**
 * The legacy protected-policy names (mirror of
 * `PolicyService.PROTECTED_SYSTEM_POLICIES`; detach only needs the names).
 */
const PROTECTED_SYSTEM_POLICY_NAMES = new Set(['system-full-access', 'rbac-system-manage']);

/** Operations that can produce a break-glass audit row. */
type RoleBreakGlassOperation = 'role-delete' | 'role-policy-detach';

/** Target descriptor for break-glass audit rows. */
interface RoleBreakGlassAuditTarget {
  targetId: string;
  targetName: string;
  targetType: 'Role' | 'RolePolicy';
  roleId?: string;
  policyId?: string;
}

/**
 * Service that absorbs the direct-Prisma access that
 * `RolesController` used to perform. Prefixed
 * `Rbac` to disambiguate from the legacy `services/security/role/RoleService`
 * (still in the barrel, unused).
 *
 * Direct `CoreDatabaseService` access removed. Persistence now flows through
 * `RbacRoleRepository` + `RolePolicyRepository` (plus their factories).
 * Behaviour is unchanged: every Prisma call shape, every audit-event
 * payload, every cache invalidation matches the prior wiring (verified by
 * the existing test suite, re-pointed at the new repository mocks).
 */
@Injectable()
export class RbacRoleService extends BaseService implements IRbacRoleService {
  private readonly logger = new Logger(RbacRoleService.name);

  constructor(
    private readonly roleRepository: RbacRoleRepository,
    private readonly rolePolicyRepository: RolePolicyRepository,
    private readonly policyRepository: PolicyRepository,
    private readonly userRepository: UserRepository,
    @Inject(ICryptoService) private readonly cryptoService: ICryptoService,
    private readonly policyEngine: PolicyEngine,
    protected override readonly eventEmitter: EventEmitter2,
    protected override readonly clsService: ClsService<IActiveUserContext>,
  ) {
    super(eventEmitter, clsService, ResourceType.Role);
  }

  /**
   * Role reads carry a member count so the admin console renders
   * per-role chips without one members call per row. The nested `_count` is
   * NOT intercepted by the tenant-scope `$extends` (query extensions only see
   * the dispatched model's TOP-LEVEL args), so the filter is built explicitly
   * from CLS: pinned to the caller's tenant when a tenant context exists,
   * unfiltered for the unscoped platform-admin path. Non-DELETED matches what
   * the members listing itself returns (soft-delete extension parity).
   */
  private roleReadInclude() {
    const tenantId = this.tenantId;
    return {
      ...ROLE_POLICIES_INCLUDE,
      _count: {
        select: {
          UserRoleAssignments: {
            where: {
              resourceStatus: { not: ResourceStatusType.DELETED },
              ...(tenantId ? { tenantId } : {}),
            },
          },
        },
      },
    };
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
        include: this.roleReadInclude(),
        orderBy: { name: 'asc' },
      }),
      this.roleRepository.count({ where }),
    ]);

    return { data: data as unknown as RbacRoleRecord[], total };
  }

  async findOne(id: string): Promise<RbacRoleRecord | null> {
    const role = await this.roleRepository.findByIdWithPolicies(id, this.roleReadInclude());
    return (role as RbacRoleRecord | null) ?? null;
  }

  async create(request: CreateRbacRoleRequest): Promise<RbacRoleRecord> {
    if (request.isSystemRole === true && !isSuperAdmin(this.requestUser)) {
      throw new ForbiddenException('Only a global admin can create a system role.');
    }

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
      isSystemRole: request.isSystemRole,
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

    if (existing.isSystemRole && !isSuperAdmin(this.requestUser)) {
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

    if (existing.isSystemRole && !isSuperAdmin(this.requestUser)) {
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

  async softDelete(id: string, breakGlass?: BreakGlassCredentials): Promise<{ id: string; name: string }> {
    const role = await this.roleRepository.findByIdGuardSelect(id);

    if (!role) {
      throw new NotFoundException('Role not found');
    }

    // System roles can never be deleted — this fires BEFORE break-glass so no
    // step-up prompt is offered for an operation that is impossible anyway.
    if (role.isSystemRole) {
      throw new BadRequestException('Cannot delete system role');
    }

    // Deleting a role is a dangerous-but-allowed mutation.
    await this.requireBreakGlass(
      'role-delete',
      { targetId: id, targetName: role.name, targetType: 'Role' },
      breakGlass,
      `Deleting role '${role.name}'`,
    );

    const user = this.requestUser;
    await this.roleRepository.softDelete(id, user?.id);

    this.emitBreakGlassAudit('role-delete', 'confirmed', { targetId: id, targetName: role.name, targetType: 'Role' });

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
    const role = await this.roleRepository.findByIdGuardSelect(roleId);
    if (!role) {
      throw new NotFoundException('Role not found');
    }
    if (role.isSystemRole && !isSuperAdmin(this.requestUser)) {
      throw new ForbiddenException('Only a global admin can modify policies on a system role.');
    }

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

  async removePolicy(roleId: string, policyId: string, breakGlass?: BreakGlassCredentials): Promise<void> {
    // SYSTEM-role policy detach is a global-admin-only operation
    // (defense in depth — the admin console already scopes the affordance).
    const role = await this.roleRepository.findByIdGuardSelect(roleId);
    if (!role) {
      throw new NotFoundException('Role not found');
    }
    if (role.isSystemRole && !isSuperAdmin(this.requestUser)) {
      throw new ForbiddenException('Only a global admin can modify policies on a system role.');
    }

    // The detach target must exist (the policy name anchors both
    // the confirmation contract and the anti-lockout check below).
    const policy = (await this.policyRepository.findById(policyId)) as { id: string; name: string; isProtected?: boolean } | null;
    if (!policy) {
      throw new NotFoundException('Policy not found');
    }

    const auditTarget = { targetId: `${roleId}:${policyId}`, targetName: policy.name, targetType: 'RolePolicy' as const, roleId, policyId };

    // Detaching a PROTECTED policy (marker OR legacy name) is
    // absolutely blocked: the seeded attachment to the super-admin role is
    // exactly what keeps super-admins in. Break-glass does NOT override this.
    if (policy.isProtected === true || PROTECTED_SYSTEM_POLICY_NAMES.has(policy.name)) {
      this.emitBreakGlassAudit('role-policy-detach', 'rejected-protected', auditTarget);
      throw new ForbiddenException(
        `Policy '${policy.name}' is a protected system policy and cannot be detached from any role (it grants super-admin / RBAC access platform-wide).`,
      );
    }

    // Detach is a dangerous-but-allowed mutation: confirm with the
    // caller's password + the exact POLICY name.
    await this.requireBreakGlass('role-policy-detach', auditTarget, breakGlass, `Detaching policy '${policy.name}' from the role`);

    const user = this.requestUser;

    await this.rolePolicyRepository.softDeleteByRoleAndPolicy(roleId, policyId, user?.id);

    this.emitBreakGlassAudit('role-policy-detach', 'confirmed', auditTarget);

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
   * Clone a role (SYSTEM or CUSTOM) into a new CUSTOM role that
   * copies the source's policy set. Any admin may call this (no isSuperAdmin
   * gate) — cloning a SYSTEM role is the whole point, since SYSTEM roles
   * themselves stay locked to global admins.
   */
  async clone(sourceId: string, request: CloneRbacRoleRequest): Promise<RbacRoleRecord> {
    const source = (await this.roleRepository.findByIdWithPolicies(sourceId, this.roleReadInclude())) as RbacRoleRecord | null;
    if (!source) {
      throw new NotFoundException('Role not found');
    }

    const user = this.requestUser;
    const data = RbacRoleFactory.buildCreateInput({
      name: request.name,
      description: source.description ?? undefined,
      externalName: source.externalName ?? undefined,
      externalId: source.externalId ?? undefined,
      parentRoleId: source.parentRoleId ?? undefined,
      createdBy: user?.id,
    });
    const role = (await this.roleRepository.create(data)) as RbacRoleRecord;

    const sourcePolicies = source.RolePolicies ?? [];
    for (const rolePolicy of sourcePolicies) {
      if (!rolePolicy.Policy) continue;
      await this.rolePolicyRepository.create(
        RolePolicyFactory.buildCreateInput({
          roleId: role.id,
          policyId: rolePolicy.Policy.id,
          priority: rolePolicy.priority,
          createdBy: user?.id,
        }),
      );
    }

    const cloned: RbacRoleRecord = {
      ...role,
      RolePolicies: sourcePolicies.filter((rolePolicy) => rolePolicy.Policy !== null),
    };

    this.broadcastSysEvent(SysEventType.ResourceCreated, {
      resourceId: cloned.id,
      data: cloned as unknown as object,
    });

    this.logger.log({
      message: 'Role cloned',
      sourceRoleId: sourceId,
      roleId: cloned.id,
      roleName: cloned.name,
      clonedBy: user?.id,
    });

    return cloned;
  }

  /**
   * Run the step-up verification; on failure, force-audit the
   * rejection and surface the mapped HTTP error (428/401/400). The
   * confirmation name is the TARGET name (role name for role-delete, policy
   * name for detach).
   */
  private async requireBreakGlass(
    operation: RoleBreakGlassOperation,
    target: RoleBreakGlassAuditTarget,
    credentials: BreakGlassCredentials | undefined,
    operationLabel: string,
  ): Promise<void> {
    const result = await checkBreakGlass({
      operation: operationLabel,
      expectedName: target.targetName,
      userId: this.requestUserId,
      credentials,
      loadPasswordHash: async () => {
        const user = await this.userRepository.findById(this.requestUserId as string);
        return (user as { password: string }).password;
      },
      verifyPassword: (password, hash) => this.cryptoService.verify(password, hash),
    });

    if (!result.ok) {
      this.emitBreakGlassAudit(operation, result.outcome, target);
      throw result.error;
    }
  }

  /**
   * Forced audit row for break-glass outcomes
   * (see `PolicyService.emitBreakGlassAudit` for the direct-emit rationale).
   * Roles/policies are platform-global resources — attribute the reserved
   * system tenant when the caller (super-admin) carries no CLS tenant.
   * NEVER the password.
   */
  private emitBreakGlassAudit(operation: RoleBreakGlassOperation, outcome: BreakGlassOutcome, target: RoleBreakGlassAuditTarget): void {
    this.eventEmitter.emit(SysEventType.ResourceViewed, {
      responsibleEntityId: this.requestUser?.id,
      responsibleIp: this.requestIp,
      resourceType: this.resourceType,
      correlationId: this.correlationId,
      resourceId: target.targetId,
      tenantId: this.tenantId ?? SYSTEM_TENANT_ID,
      forceAuditLog: true,
      data: {
        action: RBAC_BREAK_GLASS_AUDIT_ACTION,
        operation,
        outcome,
        targetType: target.targetType,
        targetId: target.targetId,
        targetName: target.targetName,
        ...(target.roleId && { roleId: target.roleId }),
        ...(target.policyId && { policyId: target.policyId }),
        actorId: this.requestUser?.id,
        at: new Date().toISOString(),
      },
    });
  }

  /**
   * Validates parentRoleId: ensures the parent exists and there are no
   * circular references. Behaviour mirrors the prior helper
   * verbatim — the two `findUnique` lookups now go through
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
