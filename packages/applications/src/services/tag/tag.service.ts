import { Injectable } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ResourceType, SysEventType, EntityId, TagEntity, TagFactory, TagRepository } from '@arcaai/domains';
import { InternalServerErrorException, ArgumentInvalidException } from '@arcaai/exceptions';
import { ITagService } from './ITagService';
import { CreateTagRequest, UpdateTagRequest } from './dto';
import { BaseService, FetchResponse, PaginatedQuery, withFormattedCountProps, withFormattedPaginatedProps } from '../../common';
import { IActiveUserContext } from '../../interfaces';

// TODO: Implement this

@Injectable()
export class TagService extends BaseService implements ITagService {
  constructor(
    private readonly tagRepository: TagRepository,
    protected override readonly eventEmitter: EventEmitter2,
    protected override readonly clsService: ClsService<IActiveUserContext>,
  ) {
    super(eventEmitter, clsService, ResourceType.Tag);
  }

  async create(request: CreateTagRequest): Promise<TagEntity> {
    const newTag = TagFactory.CreateTag({
      ...request,
      tenantId: request.tenantId,
      createdBy: this.requestUser?.id,
    });

    const tag = await this.tagRepository.create(newTag);

    if (!tag) {
      throw new InternalServerErrorException(`Failed to create TagEntity: ${request}`);
    }

    this.broadcastSysEvent(SysEventType.ResourceCreated, {
      resourceId: tag.id,
      createdAt: tag.createdAt,
      data: tag.toObject() as object,
    });
    return tag;
  }

  /**
   * Fetch all (non-deleted) tags attached to a specific resource
   * (e.g. resourceTypeName='ContextItem', resourceId=<summary context item id>),
   * scoped to the caller's tenant.
   */
  async fetchByResource(resourceTypeName: string, resourceId: string): Promise<TagEntity[]> {
    const tags = await this.tagRepository.findAll({
      where: {
        resourceTypeName,
        resourceId,
        ...(this.tenantId ? { tenantId: this.tenantId } : {}),
      },
    });

    this.broadcastSysEvent(SysEventType.ResourceViewed, {
      data: {
        resourceTypeName,
        resourceId,
        items: tags.map((tag: TagEntity) => tag.id),
      },
    });

    return tags;
  }

  async fetchAll(props: PaginatedQuery): Promise<FetchResponse<TagEntity>> {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { limit, page, search } = props;
    const tags = await this.tagRepository.findAll(withFormattedPaginatedProps(props));

    const count = await this.tagRepository.count(withFormattedCountProps(props));

    this.broadcastSysEvent(SysEventType.ResourceViewed, {
      data: {
        items: tags.map((tag: TagEntity) => tag.id),
      },
    });
    return new FetchResponse<TagEntity>({
      data: tags,
      count,
      limit,
      page,
    });
  }

  async fetchAllByTenantId(props: PaginatedQuery & { tenantId: string }): Promise<FetchResponse<TagEntity>> {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { tenantId, limit, page, search } = props;
    const tags = await this.tagRepository.findAll({
      ...withFormattedPaginatedProps(props),
      where: {
        tenantId,
      },
    });
    const count = await this.tagRepository.count({
      ...withFormattedCountProps(props),
      where: {
        tenantId,
      },
    });

    this.broadcastSysEvent(SysEventType.ResourceViewed, {
      data: {
        tenantId,
        items: tags.map((tag: TagEntity) => tag.id),
      },
    });
    return new FetchResponse<TagEntity>({
      data: tags,
      count,
      limit,
      page,
    });
  }

  async fetchAllCreatedByUser(props: PaginatedQuery & { userId: string }): Promise<FetchResponse<TagEntity>> {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { userId, limit, page, search } = props;
    const tags = await this.tagRepository.findAll({
      ...withFormattedPaginatedProps(props),
      where: {
        createdBy: userId,
      },
    });
    const count = await this.tagRepository.count({
      ...withFormattedCountProps(props),
      where: {
        createdBy: userId,
      },
    });

    this.broadcastSysEvent(SysEventType.ResourceViewed, {
      data: {
        createdBy: userId,
        items: tags.map((tag: TagEntity) => tag.id),
      },
    });
    return new FetchResponse<TagEntity>({
      data: tags,
      count,
      limit,
      page,
    });
  }

  async fetchById(id: EntityId): Promise<TagEntity> {
    const tag = await this.tagRepository.findById(id);

    this.broadcastSysEvent(SysEventType.ResourceViewed, {
      resourceId: tag.id,
      data: tag.toObject() as object,
    });
    return tag;
  }

  async update(id: EntityId, request: UpdateTagRequest): Promise<TagEntity> {
    const tag = await this.tagRepository.findById(id);

    const previousData = tag.toObject();
    this.updateEntity(tag, request);

    if (!tag.hasChanges) {
      throw new ArgumentInvalidException(`No changes to write to.`);
    }
    const updatedTag = await this.tagRepository.update(id, tag);

    this.broadcastSysEvent(SysEventType.ResourceUpdated, {
      resourceId: updatedTag.id,
      data: tag.changes,
      previousData,
    });
    return updatedTag;
  }

  async deleteById(id: EntityId): Promise<TagEntity> {
    const tag = await this.tagRepository.softDelete(id);

    this.broadcastSysEvent(SysEventType.ResourceDeleted, {
      resourceId: tag.id,
      data: tag.toObject() as object,
    });
    return tag;
  }
}
