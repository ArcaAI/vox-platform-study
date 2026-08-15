import { ForbiddenException, Inject, Injectable, Optional } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  CoreDatabaseService,
  ResourceType,
  ResourceStatusType,
  SysEventType,
  EntityId,
  UserRoleAssignmentEntity,
  UserRoleAssignmentFactory,
  UserRoleAssignmentRepository,
} from '@arcaai/domains';
import { InternalServerErrorException, ArgumentInvalidException, DataNotFoundException } from '@arcaai/exceptions';
import {
  ActiveUserRoleAssignmentRow,
  AuthRoleSummary,
  IUserRoleAssignmentService,
  RoleMemberRow,
  RoleMembersResult,
} from './IUserRoleAssignmentService';
import { CreateUserRoleAssignmentRequest, UpdateUserRoleAssignmentRequest } from './dto';
import { BaseService, FetchResponse, PaginatedQuery, withFormattedCountProps, withFormattedPaginatedProps } from '../../../common';
import { IActiveUserContext } from '../../../interfaces';
import { IEntitlementsService } from '../../entitlements/IEntitlementsService';
import { SUPER_ADMIN_ROLE } from '../../tenant/constants';

/** Raw joined shape of the members query (module-private). */
interface RoleMemberJoinRow {
  id: string;
  userId: string;
  roleId: string;
  tenantId: string;
  resourceStatus: string;
  createdAt: Date;
  User: {
    id: string;
    username: string;
    resourceStatus: string;
    UserProfile: { firstName: string | null; lastName: string | null; email: string | null } | null;
    UserDepartments: { tenantId: string; isPrimary: boolean; Department: { name: string | null } | null }[];
  } | null;
}

@Injectable()
export class UserRoleAssignmentService extends BaseService implements IUserRoleAssignmentService {
  constructor(
    private readonly userRoleAssignmentRepository: UserRoleAssignmentRepository,
    protected override readonly eventEmitter: EventEmitter2,
    protected override readonly clsService: ClsService<IActiveUserContext>,
    // Prisma access at the service layer is legitimate; the
    // controllers that previously did this directly now route
    // through here. The two read methods below need a join (`include: Role`)
    // and a `select` projection that the generated `Repository<E,M>` base
    // class cannot express, so we fall back to the raw client at this single
    // boundary — same precedent as `TenantService.getTenantUsage`.
    @Inject('CORE_DATABASE_SERVICE') private readonly databaseService: CoreDatabaseService,
    // Optional (append-only DI); enforces the plan
    // `maxUsers` SEAT quota when an assignment adds a NEW distinct member to the
    // tenant (kill-switch-gated, no-op when OFF).
    @Optional() @Inject(IEntitlementsService) private readonly entitlements?: IEntitlementsService,
  ) {
    super(eventEmitter, clsService, ResourceType.UserRoleAssignment);
  }

  /**
   * Count a tenant's occupied SEATS: distinct users
   * with at least one ENABLED role-assignment (mirrors
   * `TenantService.getUsageStats().totalUsers`).
   */
  private async countTenantSeats(tenantId: string): Promise<number> {
    const rows = await this.databaseService.baseClient.userRoleAssignment.findMany({
      where: { tenantId, resourceStatus: ResourceStatusType.ENABLED },
      select: { userId: true },
      distinct: ['userId'],
    });
    return rows.length;
  }

  async findActiveAssignmentForUserInTenant(userId: string, tenantId: string): Promise<ActiveUserRoleAssignmentRow | null> {
    // BaseClient (tenant-scope bypass). This is a pre-auth identity
    // lookup: the login flow calls it BEFORE any tenant context exists in CLS,
    // so the scoped client would throw "tenant context required for model
    // UserRoleAssignment". The tenant boundary is enforced explicitly by the
    // `tenantId` filter in the WHERE below, not by the `$extends`.
    const row = await this.databaseService.baseClient.userRoleAssignment.findFirst({
      where: {
        userId,
        tenantId,
        resourceStatus: ResourceStatusType.ENABLED,
      },
    });
    return (row as ActiveUserRoleAssignmentRow | null) ?? null;
  }

  async findActiveTenantIdsForUser(userId: string): Promise<string[]> {
    // BaseClient (tenant-scope bypass). This resolves EVERY tenant
    // the user is assigned to (impersonation target resolution); scoping it to
    // a single CLS tenant would defeat its purpose and it also runs in flows
    // without a tenant context. Cross-tenant by design.
    // `tenantId` is a non-nullable column (there is no NULL =
    // global semantics), so a `{ not: null }` filter is both invalid in
    // Prisma 7 ("Argument `not` must not be null") and redundant — the loop
    // below already skips empty/blank tenantIds.
    const rows = await this.databaseService.baseClient.userRoleAssignment.findMany({
      where: {
        userId,
        resourceStatus: ResourceStatusType.ENABLED,
      },
      select: { tenantId: true },
      orderBy: { createdAt: 'asc' },
    });

    const seen = new Set<string>();
    const ordered: string[] = [];
    for (const row of rows as Array<{ tenantId: string | null }>) {
      const tenantId = row.tenantId;
      if (typeof tenantId !== 'string' || tenantId.length === 0) continue;
      if (seen.has(tenantId)) continue;
      seen.add(tenantId);
      ordered.push(tenantId);
    }
    return ordered;
  }

  async findActiveRolesForUser(userId: string): Promise<AuthRoleSummary[]> {
    // BaseClient (tenant-scope bypass). Runs at login BEFORE the
    // user/tenant is in CLS (and for /me, /refresh, impersonation), so the
    // scoped client throws "tenant context required for model
    // UserRoleAssignment". Identity resolution is inherently cross-tenant: we
    // need ALL of the user's roles to determine SUPER_ADMIN and build claims.
    const rows = await this.databaseService.baseClient.userRoleAssignment.findMany({
      where: {
        userId,
        resourceStatus: ResourceStatusType.ENABLED,
      },
      include: { Role: true },
    });

    const result: AuthRoleSummary[] = [];
    for (const row of rows as Array<{ Role: { id: string; name: string; permissions?: string[] } | null }>) {
      const role = row.Role;
      if (!role) continue;
      result.push({
        id: role.id,
        name: role.name,
        permissions: role.permissions,
      });
    }
    return result;
  }

  async create(request: CreateUserRoleAssignmentRequest): Promise<UserRoleAssignmentEntity> {
    if (!request.userId || !request.roleId) {
      throw new ArgumentInvalidException('userId and roleId are required');
    }

    // Defense-in-depth role-tier
    // + cross-tenant-target guard against privilege escalation. Only an authenticated NON-global-admin caller
    // is constrained; SUPER_ADMIN and system/bootstrap (no CLS user) paths keep
    // the existing cross-tenant behaviour. Runs BEFORE any factory/repository
    // call so a rejected attempt never touches the write path.
    if (this.requestUser && !this.isSuperAdmin()) {
      await this.assertAssignableRoleTier(request.roleId);
      await this.assertTargetUserInCallerTenant(request.userId);
    }

    // Pin the working tenantId to the caller's CLS
    // context. The only legitimate cross-tenant create is when the caller
    // explicitly passes `request.tenantId` AND holds the SUPER_ADMIN role
    // (used by onboarding/bootstrap flows). Otherwise an explicit mismatch
    // is a privilege-escalation attempt and must be rejected before any
    // repository or factory call runs.
    const callerTenantId = this.tenantId ?? null;
    const requestedTenantId = request.tenantId;
    const isExplicitCrossTenant = requestedTenantId !== undefined && requestedTenantId !== null && requestedTenantId !== callerTenantId;

    let effectiveTenantId: string | null;
    if (isExplicitCrossTenant) {
      if (!this.isSuperAdmin()) {
        throw new ForbiddenException('Cross-tenant assignment is not permitted');
      }
      effectiveTenantId = requestedTenantId;
    } else {
      effectiveTenantId = callerTenantId;
    }

    // A "seat" = a distinct user with an ENABLED
    // assignment in the tenant. Adding an assignment for a user who is NOT yet
    // an active member consumes a new seat; granting an additional role to an
    // existing member does not. Enforce the plan `maxUsers` quota only for the
    // new-member case. Kill-switch-gated, no-op for unlimited tenants.
    if (effectiveTenantId && this.entitlements?.isEnforcementEnabled()) {
      const alreadyMember = await this.findActiveAssignmentForUserInTenant(request.userId, effectiveTenantId);
      if (!alreadyMember) {
        const seats = await this.countTenantSeats(effectiveTenantId);
        await this.entitlements.assertQuantityQuota(effectiveTenantId, 'maxUsers', seats);
      }
    }

    try {
      const existing = await this.userRoleAssignmentRepository.findFirst({
        where: {
          userId: request.userId,
          roleId: request.roleId,
          tenantId: effectiveTenantId,
          resourceStatus: ResourceStatusType.DELETED,
        },
      });
      const restored = await this.userRoleAssignmentRepository.restore(existing.id, this.requestUser?.id);
      this.broadcastSysEvent(SysEventType.ResourceCreated, {
        resourceId: restored.id,
        createdAt: restored.createdAt,
        data: restored.toObject() as object,
      });
      return restored;
    } catch (e) {
      if (!(e instanceof DataNotFoundException)) throw e;
    }

    const newUserRoleAssignment = UserRoleAssignmentFactory.CreateUserRoleAssignment({
      ...request,
      tenantId: effectiveTenantId,
      userId: request.userId,
      roleId: request.roleId,
      createdBy: this.requestUser?.id,
    });

    const userRoleAssignment = await this.userRoleAssignmentRepository.create(newUserRoleAssignment);

    if (!userRoleAssignment) {
      throw new InternalServerErrorException(`Failed to create UserRoleAssignmentEntity: ${request}`);
    }

    this.broadcastSysEvent(SysEventType.ResourceCreated, {
      resourceId: userRoleAssignment.id,
      createdAt: userRoleAssignment.createdAt,
      data: userRoleAssignment.toObject() as object,
    });
    return userRoleAssignment;
  }

  /**
   * True when the active request user carries the `SUPER_ADMIN` role.
   * Mirrors the pattern in `TenantService.isSuperAdmin()` — falls back to
   * `false` whenever the CLS context is missing or the role list is
   * undefined, so the strictest behaviour applies by default.
   */
  private isSuperAdmin(): boolean {
    const roles = this.requestUser?.roles;
    return Array.isArray(roles) && roles.includes(SUPER_ADMIN_ROLE);
  }

  /**
   * Reject a non-SUPER_ADMIN caller's attempt to grant the
   * platform-wide SUPER_ADMIN role. Per the `03-role` seed, SUPER_ADMIN is
   * the only Global role (its assignments are cross-tenant); every other role
   * is tenant-scoped and a TENANT_ADMIN may legitimately delegate it within
   * their tenant. Resolves the target role's name through the unscoped
   * `baseClient` (Role is a global, non-tenant-scoped model — same precedent
   * as the cross-tenant identity reads above). A missing/unknown role is left
   * for the downstream create/FK path to reject.
   */
  private async assertAssignableRoleTier(roleId: string): Promise<void> {
    const role = (await this.databaseService.baseClient.role.findUnique({
      where: { id: roleId },
      select: { name: true },
    })) as { name: string } | null;
    if (role?.name === SUPER_ADMIN_ROLE) {
      throw new ForbiddenException('Only a SUPER_ADMIN may assign the SUPER_ADMIN role');
    }
  }

  /**
   * Reject a non-SUPER_ADMIN caller's attempt to assign a role to
   * a user that belongs to a DIFFERENT tenant. A user with no ENABLED
   * membership yet (a fresh account being onboarded into the caller's tenant)
   * is allowed; a user whose memberships are all in other tenants is not.
   * Skipped when the caller has no concrete tenant context (system/global path).
   */
  private async assertTargetUserInCallerTenant(userId: string): Promise<void> {
    const callerTenantId = this.tenantId;
    if (!callerTenantId) {
      return;
    }
    const tenantIds = await this.findActiveTenantIdsForUser(userId);
    if (tenantIds.length > 0 && !tenantIds.includes(callerTenantId)) {
      throw new ForbiddenException('Cannot assign roles to a user outside your tenant');
    }
  }

  async fetchAll(props: PaginatedQuery): Promise<FetchResponse<UserRoleAssignmentEntity>> {
    const { limit, page } = props;
    const userRoleAssignments = await this.userRoleAssignmentRepository.findAll(withFormattedPaginatedProps(props));

    const count = await this.userRoleAssignmentRepository.count(withFormattedCountProps(props));

    this.broadcastSysEvent(SysEventType.ResourceViewed, {
      data: {
        items: userRoleAssignments.map((userRoleAssignment: UserRoleAssignmentEntity) => userRoleAssignment.id),
      },
    });
    return new FetchResponse<UserRoleAssignmentEntity>({
      data: userRoleAssignments,
      count,
      limit,
      page,
    });
  }

  async fetchAllByTenantId(props: PaginatedQuery & { tenantId: string }): Promise<FetchResponse<UserRoleAssignmentEntity>> {
    const { tenantId, limit, page } = props;
    const userRoleAssignments = await this.userRoleAssignmentRepository.findAll({
      ...withFormattedPaginatedProps(props),
      where: {
        tenantId,
      },
    });
    const count = await this.userRoleAssignmentRepository.count({
      ...withFormattedCountProps(props),
      where: {
        tenantId,
      },
    });

    this.broadcastSysEvent(SysEventType.ResourceViewed, {
      data: {
        tenantId,
        items: userRoleAssignments.map((userRoleAssignment: UserRoleAssignmentEntity) => userRoleAssignment.id),
      },
    });
    return new FetchResponse<UserRoleAssignmentEntity>({
      data: userRoleAssignments,
      count,
      limit,
      page,
    });
  }

  async fetchAllCreatedByUser(props: PaginatedQuery & { userId: string }): Promise<FetchResponse<UserRoleAssignmentEntity>> {
    const { userId, limit, page } = props;
    const userRoleAssignments = await this.userRoleAssignmentRepository.findAll({
      ...withFormattedPaginatedProps(props),
      where: {
        createdBy: userId,
      },
    });
    const count = await this.userRoleAssignmentRepository.count({
      ...withFormattedCountProps(props),
      where: {
        createdBy: userId,
      },
    });

    this.broadcastSysEvent(SysEventType.ResourceViewed, {
      data: {
        createdBy: userId,
        items: userRoleAssignments.map((userRoleAssignment: UserRoleAssignmentEntity) => userRoleAssignment.id),
      },
    });
    return new FetchResponse<UserRoleAssignmentEntity>({
      data: userRoleAssignments,
      count,
      limit,
      page,
    });
  }

  async fetchAllByUserId(props: PaginatedQuery & { userId: string }): Promise<FetchResponse<UserRoleAssignmentEntity>> {
    const { userId, limit, page } = props;
    const userRoleAssignments = await this.userRoleAssignmentRepository.findAll({
      ...withFormattedPaginatedProps(props),
      where: {
        userId,
      },
    });
    const count = await this.userRoleAssignmentRepository.count({
      ...withFormattedCountProps(props),
      where: {
        userId,
      },
    });

    this.broadcastSysEvent(SysEventType.ResourceViewed, {
      data: {
        userId,
        items: userRoleAssignments.map((userRoleAssignment: UserRoleAssignmentEntity) => userRoleAssignment.id),
      },
    });
    return new FetchResponse<UserRoleAssignmentEntity>({
      data: userRoleAssignments,
      count,
      limit,
      page,
    });
  }

  async fetchAllByRoleId(props: { page: number; pageSize: number; roleId: string }): Promise<RoleMembersResult> {
    const { page, pageSize, roleId } = props;
    const skip = (page - 1) * pageSize;

    // The members listing needs a `User` + profile + department
    // join the generic `Repository<E,M>` base cannot express, so it uses the
    // raw client at this service's sanctioned Prisma boundary (same precedent
    // as the reads above). Unlike those pre-auth identity reads it goes
    // through the SCOPED extended client (`client`, NOT `baseClient`): the
    // tenant-scope `$extends` injects the caller's CLS tenant so a tenant
    // admin sees only their tenant's members, an unscoped platform admin
    // (no CLS tenant + SUPER_ADMIN) passes through and sees all assignments,
    // and the soft-delete extension filters DELETED rows — the same posture
    // as `fetchAll`. Nested reads (`User`, `UserDepartments`) are NOT
    // intercepted by the extension; `User` is a global model, and the
    // department is matched to the ASSIGNMENT's tenant at mapping time.
    const [rows, total] = await Promise.all([
      this.databaseService.client.userRoleAssignment.findMany({
        where: { roleId },
        include: {
          User: {
            select: {
              id: true,
              username: true,
              resourceStatus: true,
              UserProfile: { select: { firstName: true, lastName: true, email: true } },
              UserDepartments: {
                where: { resourceStatus: ResourceStatusType.ENABLED },
                select: { tenantId: true, isPrimary: true, Department: { select: { name: true } } },
              },
            },
          },
        },
        orderBy: { createdAt: 'asc' },
        skip,
        take: pageSize,
      }),
      this.databaseService.client.userRoleAssignment.count({ where: { roleId } }),
    ]);

    const data = (rows as unknown as RoleMemberJoinRow[]).map((row) => this.toRoleMemberRow(row));

    this.broadcastSysEvent(SysEventType.ResourceViewed, {
      data: {
        roleId,
        items: data.map((member) => member.assignmentId),
      },
    });
    return { data, total };
  }

  /** Project a joined assignment row onto the public member shape. */
  private toRoleMemberRow(row: RoleMemberJoinRow): RoleMemberRow {
    const profile = row.User?.UserProfile ?? null;
    const displayName = [profile?.firstName, profile?.lastName].filter(Boolean).join(' ') || row.User?.username || row.userId;
    // The user is global; pick the department membership that belongs to the
    // ASSIGNMENT's tenant (primary preferred) so cross-tenant departments of
    // the same user never leak into another tenant's members view.
    const departments = (row.User?.UserDepartments ?? []).filter((membership) => membership.tenantId === row.tenantId);
    const department = departments.find((membership) => membership.isPrimary) ?? departments[0] ?? null;
    return {
      assignmentId: row.id,
      userId: row.userId,
      tenantId: row.tenantId,
      username: row.User?.username ?? row.userId,
      displayName,
      email: profile?.email ?? null,
      department: department?.Department?.name ?? null,
      resourceStatus: row.resourceStatus,
      userResourceStatus: row.User?.resourceStatus ?? row.resourceStatus,
      assignedAt: row.createdAt,
    };
  }

  async fetchById(id: EntityId): Promise<UserRoleAssignmentEntity> {
    const userRoleAssignment = await this.userRoleAssignmentRepository.findById(id);

    this.broadcastSysEvent(SysEventType.ResourceViewed, {
      resourceId: userRoleAssignment.id,
      data: userRoleAssignment.toObject() as object,
    });
    return userRoleAssignment;
  }

  async update(id: EntityId, request: UpdateUserRoleAssignmentRequest): Promise<UserRoleAssignmentEntity> {
    const userRoleAssignment = await this.userRoleAssignmentRepository.findById(id);

    const previousData = userRoleAssignment.toObject();
    this.updateEntity(userRoleAssignment, request);

    if (!userRoleAssignment.hasChanges) {
      throw new ArgumentInvalidException(`No changes to write to.`);
    }
    const updatedUserRoleAssignment = await this.userRoleAssignmentRepository.update(id, userRoleAssignment);

    this.broadcastSysEvent(SysEventType.ResourceUpdated, {
      resourceId: updatedUserRoleAssignment.id,
      data: userRoleAssignment.changes,
      previousData,
    });
    return updatedUserRoleAssignment;
  }

  async deleteById(id: EntityId): Promise<UserRoleAssignmentEntity> {
    const userRoleAssignment = await this.userRoleAssignmentRepository.softDelete(id);

    this.broadcastSysEvent(SysEventType.ResourceDeleted, {
      resourceId: userRoleAssignment.id,
      data: userRoleAssignment.toObject() as object,
    });
    return userRoleAssignment;
  }
}
