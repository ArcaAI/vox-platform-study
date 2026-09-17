import { ConflictException, Injectable, NotImplementedException } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  ResourceStatusType,
  ResourceType,
  SysEventType,
  EntityId,
  UserProfileEntity,
  UserProfileFactory,
  UserProfileRepository,
} from '@arcaai/domains';
import { InternalServerErrorException, ArgumentInvalidException } from '@arcaai/exceptions';
import { IUserProfileService } from './IUserProfileService';
import { CreateUserProfileRequest, UpdateUserProfileRequest } from './dto';
import { BaseService, FetchResponse, PaginatedQuery, withFormattedCountProps, withFormattedPaginatedProps } from '../../../common';
import { IActiveUserContext } from '../../../interfaces';

@Injectable()
export class UserProfileService extends BaseService implements IUserProfileService {
  constructor(
    private readonly userProfileRepository: UserProfileRepository,
    protected override readonly eventEmitter: EventEmitter2,
    protected override readonly clsService: ClsService<IActiveUserContext>,
  ) {
    super(eventEmitter, clsService, ResourceType.UserProfile);
  }

  /**
   * TASK-950 — refuse a `staffId` another user in THIS tenant already holds.
   *
   * ## Why the application enforces this and the database does not
   *
   * `UserProfile` has no tenant column — a user's tenant IS its `UserRoleAssignment` — so
   * `@@unique([tenantId, staffId])` cannot be expressed on the table (plan D-4 / OD-2). The
   * uniqueness that matters is nonetheless PER TENANT: two hospitals may legitimately both
   * employ staff number `12345`, and a global unique would make one of them unable to record
   * it.
   *
   * ## What this check is, and what it is not
   *
   * It is the ADMIN-surface guard: a human editing a profile gets 409 and a clear message
   * instead of silently creating the duplicate that makes every later identity resolution 409
   * `USER_IDENTITY_AMBIGUOUS`. It is NOT the concurrency guard — check-then-write is racy by
   * construction, and the machine plane that actually races (`ContextUserIdentityService`)
   * closes its own race with `pg_advisory_xact_lock` and a re-check inside the transaction.
   * Two admins typing the same staff id into two browser tabs in the same millisecond is not
   * the threat model; an integration firing two concurrent first requests is, and that one is
   * handled where it happens.
   *
   * ## No CLS tenant ⇒ no check
   *
   * "Unique within the tenant" has no meaning without a tenant. A super admin who has not
   * elevated a working tenant is unscoped, and widening the probe to every tenant would refuse
   * a staff id that is perfectly legal in the target tenant merely because another tenant uses
   * it — inventing a cross-tenant collision the model does not have. The resolver's own
   * in-transaction re-check still catches any duplicate at the moment it would matter.
   */
  private async assertStaffIdAvailable(staffId: string, excludeUserId?: string): Promise<void> {
    const tenantId = this.tenantId;
    if (!tenantId) return;

    const clashes = await this.userProfileRepository.findAll({
      where: {
        staffId,
        resourceStatus: { not: ResourceStatusType.DELETED },
        User: {
          resourceStatus: { not: ResourceStatusType.DELETED },
          // THE tenant boundary — the same predicate `ContextUserIdentityService` resolves
          // with, so the admin surface and the machine plane agree on what "taken" means.
          UserRoleAssignments: { some: { tenantId, resourceStatus: ResourceStatusType.ENABLED } },
        },
        ...(excludeUserId ? { userId: { not: excludeUserId } } : {}),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Prisma relational filter (`some`); `DbFilters` models scalar comparisons only. Same escape as UserService.fetchAllByTenantId.
      } as any,
      page: 1,
      limit: 1,
    });

    if (clashes.length > 0) {
      throw new ConflictException({
        message: 'Another user in this tenant already carries this staff identifier. Staff identifiers must be unique within a tenant.',
        code: 'STAFF_ID_TAKEN',
      });
    }
  }

  async create(request: CreateUserProfileRequest): Promise<UserProfileEntity> {
    if (request.staffId) {
      await this.assertStaffIdAvailable(request.staffId, request.userId);
    }

    const newUserProfile = UserProfileFactory.CreateUserProfile({
      ...request,
      createdBy: this.requestUser?.id,
    });

    const userProfile = await this.userProfileRepository.create(newUserProfile);

    if (!userProfile) {
      throw new InternalServerErrorException(`Failed to create UserProfileEntity: ${request}`);
    }

    this.broadcastSysEvent(SysEventType.ResourceCreated, {
      resourceId: userProfile.id,
      createdAt: userProfile.createdAt,
      data: userProfile.toObject() as object,
    });
    return userProfile;
  }

  async fetchAll(props: PaginatedQuery): Promise<FetchResponse<UserProfileEntity>> {
    const { limit, page } = props;
    const userProfiles = await this.userProfileRepository.findAll(withFormattedPaginatedProps(props));

    const count = await this.userProfileRepository.count(withFormattedCountProps(props));

    this.broadcastSysEvent(SysEventType.ResourceViewed, {
      data: {
        items: userProfiles.map((userProfile: UserProfileEntity) => userProfile.id),
      },
    });
    return new FetchResponse<UserProfileEntity>({
      data: userProfiles,
      count,
      limit,
      page,
    });
  }

  async fetchAllByTenantId(_props: PaginatedQuery & { tenantId: string }): Promise<FetchResponse<UserProfileEntity>> {
    throw new NotImplementedException();
  }

  async fetchAllCreatedByUser(props: PaginatedQuery & { userId: string }): Promise<FetchResponse<UserProfileEntity>> {
    const { userId, limit, page } = props;
    const userProfiles = await this.userProfileRepository.findAll({
      ...withFormattedPaginatedProps(props),
      where: {
        createdBy: userId,
      },
    });
    const count = await this.userProfileRepository.count({
      ...withFormattedCountProps(props),
      where: {
        createdBy: userId,
      },
    });

    this.broadcastSysEvent(SysEventType.ResourceViewed, {
      data: {
        createdBy: userId,
        items: userProfiles.map((userProfile: UserProfileEntity) => userProfile.id),
      },
    });
    return new FetchResponse<UserProfileEntity>({
      data: userProfiles,
      count,
      limit,
      page,
    });
  }

  async fetchById(id: EntityId): Promise<UserProfileEntity> {
    const userProfile = await this.userProfileRepository.findById(id);

    this.broadcastSysEvent(SysEventType.ResourceViewed, {
      resourceId: userProfile.id,
      data: userProfile.toObject() as object,
    });
    return userProfile;
  }

  /**
   * Fetch the profile row for a user. Returns null when the
   * user has no profile yet so callers can render an empty/editable state.
   */
  async getByUserId(userId: string): Promise<UserProfileEntity | null> {
    const [profile] = await this.userProfileRepository.findAll({
      where: { userId },
      page: 1,
      limit: 1,
    });

    if (profile) {
      this.broadcastSysEvent(SysEventType.ResourceViewed, {
        resourceId: profile.id,
        data: { userId },
      });
    }

    return profile ?? null;
  }

  /**
   * Create-or-update the profile keyed by userId. The
   * user-detail dialog edits a profile by user, not by profile id, and a user
   * may not have a profile row yet — so this upserts. Idempotent: a no-op
   * update returns the existing row rather than throwing.
   */
  async upsertByUserId(userId: string, request: UpdateUserProfileRequest): Promise<UserProfileEntity> {
    const [existing] = await this.userProfileRepository.findAll({
      where: { userId },
      page: 1,
      limit: 1,
    });

    if (!existing) {
      // `create` runs the staffId check itself, so this branch deliberately does not — probing
      // here as well would issue the same query twice on every profile creation.
      const created = await this.create({ ...request, userId });
      return created;
    }

    // TASK-950 — only a NON-NULL staffId needs the check; `null` CLEARS the value and can never
    // collide. Excludes this user, so re-saving a profile with its own unchanged staff id is not
    // a conflict with itself. This branch writes through the repository directly rather than via
    // `update()`, so it needs its own guard.
    if (request.staffId) {
      await this.assertStaffIdAvailable(request.staffId, userId);
    }

    const previousData = existing.toObject();
    this.updateEntity(existing, request);

    if (!existing.hasChanges) {
      return existing;
    }

    const updated = await this.userProfileRepository.update(existing.id, existing);

    this.broadcastSysEvent(SysEventType.ResourceUpdated, {
      resourceId: updated.id,
      data: existing.changes,
      previousData,
    });

    return updated;
  }

  async update(id: EntityId, request: UpdateUserProfileRequest): Promise<UserProfileEntity> {
    const userProfile = await this.userProfileRepository.findById(id);

    // TASK-950 — the by-id write path needs the same guard as the by-user one. The row is
    // resolved FIRST so the exclusion names the profile's own user: without it, saving a
    // profile with its staff id unchanged would conflict with itself.
    if (request.staffId) {
      await this.assertStaffIdAvailable(request.staffId, userProfile.userId);
    }

    const previousData = userProfile.toObject();
    this.updateEntity(userProfile, request);

    if (!userProfile.hasChanges) {
      throw new ArgumentInvalidException(`No changes to write to.`);
    }
    const updatedUserProfile = await this.userProfileRepository.update(id, userProfile);

    this.broadcastSysEvent(SysEventType.ResourceUpdated, {
      resourceId: updatedUserProfile.id,
      data: userProfile.changes,
      previousData,
    });
    return updatedUserProfile;
  }

  async deleteById(id: EntityId): Promise<UserProfileEntity> {
    const userProfile = await this.userProfileRepository.softDelete(id);

    this.broadcastSysEvent(SysEventType.ResourceDeleted, {
      resourceId: userProfile.id,
      data: userProfile.toObject() as object,
    });
    return userProfile;
  }
}
