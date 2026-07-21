import { Injectable, Inject, Optional } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ResourceType, SysEventType, EntityId, MediaEntity, MediaFactory, MediaRepository } from '@arcaai/domains';
import { InternalServerErrorException, ArgumentInvalidException } from '@arcaai/exceptions';
import { IMediaService } from './IMediaService';
import { IEntitlementsService } from '../../entitlements/IEntitlementsService';
import { CreateMediaRequest, UpdateMediaRequest } from './dto';
import { BaseService, FetchResponse, PaginatedQuery, withFormattedCountProps, withFormattedPaginatedProps } from '../../../common';
import { IActiveUserContext } from '../../../interfaces';

/**
 * TASK-406 (P2-6c) — model-aware filter coercion (TASK-375 §8 scheme): coerces
 * CSV `filters` values to the Media columns' real types (`size`/`version` →
 * number, `createdAt` → Date, `resourceStatus` → member-validated enum,
 * `metaData` → JSON-path support). Passed to BOTH the data and count builders.
 */
const MEDIA_FILTER_MODEL = 'Media';

@Injectable()
export class MediaService extends BaseService implements IMediaService {
  constructor(
    private readonly mediaRepository: MediaRepository,
    protected override readonly eventEmitter: EventEmitter2,
    protected override readonly clsService: ClsService<IActiveUserContext>,
    // TASK-392 (Phase 3, C1) — optional (append-only DI); evaluates the tenant
    // storage SOFT-WARN on upload (kill-switch-gated, never blocks).
    @Optional() @Inject(IEntitlementsService) private readonly entitlements?: IEntitlementsService,
  ) {
    super(eventEmitter, clsService, ResourceType.Media);
  }

  async create(request: CreateMediaRequest): Promise<MediaEntity> {
    // TASK-392 (Phase 3, C1) — storage soft-warn (Q6). SOFT: emits a warning
    // signal when this upload crosses the tenant quota but NEVER blocks the
    // upload. Defensive swallow so a telemetry failure can't fail an upload.
    if (request.tenantId && this.entitlements) {
      try {
        await this.entitlements.evaluateStorageSoftWarn(request.tenantId, request.size);
      } catch {
        // soft-warn is best-effort; ignore.
      }
    }

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
    const { limit, page } = props;
    const medias = await this.mediaRepository.findAll(withFormattedPaginatedProps(props, MEDIA_FILTER_MODEL));

    const count = await this.mediaRepository.count(withFormattedCountProps(props, MEDIA_FILTER_MODEL));

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
    const { tenantId, limit, page } = props;
    const medias = await this.mediaRepository.findAll({
      ...withFormattedPaginatedProps(props, MEDIA_FILTER_MODEL),
      where: {
        tenantId,
      },
    });
    const count = await this.mediaRepository.count({
      ...withFormattedCountProps(props, MEDIA_FILTER_MODEL),
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
    const { userId, limit, page } = props;
    const medias = await this.mediaRepository.findAll({
      ...withFormattedPaginatedProps(props, MEDIA_FILTER_MODEL),
      where: {
        createdBy: userId,
      },
    });
    const count = await this.mediaRepository.count({
      ...withFormattedCountProps(props, MEDIA_FILTER_MODEL),
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
