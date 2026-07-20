import { Injectable, Inject, Optional, BadRequestException } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  ResourceType,
  ResourceStatusType,
  SysEventType,
  EntityId,
  UserEntity,
  UserFactory,
  UserRepository,
  UserRoleAssignmentEntity,
  UserRoleAssignmentFactory,
  UserRoleAssignmentRepository,
  UserDepartmentEntity,
  UserDepartmentFactory,
  UserDepartmentRepository,
  CoreDatabaseService,
} from '@arcaai/domains';
import { InternalServerErrorException, ArgumentInvalidException, NotFoundException } from '@arcaai/exceptions';
import { IUserService, UserExportEnrichment } from './IUserService';
import { IEntitlementsService } from '../../entitlements/IEntitlementsService';
import { IUserProfileService } from '../userProfile/IUserProfileService';
import { UpdateUserProfileRequest } from '../userProfile/dto/updateUserProfile.request';
import { CreateOAuthUserRequest, CreateUserRequest, UpdateUserRequest } from './dto';
import { BaseService, FetchResponse, PaginatedQuery, withFormattedPaginatedProps, withFormattedCountProps } from '../../../common';
import { IActiveUserContext } from '../../../interfaces';
import { ICryptoService } from '../../crypto/ICryptoService';
import { IJwtRevocationService } from '../../auth/jwt-revocation.service';
import { IAppSettingsService } from '../../baseServices/_meta/appSettings/IAppSettingsService';
import { resolvePasswordPolicy, validatePasswordComplexity } from '../userPassword/password-policy';

/**
 * TASK-375 §8 — the Users resource's Prisma model name. Passed to
 * `withFormatted{Paginated,Count}Props` so the shared deserializer coerces
 * EVERY boolean/number/date column of `User` from its stringly-typed CSV
 * `filters` value to the column's real type before the `where` reaches Prisma
 * (e.g. `isServiceAccount` → boolean, `version` → number, `createdAt` /
 * `lastLoginAt` → Date). Supersedes the per-column boolean opt-in
 * (DEFECT-F1's `['isServiceAccount']` allow-list); String/enum columns stay strings.
 * Passed to BOTH the data and count builders so they stay in lock-step.
 */
const USER_FILTER_MODEL = 'User';

// TODO: Implement this

@Injectable()
export class UserService extends BaseService implements IUserService {
  constructor(
    private readonly userRepository: UserRepository,
    private readonly userRoleAssignmentRepository: UserRoleAssignmentRepository,
    private readonly userDepartmentRepository: UserDepartmentRepository,
    protected override readonly eventEmitter: EventEmitter2,
    protected override readonly clsService: ClsService<IActiveUserContext>,
    // TASK-331 r2605 #3 — `baseClient.$transaction(callback)` is the canonical
    // Prisma-7 atomic idiom in this codebase (see TenantService TASK-302 D.4).
    @Inject('CORE_DATABASE_SERVICE') private readonly databaseService: CoreDatabaseService,
    // TASK-381 (V1) — `email` is a `UserProfile` field; the create flow upserts
    // it onto the profile after the identity row exists.
    @Inject(IUserProfileService) private readonly userProfileService: IUserProfileService,
    // TASK-402 (Defect 1) — creation/update-time passwords must be bcrypt-hashed
    // and policy-checked like every other password write path (the login
    // comparator is bcrypt; plaintext at rest could never log in).
    @Inject(ICryptoService) private readonly cryptoService: ICryptoService,
    @Inject(IAppSettingsService) private readonly appSettings: IAppSettingsService,
    // TASK-392 (Phase 3, C2) — optional (append-only DI); enforces the plan
    // `maxUsers` SEAT quota when onboarding a user WITH a role (kill-switch-gated).
    @Optional() @Inject(IEntitlementsService) private readonly entitlements?: IEntitlementsService,
    // TASK-541 A4 — optional (append-only DI); stamps a per-user not-before so
    // disabling an account also kills its already-issued access tokens.
    @Optional() @Inject(IJwtRevocationService) private readonly jwtRevocationService?: IJwtRevocationService,
  ) {
    super(eventEmitter, clsService, ResourceType.User);
  }

  /**
   * TASK-541 A4 — invalidate every access token already issued to `userId`.
   *
   * Called AFTER the status write commits, so a failed mutation never kills
   * live sessions. Never throws: `resourceStatus` in the DB is what blocks the
   * next login/refresh, and losing that write to an audit-adjacent Redis error
   * would be strictly worse than the token living out its `exp`.
   */
  private async revokeLiveTokens(userId: string): Promise<void> {
    if (!this.jwtRevocationService) return;
    try {
      await this.jwtRevocationService.revokeAllForUser(userId);
    } catch {
      // Swallowed by contract — JwtRevocationService already logs the failure.
    }
  }

  /**
   * TASK-402 (Defect 1) — validate against the TASK-400 complexity policy
   * (GlobalSettings-overridable) and bcrypt-hash a password destined for
   * persistence. Same voice as `UserPasswordService.assertPasswordPolicy`:
   * the 400 lists every unmet rule.
   */
  private async validateAndHashPassword(password: string): Promise<string> {
    const failures = validatePasswordComplexity(password, resolvePasswordPolicy(this.appSettings));
    if (failures.length > 0) {
      throw new BadRequestException(failures.join('. '));
    }
    return this.cryptoService.hash(password);
  }

  /**
   * TASK-392 (Phase 3, C2) — count a tenant's occupied SEATS: distinct users
   * with at least one ENABLED role-assignment (mirrors
   * `TenantService.getUsageStats().totalUsers`). Uses the unscoped `baseClient`
   * with an explicit `tenantId` filter — this can run inside/around the create
   * transaction where CLS scoping is awkward.
   */
  private async countTenantSeats(tenantId: string): Promise<number> {
    const rows = await this.databaseService.baseClient.userRoleAssignment.findMany({
      where: { tenantId, resourceStatus: ResourceStatusType.ENABLED },
      select: { userId: true },
      distinct: ['userId'],
    });
    return rows.length;
  }

  async create(request: CreateUserRequest): Promise<UserEntity> {
    const { roleId, departmentId, isPrimaryDepartment, email, ...userRequest } = request;
    const wantsMembership = Boolean(roleId || departmentId);

    // TASK-402 (Defect 1) — policy-check + bcrypt the creation-time password
    // BEFORE the factory so both the plain and the atomic membership branches
    // persist a hash, never plaintext. An empty password is the "no local
    // credential" placeholder (OAuth/`createExternalUser` semantics): it is
    // neither validated nor hashed, and the account stays non-loginable until
    // a password-module write.
    const hasCreationPassword = Boolean(userRequest.password);
    const password = hasCreationPassword ? await this.validateAndHashPassword(userRequest.password) : userRequest.password;

    const newUser = UserFactory.CreateUser({
      ...userRequest,
      password,
      externalId: userRequest.externalId || null,
      isServiceAccount: userRequest.isServiceAccount ?? false,
      createdBy: this.requestUser?.id,
    });
    if (hasCreationPassword) {
      // Rotation parity with the password module (TASK-400 `maxAgeDays`).
      newUser.passwordChangedAt = new Date();
    }

    if (!wantsMembership) {
      const user = await this.userRepository.create(newUser);

      if (!user) {
        throw new InternalServerErrorException(`Failed to create UserEntity: ${request}`);
      }

      this.broadcastSysEvent(SysEventType.ResourceCreated, {
        resourceId: user.id,
        createdAt: user.createdAt,
        data: user.toObject() as object,
      });
      await this.persistProfileEmail(user.id, email);
      return user;
    }

    // TASK-331 r2605 #3 — membership requested. Tenant attribution comes from
    // the ACTIVE CLS tenant (a super-admin's selected tenant is elevated into
    // CLS by the context interceptor; a tenant-admin's comes from their
    // session). It is NEVER taken from the request body — the same security
    // boundary `broadcastSysEvent` enforces for `tenantId`.
    const tenantId = this.tenantId;
    if (!tenantId) {
      throw new BadRequestException('Tenant context required to assign role/department');
    }

    // TASK-392 (Phase 3, C2) — onboarding a NEW user with a role consumes a new
    // seat (the user is brand-new, so it is always a distinct seat). Enforce the
    // plan `maxUsers` quota before the write. Kill-switch-gated (Q9); the seat
    // COUNT only runs when enforcement is ON. A department-only create (no
    // roleId) adds no seat, so it is not gated.
    if (roleId && this.entitlements?.isEnforcementEnabled()) {
      const seats = await this.countTenantSeats(tenantId);
      await this.entitlements.assertQuantityQuota(tenantId, 'maxUsers', seats);
    }

    // Create the identity + membership rows atomically so a partial failure
    // leaves NO orphaned user (which would silently fail the Phase F login
    // invariant). Each repository.create participates via the supplied `tx`.
    const { user, roleAssignment, departmentAssignment } = await this.databaseService.baseClient.$transaction(async (tx) => {
      const createdUser = await this.userRepository.create(newUser, tx);
      if (!createdUser) {
        throw new InternalServerErrorException(`Failed to create UserEntity: ${request}`);
      }

      let roleAssignment: UserRoleAssignmentEntity | undefined;
      if (roleId) {
        const roleEntity = UserRoleAssignmentFactory.CreateUserRoleAssignment({
          userId: createdUser.id,
          roleId,
          tenantId,
          createdBy: this.requestUser?.id,
        });
        roleAssignment = await this.userRoleAssignmentRepository.create(roleEntity, tx);
      }

      let departmentAssignment: UserDepartmentEntity | undefined;
      if (departmentId) {
        const departmentEntity = UserDepartmentFactory.CreateUserDepartment({
          tenantId,
          userId: createdUser.id,
          departmentId,
          isPrimary: isPrimaryDepartment ?? false,
          createdBy: this.requestUser?.id,
        });
        departmentAssignment = await this.userDepartmentRepository.create(departmentEntity, tx);
      }

      return { user: createdUser, roleAssignment, departmentAssignment };
    });

    // Broadcast AFTER commit so a rolled-back transaction emits no audit noise.
    this.broadcastSysEvent(SysEventType.ResourceCreated, {
      resourceId: user.id,
      createdAt: user.createdAt,
      data: user.toObject() as object,
    });
    if (roleAssignment) {
      this.broadcastSysEvent(SysEventType.ResourceCreated, {
        resourceType: ResourceType.UserRoleAssignment,
        resourceId: roleAssignment.id,
        createdAt: roleAssignment.createdAt,
        data: roleAssignment.toObject() as object,
      });
    }
    if (departmentAssignment) {
      this.broadcastSysEvent(SysEventType.ResourceCreated, {
        resourceType: ResourceType.UserDepartment,
        resourceId: departmentAssignment.id,
        createdAt: departmentAssignment.createdAt,
        data: departmentAssignment.toObject() as object,
      });
    }
    await this.persistProfileEmail(user.id, email);
    return user;
  }

  /**
   * TASK-381 (V1) — `email` is a `UserProfile` field, not a `User` column. When
   * the admin create-user payload carries an email, upsert it onto the profile
   * after the identity row exists (keyed by userId). No-op when email is absent.
   */
  private async persistProfileEmail(userId: string, email?: string): Promise<void> {
    if (!email) return;
    await this.userProfileService.upsertByUserId(userId, { email } as UpdateUserProfileRequest);
  }

  async createExternalUser(request: CreateOAuthUserRequest): Promise<UserEntity> {
    const newUser = UserFactory.CreateUser({
      ...request,
      username: request.externalId,
      password: '',
      isServiceAccount: false,
      createdBy: this.requestUser?.id,
    });

    const user = await this.userRepository.create(newUser);

    if (!user) {
      throw new InternalServerErrorException(`Failed to create external UserEntity: ${request}`);
    }

    this.broadcastSysEvent(SysEventType.ResourceCreated, {
      resourceId: user.id,
      createdAt: user.createdAt,
      data: user.toObject() as object,
    });
    return user;
  }

  async fetchAll(props: PaginatedQuery): Promise<FetchResponse<UserEntity>> {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { limit, page, search } = props;
    const users = await this.userRepository.findAll(withFormattedPaginatedProps(props, USER_FILTER_MODEL));

    const count = await this.userRepository.count(withFormattedCountProps(props, USER_FILTER_MODEL));

    this.broadcastSysEvent(SysEventType.ResourceViewed, {
      data: {
        items: users.map((user: UserEntity) => user.id),
      },
    });
    return new FetchResponse<UserEntity>({
      data: users,
      count,
      limit,
      page,
    });
  }

  async fetchAllByTenantId(props: PaginatedQuery & { tenantId: string }): Promise<FetchResponse<UserEntity>> {
    const { tenantId, limit, page } = props;
    // Prisma relational filter — DbFilters doesn't model `some`. The
    // `resourceStatus: { not: DELETED }` clause excludes users whose only
    // membership in this tenant is via a soft-deleted UserRoleAssignment.
    const tenantWhere = {
      UserRoleAssignments: { some: { tenantId, resourceStatus: { not: ResourceStatusType.DELETED } } },
    } as Record<string, unknown>;

    const users = await this.userRepository.findAll({
      ...withFormattedPaginatedProps(props, USER_FILTER_MODEL),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      where: tenantWhere as any,
    });
    const count = await this.userRepository.count({
      ...withFormattedCountProps(props, USER_FILTER_MODEL),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      where: tenantWhere as any,
    });

    this.broadcastSysEvent(SysEventType.ResourceViewed, {
      data: {
        tenantId,
        items: users.map((user: UserEntity) => user.id),
      },
    });
    return new FetchResponse<UserEntity>({
      data: users,
      count,
      limit,
      page,
    });
  }

  async fetchAllCreatedByUser(props: PaginatedQuery & { userId: string }): Promise<FetchResponse<UserEntity>> {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { userId, limit, page, search } = props;
    const users = await this.userRepository.findAll({
      ...withFormattedPaginatedProps(props, USER_FILTER_MODEL),
      where: {
        createdBy: userId,
      },
    });
    const count = await this.userRepository.count({
      ...withFormattedCountProps(props, USER_FILTER_MODEL),
      where: {
        createdBy: userId,
      },
    });

    this.broadcastSysEvent(SysEventType.ResourceViewed, {
      data: {
        createdBy: userId,
        items: users.map((user: UserEntity) => user.id),
      },
    });
    return new FetchResponse<UserEntity>({
      data: users,
      count,
      limit,
      page,
    });
  }

  async fetchById(id: EntityId): Promise<UserEntity> {
    const user = await this.userRepository.findById(id);

    this.broadcastSysEvent(SysEventType.ResourceViewed, {
      resourceId: user.id,
      data: user.toObject() as object,
    });
    return user;
  }

  async fetchByExternalId(externalId: string): Promise<UserEntity> {
    const user = await this.userRepository.findFirst({
      where: { externalId },
    });

    if (!user) {
      throw new NotFoundException(`User with external ID ${externalId} not found.`);
    }

    this.broadcastSysEvent(SysEventType.ResourceViewed, {
      resourceId: user.id,
      data: user.toObject() as object,
    });
    return user;
  }

  async update(id: EntityId, request: UpdateUserRequest): Promise<UserEntity> {
    const user = await this.userRepository.findById(id);

    const previousData = user.toObject();
    // TASK-402 (Defect 1) — a password update goes through the same policy +
    // bcrypt path as creation (the generic assignment used to store the DTO's
    // plaintext verbatim). The handler re-stamps `passwordChangedAt` so the
    // TASK-400 rotation check sees this write like any password-module write.
    await this.updateEntity(user, request, {
      password: async ({ entity, value }) => {
        const hashed = await this.validateAndHashPassword(String(value));
        entity.passwordChangedAt = new Date();
        return hashed;
      },
    });

    if (!user.hasChanges) {
      throw new ArgumentInvalidException(`No changes to write to.`);
    }
    const updatedUser = await this.userRepository.update(id, user);

    // TASK-541 A4 — a transition AWAY from ENABLED (disable / suspend /
    // archive / delete) must also kill tokens already in the wild; the
    // ENABLED filters on login+refresh only gate the NEXT credential.
    if (request.resourceStatus && request.resourceStatus !== ResourceStatusType.ENABLED) {
      await this.revokeLiveTokens(String(id));
    }

    this.broadcastSysEvent(SysEventType.ResourceUpdated, {
      resourceId: updatedUser.id,
      data: user.changes,
      previousData,
    });
    return updatedUser;
  }

  async deleteById(id: EntityId): Promise<UserEntity> {
    const user = await this.userRepository.softDelete(id);

    // TASK-541 A4 — same reasoning as update(): the soft-deleted user's live
    // tokens die with the row, not at their own exp.
    await this.revokeLiveTokens(String(id));

    this.broadcastSysEvent(SysEventType.ResourceDeleted, {
      resourceId: user.id,
      data: user.toObject() as object,
    });
    return user;
  }

  /**
   * TASK-398 (P1-7) — export enrichment read-model: profile email + active
   * department NAMES for every id in ONE pass. Exactly two grouped queries
   * (`userId IN (...)`) + an in-memory join — never per-row lookups — so a
   * 10 000-row export costs the same round-trips as a 10-row one.
   *
   * Uses the unscoped `baseClient` (same precedent as `countTenantSeats`): the
   * caller has already materialised a tenant-scoped id set, and the optional
   * explicit `tenantId` predicate re-applies that boundary to the membership
   * rows so a tenant export never carries another tenant's department names.
   * Department names order primary-first, then assignment age. No SysEvent —
   * auxiliary read; the export's fetch already broadcasts `ResourceViewed`.
   */
  async getExportEnrichment(userIds: string[], tenantId?: string): Promise<Record<string, UserExportEnrichment>> {
    const result: Record<string, UserExportEnrichment> = {};
    if (userIds.length === 0) return result;
    for (const id of userIds) {
      result[id] = { email: '', departmentNames: [] };
    }

    const [profiles, memberships] = await Promise.all([
      this.databaseService.baseClient.userProfile.findMany({
        where: { userId: { in: userIds }, resourceStatus: { not: ResourceStatusType.DELETED } },
        select: { userId: true, email: true },
      }),
      this.databaseService.baseClient.userDepartment.findMany({
        where: {
          userId: { in: userIds },
          resourceStatus: ResourceStatusType.ENABLED,
          ...(tenantId ? { tenantId } : {}),
        },
        select: { userId: true, Department: { select: { name: true } } },
        orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
      }),
    ]);

    for (const profile of profiles as Array<{ userId: string; email: string | null }>) {
      const entry = result[profile.userId];
      if (entry) entry.email = profile.email ?? '';
    }
    for (const membership of memberships as Array<{ userId: string; Department: { name: string } | null }>) {
      const entry = result[membership.userId];
      const name = membership.Department?.name;
      if (entry && name) entry.departmentNames.push(name);
    }
    return result;
  }
}
