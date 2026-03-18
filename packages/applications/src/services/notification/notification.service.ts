import { Injectable } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
    ResourceType,
    SysEventType,
    EntityId,
    NotificationEntity,
    NotificationFactory,
    NotificationRepository
} from '@arcaai/domains';
import {
    InternalServerErrorException,
    ArgumentInvalidException
} from '@arcaai/exceptions';
import { INotificationService } from './INotificationService';
import { CreateNotificationRequest, UpdateNotificationRequest } from './dto';
import {
    BaseService,
    FetchResponse,
    PaginatedQuery,
    withFormattedCountProps,
    withFormattedPaginatedProps
} from '../../common';
import { IActiveUserContext } from '../../interfaces';

// TODO: Implement this

@Injectable()
export class NotificationService
    extends BaseService
    implements INotificationService
{
    constructor(
        private readonly notificationRepository: NotificationRepository,
        protected override readonly eventEmitter: EventEmitter2,
        protected override readonly clsService: ClsService<IActiveUserContext>
    ) {
        super(eventEmitter, clsService, ResourceType.Notification);
    }

    async create(
        request: CreateNotificationRequest
    ): Promise<NotificationEntity> {
        const newNotification = NotificationFactory.CreateNotification({
            ...request,
            tenantId: request.tenantId,
            createdBy: this.requestUser?.id
        });

        const notification = await this.notificationRepository.create(
            newNotification
        );

        if (!notification) {
            throw new InternalServerErrorException(
                `Failed to create NotificationEntity: ${request}`
            );
        }

        this.broadcastSysEvent(SysEventType.ResourceCreated, {
            resourceId: notification.id,
            createdAt: notification.createdAt,
            data: notification.toObject() as object
        });
        return notification;
    }

    async fetchAll(
        props: PaginatedQuery
    ): Promise<FetchResponse<NotificationEntity>> {
        const { limit, page, search } = props;
        const notifications = await this.notificationRepository.findAll(
            withFormattedPaginatedProps(props)
        );

        const count = await this.notificationRepository.count(
            withFormattedCountProps(props)
        );

        this.broadcastSysEvent(SysEventType.ResourceViewed, {
            data: {
                items: notifications.map(
                    (notification: NotificationEntity) => notification.id
                )
            }
        });
        return new FetchResponse<NotificationEntity>({
            data: notifications,
            count,
            limit,
            page
        });
    }

    async fetchAllByTenantId(
        props: PaginatedQuery & { tenantId: string }
    ): Promise<FetchResponse<NotificationEntity>> {
        const { tenantId, limit, page, search } = props;
        const notifications = await this.notificationRepository.findAll({
            ...withFormattedPaginatedProps(props),
            where: {
                tenantId
            }
        });
        const count = await this.notificationRepository.count({
            ...withFormattedCountProps(props),
            where: {
                tenantId
            }
        });

        this.broadcastSysEvent(SysEventType.ResourceViewed, {
            data: {
                tenantId,
                items: notifications.map(
                    (notification: NotificationEntity) => notification.id
                )
            }
        });
        return new FetchResponse<NotificationEntity>({
            data: notifications,
            count,
            limit,
            page
        });
    }

    async fetchAllCreatedByUser(
        props: PaginatedQuery & { userId: string }
    ): Promise<FetchResponse<NotificationEntity>> {
        const { userId, limit, page, search } = props;
        const notifications = await this.notificationRepository.findAll({
            ...withFormattedPaginatedProps(props),
            where: {
                createdBy: userId
            }
        });
        const count = await this.notificationRepository.count({
            ...withFormattedCountProps(props),
            where: {
                createdBy: userId
            }
        });

        this.broadcastSysEvent(SysEventType.ResourceViewed, {
            data: {
                createdBy: userId,
                items: notifications.map(
                    (notification: NotificationEntity) => notification.id
                )
            }
        });
        return new FetchResponse<NotificationEntity>({
            data: notifications,
            count,
            limit,
            page
        });
    }

    async fetchById(id: EntityId): Promise<NotificationEntity> {
        const notification = await this.notificationRepository.findById(id);

        this.broadcastSysEvent(SysEventType.ResourceViewed, {
            resourceId: notification.id,
            data: notification.toObject() as object
        });
        return notification;
    }

    async update(
        id: EntityId,
        request: UpdateNotificationRequest
    ): Promise<NotificationEntity> {
        const notification = await this.notificationRepository.findById(id);

        const previousData = notification.toObject();
        this.updateEntity(notification, request);

        if (!notification.hasChanges) {
            throw new ArgumentInvalidException(`No changes to write to.`);
        }
        const updatedNotification = await this.notificationRepository.update(
            id,
            notification
        );

        this.broadcastSysEvent(SysEventType.ResourceUpdated, {
            resourceId: updatedNotification.id,
            data: notification.changes,
            previousData
        });
        return updatedNotification;
    }

    async deleteById(id: EntityId): Promise<NotificationEntity> {
        const notification = await this.notificationRepository.softDelete(id);

        this.broadcastSysEvent(SysEventType.ResourceDeleted, {
            resourceId: notification.id,
            data: notification.toObject() as object
        });
        return notification;
    }
}
