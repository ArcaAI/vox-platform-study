import { Injectable, NotImplementedException } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
    ResourceType,
    SysEventType,
    EntityId,
    UserMediaEntity,
    UserMediaFactory,
    UserMediaRepository
} from '@arcaai/domains';
import {
    InternalServerErrorException,
    ArgumentInvalidException
} from '@arcaai/exceptions';
import { IUserMediaService } from './IUserMediaService';
import { CreateUserMediaRequest, UpdateUserMediaRequest } from './dto';
import {
    BaseService,
    FetchResponse,
    PaginatedQuery,
    withFormattedCountProps,
    withFormattedPaginatedProps
} from '../../../common';
import { IActiveUserContext } from '../../../interfaces';

// TODO: Implement this

@Injectable()
export class UserMediaService extends BaseService implements IUserMediaService {
    constructor(
        private readonly userMediaRepository: UserMediaRepository,
        protected override readonly eventEmitter: EventEmitter2,
        protected override readonly clsService: ClsService<IActiveUserContext>
    ) {
        super(eventEmitter, clsService, ResourceType.UserMedia);
    }

    async create(request: CreateUserMediaRequest): Promise<UserMediaEntity> {
        const newUserMedia = UserMediaFactory.CreateUserMedia({
            ...request,
            createdBy: this.requestUser?.id
        });

        const userMedia = await this.userMediaRepository.create(newUserMedia);

        if (!userMedia) {
            throw new InternalServerErrorException(
                `Failed to create UserMediaEntity: ${request}`
            );
        }

        this.broadcastSysEvent(SysEventType.ResourceCreated, {
            resourceId: userMedia.id,
            createdAt: userMedia.createdAt,
            data: userMedia.toObject() as object
        });
        return userMedia;
    }

    async fetchAll(
        props: PaginatedQuery
    ): Promise<FetchResponse<UserMediaEntity>> {
        const { limit, page, search } = props;
        const userMedias = await this.userMediaRepository.findAll(
            withFormattedPaginatedProps(props)
        );

        const count = await this.userMediaRepository.count(
            withFormattedCountProps(props)
        );

        this.broadcastSysEvent(SysEventType.ResourceViewed, {
            data: {
                items: userMedias.map(
                    (userMedia: UserMediaEntity) => userMedia.id
                )
            }
        });
        return new FetchResponse<UserMediaEntity>({
            data: userMedias,
            count,
            limit,
            page
        });
    }

    async fetchAllByTenantId(
        props: PaginatedQuery & { tenantId: string }
    ): Promise<FetchResponse<UserMediaEntity>> {
        throw new NotImplementedException();
    }

    async fetchAllCreatedByUser(
        props: PaginatedQuery & { userId: string }
    ): Promise<FetchResponse<UserMediaEntity>> {
        const { userId, limit, page, search } = props;
        const userMedias = await this.userMediaRepository.findAll({
            ...withFormattedPaginatedProps(props),
            where: {
                createdBy: userId
            }
        });
        const count = await this.userMediaRepository.count({
            ...withFormattedCountProps(props),
            where: {
                createdBy: userId
            }
        });

        this.broadcastSysEvent(SysEventType.ResourceViewed, {
            data: {
                createdBy: userId,
                items: userMedias.map(
                    (userMedia: UserMediaEntity) => userMedia.id
                )
            }
        });
        return new FetchResponse<UserMediaEntity>({
            data: userMedias,
            count,
            limit,
            page
        });
    }

    async fetchById(id: EntityId): Promise<UserMediaEntity> {
        const userMedia = await this.userMediaRepository.findById(id);

        this.broadcastSysEvent(SysEventType.ResourceViewed, {
            resourceId: userMedia.id,
            data: userMedia.toObject() as object
        });
        return userMedia;
    }

    async update(
        id: EntityId,
        request: UpdateUserMediaRequest
    ): Promise<UserMediaEntity> {
        const userMedia = await this.userMediaRepository.findById(id);

        const previousData = userMedia.toObject();
        this.updateEntity(userMedia, request);

        if (!userMedia.hasChanges) {
            throw new ArgumentInvalidException(`No changes to write to.`);
        }
        const updatedUserMedia = await this.userMediaRepository.update(
            id,
            userMedia
        );

        this.broadcastSysEvent(SysEventType.ResourceUpdated, {
            resourceId: updatedUserMedia.id,
            data: userMedia.changes,
            previousData
        });
        return updatedUserMedia;
    }

    async deleteById(id: EntityId): Promise<UserMediaEntity> {
        const userMedia = await this.userMediaRepository.softDelete(id);

        this.broadcastSysEvent(SysEventType.ResourceDeleted, {
            resourceId: userMedia.id,
            data: userMedia.toObject() as object
        });
        return userMedia;
    }
}
