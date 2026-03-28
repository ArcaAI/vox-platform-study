import { Injectable } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ResourceType, SysEventType, EntityId, MediaEntity, MediaFactory, MediaRepository } from '@arcaai/domains';
import { InternalServerErrorException, ArgumentInvalidException } from '@arcaai/exceptions';
import { IMediaService } from './IMediaService';
import { CreateMediaRequest, UpdateMediaRequest } from './dto';
import { BaseService, FetchResponse, PaginatedQuery, withFormattedCountProps, withFormattedPaginatedProps } from '../../../common';
import { IActiveUserContext } from '../../../interfaces';

// TODO: Implement this

@Injectable()
export class MediaService extends BaseService implements IMediaService {
  constructor(
    private readonly mediaRepository: MediaRepository,
    protected override readonly eventEmitter: EventEmitter2,
    protected override readonly clsService: ClsService<IActiveUserContext>,
  ) {
    super(eventEmitter, clsService, ResourceType.Media);
  }

  async create(request: CreateMediaRequest): Promise<MediaEntity> {
    const newMedia = MediaFactory.CreateMedia({
      ...request,
      tenantId: request.tenantId,
      createdBy: this.requestUser?.id,
    });

    const media = await this.mediaRepository.create(newMedia);

    if (!media) {
      throw new InternalServerErrorException(`Failed to create MediaEntity: ${request}`);
    }

    this.broadcastSysEvent(SysEventType.ResourceCreated, {
      resourceId: media.id,
      createdAt: media.createdAt,
      data: media.toObject() as object,
    });
    return media;
  }

  async fetchAll(props: PaginatedQuery): Promise<FetchResponse<MediaEntity>> {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { limit, page, search } = props;
    const medias = await this.mediaRepository.findAll(withFormattedPaginatedProps(props));

    const count = await this.mediaRepository.count(withFormattedCountProps(props));

    this.broadcastSysEvent(SysEventType.ResourceViewed, {
      data: {
        items: medias.map((media: MediaEntity) => media.id),
      },
    });
    return new FetchResponse<MediaEntity>({
      data: medias,
      count,
      limit,
      page,
    });
  }

  async fetchAllByTenantId(props: PaginatedQuery & { tenantId: string }): Promise<FetchResponse<MediaEntity>> {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { tenantId, limit, page, search } = props;
    const medias = await this.mediaRepository.findAll({
      ...withFormattedPaginatedProps(props),
      where: {
        tenantId,
      },
    });
    const count = await this.mediaRepository.count({
      ...withFormattedCountProps(props),
      where: {
        tenantId,
      },
    });

    this.broadcastSysEvent(SysEventType.ResourceViewed, {
      data: {
        tenantId,
        items: medias.map((media: MediaEntity) => media.id),
      },
    });
    return new FetchResponse<MediaEntity>({
      data: medias,
      count,
      limit,
      page,
    });
  }

  async fetchAllCreatedByUser(props: PaginatedQuery & { userId: string }): Promise<FetchResponse<MediaEntity>> {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { userId, limit, page, search } = props;
    const medias = await this.mediaRepository.findAll({
      ...withFormattedPaginatedProps(props),
      where: {
        createdBy: userId,
      },
    });
    const count = await this.mediaRepository.count({
      ...withFormattedCountProps(props),
      where: {
        createdBy: userId,
      },
    });

    this.broadcastSysEvent(SysEventType.ResourceViewed, {
      data: {
        createdBy: userId,
        items: medias.map((media: MediaEntity) => media.id),
      },
    });
    return new FetchResponse<MediaEntity>({
      data: medias,
      count,
      limit,
      page,
    });
  }

  async fetchById(id: EntityId): Promise<MediaEntity> {
    const media = await this.mediaRepository.findById(id);

    this.broadcastSysEvent(SysEventType.ResourceViewed, {
      resourceId: media.id,
      data: media.toObject() as object,
    });
    return media;
  }

  async update(id: EntityId, request: UpdateMediaRequest): Promise<MediaEntity> {
    const media = await this.mediaRepository.findById(id);

    const previousData = media.toObject();
    this.updateEntity(media, request);

    if (!media.hasChanges) {
      throw new ArgumentInvalidException(`No changes to write to.`);
    }
    const updatedMedia = await this.mediaRepository.update(id, media);

    this.broadcastSysEvent(SysEventType.ResourceUpdated, {
      resourceId: updatedMedia.id,
      data: media.changes,
      previousData,
    });
    return updatedMedia;
  }

  async deleteById(id: EntityId): Promise<MediaEntity> {
    const media = await this.mediaRepository.softDelete(id);

    this.broadcastSysEvent(SysEventType.ResourceDeleted, {
      resourceId: media.id,
      data: media.toObject() as object,
    });
    return media;
  }
}
