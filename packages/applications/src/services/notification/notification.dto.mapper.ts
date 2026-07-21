import { AutoClassMapper, NotificationEntity } from '@arcaai/domains';
import { NotificationResponse, PaginatedNotificationResponse } from './dto';
import { FetchResponse } from '../../common';

export class NotificationDtoMapper {
  static ToResponse(entity: NotificationEntity): NotificationResponse {
    return AutoClassMapper(entity, NotificationResponse);
  }

  static ToPaginatedResponse({ page, limit, count, data }: FetchResponse<NotificationEntity>): PaginatedNotificationResponse {
    return new PaginatedNotificationResponse({
      page,
      limit,
      count,
      data: data.map((notification) => this.ToResponse(notification)),
    });
  }
}
