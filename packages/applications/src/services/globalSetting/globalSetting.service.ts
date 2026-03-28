import { Injectable } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ResourceType, SysEventType, EntityId, GlobalSettingEntity, GlobalSettingFactory, GlobalSettingRepository } from '@arcaai/domains';
import { InternalServerErrorException, ArgumentInvalidException } from '@arcaai/exceptions';
import { IGlobalSettingService } from './IGlobalSettingService';
import { CreateGlobalSettingRequest, UpdateGlobalSettingRequest } from './dto';
import { BaseService, FetchResponse, PaginatedQuery, withFormattedPaginatedProps, withFormattedCountProps } from '../../common';
import { IActiveUserContext } from '../../interfaces';

// TODO: Implement this

@Injectable()
export class GlobalSettingService extends BaseService implements IGlobalSettingService {
  constructor(
    private readonly globalSettingRepository: GlobalSettingRepository,
    protected override readonly eventEmitter: EventEmitter2,
    protected override readonly clsService: ClsService<IActiveUserContext>,
  ) {
    super(eventEmitter, clsService, ResourceType.GlobalSetting);
  }

  async create(request: CreateGlobalSettingRequest): Promise<GlobalSettingEntity> {
    const newGlobalSetting = GlobalSettingFactory.CreateGlobalSetting({
      ...request,
      tenantId: request.tenantId,
      createdBy: this.requestUser?.id,
    });

    const globalSetting = await this.globalSettingRepository.create(newGlobalSetting);

    if (!globalSetting) {
      throw new InternalServerErrorException(`Failed to create GlobalSettingEntity: ${request}`);
    }

    this.broadcastSysEvent(SysEventType.ResourceCreated, {
      resourceId: globalSetting.id,
      createdAt: globalSetting.createdAt,
      data: globalSetting.toObject() as object,
    });
    return globalSetting;
  }

  async fetchAll(props: PaginatedQuery): Promise<FetchResponse<GlobalSettingEntity>> {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { limit, page, search } = props;
    const globalSettings = await this.globalSettingRepository.findAll(withFormattedPaginatedProps(props));

    const count = await this.globalSettingRepository.count(withFormattedCountProps(props));

    this.broadcastSysEvent(SysEventType.ResourceViewed, {
      data: {
        items: globalSettings.map((globalSetting: GlobalSettingEntity) => globalSetting.id),
      },
    });
    return new FetchResponse<GlobalSettingEntity>({
      data: globalSettings,
      count,
      limit,
      page,
    });
  }

  async fetchAllByTenantId(props: PaginatedQuery & { tenantId: string }): Promise<FetchResponse<GlobalSettingEntity>> {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { tenantId, limit, page, search } = props;
    const globalSettings = await this.globalSettingRepository.findAll({
      ...withFormattedPaginatedProps(props),
      where: {
        tenantId,
      },
    });
    const count = await this.globalSettingRepository.count({
      ...withFormattedCountProps(props),
      where: {
        tenantId,
      },
    });

    this.broadcastSysEvent(SysEventType.ResourceViewed, {
      data: {
        tenantId,
        items: globalSettings.map((globalSetting: GlobalSettingEntity) => globalSetting.id),
      },
    });
    return new FetchResponse<GlobalSettingEntity>({
      data: globalSettings,
      count,
      limit,
      page,
    });
  }

  async fetchAllCreatedByUser(props: PaginatedQuery & { userId: string }): Promise<FetchResponse<GlobalSettingEntity>> {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { userId, limit, page, search } = props;
    const globalSettings = await this.globalSettingRepository.findAll({
      ...withFormattedPaginatedProps(props),
      where: {
        createdBy: userId,
      },
    });
    const count = await this.globalSettingRepository.count({
      ...withFormattedCountProps(props),
      where: {
        createdBy: userId,
      },
    });

    this.broadcastSysEvent(SysEventType.ResourceViewed, {
      data: {
        createdBy: userId,
        items: globalSettings.map((globalSetting: GlobalSettingEntity) => globalSetting.id),
      },
    });
    return new FetchResponse<GlobalSettingEntity>({
      data: globalSettings,
      count,
      limit,
      page,
    });
  }

  async fetchById(id: EntityId): Promise<GlobalSettingEntity> {
    const globalSetting = await this.globalSettingRepository.findById(id);

    this.broadcastSysEvent(SysEventType.ResourceViewed, {
      resourceId: globalSetting.id,
      data: globalSetting.toObject() as object,
    });
    return globalSetting;
  }

  async update(id: EntityId, request: UpdateGlobalSettingRequest): Promise<GlobalSettingEntity> {
    const globalSetting = await this.globalSettingRepository.findById(id);

    const previousData = globalSetting.toObject();
    this.updateEntity(globalSetting, request);

    if (!globalSetting.hasChanges) {
      throw new ArgumentInvalidException(`No changes to write to.`);
    }
    const updatedGlobalSetting = await this.globalSettingRepository.update(id, globalSetting);

    this.broadcastSysEvent(SysEventType.ResourceUpdated, {
      resourceId: updatedGlobalSetting.id,
      data: globalSetting.changes,
      previousData,
    });
    return updatedGlobalSetting;
  }

  async deleteById(id: EntityId): Promise<GlobalSettingEntity> {
    const globalSetting = await this.globalSettingRepository.softDelete(id);

    this.broadcastSysEvent(SysEventType.ResourceDeleted, {
      resourceId: globalSetting.id,
      data: globalSetting.toObject() as object,
    });
    return globalSetting;
  }
}
