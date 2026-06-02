import { Injectable, NotImplementedException } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ResourceType, SysEventType, EntityId, UserProfileEntity, UserProfileFactory, UserProfileRepository } from '@arcaai/domains';
import { InternalServerErrorException, ArgumentInvalidException } from '@arcaai/exceptions';
import { IUserProfileService } from './IUserProfileService';
import { CreateUserProfileRequest, UpdateUserProfileRequest } from './dto';
import { BaseService, FetchResponse, PaginatedQuery, withFormattedCountProps, withFormattedPaginatedProps } from '../../../common';
import { IActiveUserContext } from '../../../interfaces';

// TODO: Implement this

@Injectable()
export class UserProfileService extends BaseService implements IUserProfileService {
  constructor(
    private readonly userProfileRepository: UserProfileRepository,
    protected override readonly eventEmitter: EventEmitter2,
    protected override readonly clsService: ClsService<IActiveUserContext>,
  ) {
    super(eventEmitter, clsService, ResourceType.UserProfile);
  }

  async create(request: CreateUserProfileRequest): Promise<UserProfileEntity> {
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
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { limit, page, search } = props;
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

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async fetchAllByTenantId(props: PaginatedQuery & { tenantId: string }): Promise<FetchResponse<UserProfileEntity>> {
    throw new NotImplementedException();
  }

  async fetchAllCreatedByUser(props: PaginatedQuery & { userId: string }): Promise<FetchResponse<UserProfileEntity>> {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { userId, limit, page, search } = props;
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
   * Fetch the profile row for a user (TASK-328 A1–A3). Returns null when the
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
   * Create-or-update the profile keyed by userId (TASK-328 A1–A3). The
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
      const created = await this.create({ ...request, userId });
      return created;
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
