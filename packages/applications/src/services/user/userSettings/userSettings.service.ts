import { EntityId, ResourceType, SysEventType, UserSettingsEntity, UserSettingsFactory, UserSettingsRepository } from '@arcaai/domains';
import { ArgumentInvalidException, InternalServerErrorException } from '@arcaai/exceptions';
import { Injectable, NotImplementedException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ClsService } from 'nestjs-cls';
import { BaseService, FetchResponse, PaginatedQuery, withFormattedPaginatedProps, withFormattedCountProps } from '../../../common';
import { IActiveUserContext } from '../../../interfaces';
import { IUserSettingsService } from './IUserSettingsService';
import { CreateUserSettingsRequest, UpdateUserSettingsRequest, UpdateUserSettingByKeyRequest } from './dto';
import { USER_SETTINGS_NAMESPACES, validateUiDataGridValue } from './userSettings.namespaces';
import { ValueType } from '@arcaai/domains';

@Injectable()
export class UserSettingsService extends BaseService implements IUserSettingsService {
  constructor(
    private readonly userSettingsRepository: UserSettingsRepository,
    protected override readonly eventEmitter: EventEmitter2,
    protected override readonly clsService: ClsService<IActiveUserContext>,
  ) {
    super(eventEmitter, clsService, ResourceType.UserSettings);
  }

  async create(request: CreateUserSettingsRequest): Promise<UserSettingsEntity> {
    const newUserSettings = UserSettingsFactory.CreateUserSettings({
      ...request,
      createdBy: this.requestUser?.id,
    });

    const userSettings = await this.userSettingsRepository.create(newUserSettings);

    if (!userSettings) {
      throw new InternalServerErrorException(`Failed to create UserSettingsEntity: ${request}`);
    }

    this.broadcastSysEvent(SysEventType.ResourceCreated, {
      resourceId: userSettings.id,
      createdAt: userSettings.createdAt,
      data: userSettings.toObject() as object,
    });
    return userSettings;
  }

  async fetchAll(props: PaginatedQuery): Promise<FetchResponse<UserSettingsEntity>> {
    const { limit, page } = props;
    const userSettingss = await this.userSettingsRepository.findAll(withFormattedPaginatedProps(props));

    const count = await this.userSettingsRepository.count(withFormattedCountProps(props));

    this.broadcastSysEvent(SysEventType.ResourceViewed, {
      data: {
        items: userSettingss.map((userSettings: UserSettingsEntity) => userSettings.id),
      },
    });
    return new FetchResponse<UserSettingsEntity>({
      data: userSettingss,
      count,
      limit,
      page,
    });
  }

  async fetchAllByTenantId(_props: PaginatedQuery & { tenantId: string }): Promise<FetchResponse<UserSettingsEntity>> {
    throw new NotImplementedException();
  }

  async fetchAllCreatedByUser(props: PaginatedQuery & { userId: string }): Promise<FetchResponse<UserSettingsEntity>> {
    const { userId, limit, page } = props;
    const userSettingss = await this.userSettingsRepository.findAll({
      ...withFormattedPaginatedProps(props),
      where: {
        createdBy: userId,
      },
    });
    const count = await this.userSettingsRepository.count({
      ...withFormattedCountProps(props),
      where: {
        createdBy: userId,
      },
    });

    this.broadcastSysEvent(SysEventType.ResourceViewed, {
      data: {
        createdBy: userId,
        items: userSettingss.map((userSettings: UserSettingsEntity) => userSettings.id),
      },
    });
    return new FetchResponse<UserSettingsEntity>({
      data: userSettingss,
      count,
      limit,
      page,
    });
  }

  async fetchAllByUserId(userId: string): Promise<UserSettingsEntity[]> {
    const settings = await this.userSettingsRepository.findAll({
      where: { userId } as Record<string, unknown>,
      limit: 500,
      page: 1,
    });

    this.broadcastSysEvent(SysEventType.ResourceViewed, {
      data: {
        userId,
        items: settings.map((s: UserSettingsEntity) => s.id),
      },
    });

    return settings;
  }

  async fetchById(id: EntityId): Promise<UserSettingsEntity> {
    const userSettings = await this.userSettingsRepository.findById(id);

    this.broadcastSysEvent(SysEventType.ResourceViewed, {
      resourceId: userSettings.id,
      data: userSettings.toObject() as object,
    });
    return userSettings;
  }

  async update(id: EntityId, request: UpdateUserSettingsRequest): Promise<UserSettingsEntity> {
    const userSettings = await this.userSettingsRepository.findById(id);

    const previousData = userSettings.toObject();
    this.updateEntity(userSettings, request);

    if (!userSettings.hasChanges) {
      throw new ArgumentInvalidException(`No changes to write to.`);
    }
    const updatedUserSettings = await this.userSettingsRepository.update(id, userSettings);

    this.broadcastSysEvent(SysEventType.ResourceUpdated, {
      resourceId: updatedUserSettings.id,
      data: userSettings.changes,
      previousData,
    });
    return updatedUserSettings;
  }

  async upsertByUserKeyNamespace(
    userId: string,
    namespace: string,
    key: string,
    request: UpdateUserSettingByKeyRequest,
  ): Promise<UserSettingsEntity> {
    // TASK-375 (item 1 backend) — solidify D8. Validate the `ui.data-grid`
    // round-trip in the SERVICE (not just the self-service controller) so the
    // admin upsert path is covered too. The open registry is preserved: only
    // the `ui.data-grid` namespace is guarded; all others pass through.
    if (namespace === USER_SETTINGS_NAMESPACES.UI_DATA_GRID) {
      validateUiDataGridValue(request.value);
    }

    const existing = await this.userSettingsRepository.findByUserKeyNamespace(userId, key, namespace);

    if (existing) {
      const previousData = existing.toObject() as object;
      this.updateEntity(existing, {
        value: request.value,
        ...(request.dataType !== undefined && { dataType: request.dataType }),
        ...(request.name !== undefined && { name: request.name }),
      });

      if (!existing.hasChanges) {
        return existing;
      }

      const updated = await this.userSettingsRepository.update(existing.id, existing);

      this.broadcastSysEvent(SysEventType.ResourceUpdated, {
        resourceId: updated.id,
        data: existing.changes,
        previousData,
      });

      return updated;
    }

    const newSetting = UserSettingsFactory.CreateUserSettings({
      userId,
      key,
      namespace,
      value: request.value,
      dataType: request.dataType ?? ValueType.String,
      name: request.name ?? `${namespace}:${key}`,
      createdBy: this.requestUser?.id,
    });

    const created = await this.userSettingsRepository.create(newSetting);

    this.broadcastSysEvent(SysEventType.ResourceCreated, {
      resourceId: created.id,
      createdAt: created.createdAt,
      data: created.toObject() as object,
    });

    return created;
  }

  async deleteById(id: EntityId): Promise<UserSettingsEntity> {
    const userSettings = await this.userSettingsRepository.softDelete(id);

    this.broadcastSysEvent(SysEventType.ResourceDeleted, {
      resourceId: userSettings.id,
      data: userSettings.toObject() as object,
    });
    return userSettings;
  }
}
