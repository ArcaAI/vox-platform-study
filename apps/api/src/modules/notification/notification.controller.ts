import {
  INotificationService,
  NotificationDtoMapper,
  NotificationResponse,
  PaginatedNotificationResponse,
  PaginatedQuery,
  UpdateNotificationRequest,
} from '@arcaai/applications';
import { Body, Controller, Delete, Get, Inject, Param, Patch, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { CanManage, ForbidApiKey } from '../../decorators';

/**
 * NotificationController — admin read/update/delete surface
 * over the pre-existing `NotificationService`, mounted at `/admin/notifications`.
 *
 * Deliberately NO create route: notifications are emitted by the platform
 * (sys-event fan-out / dispatch pipeline), not authored by admins. Update is a
 * plain sparse patch (the service uses a non-CAS write — no If-Match).
 * Tenancy is service-enforced (CLS pin for lists, load-then-assert → 404 on
 * cross-tenant ids, SUPER_ADMIN bypass). CASL: class-level `manage:Notification`.
 */
@ApiBearerAuth()
@ApiTags('admin-notifications')
@ForbidApiKey()
@Controller('admin/notifications')
@CanManage('Notification')
export class NotificationController {
  constructor(
    @Inject(INotificationService)
    private readonly notificationService: INotificationService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'List notifications (tenant-scoped; SUPER_ADMIN sees all, or targets one via ?tenantId=)' })
  @ApiQuery({ name: 'tenantId', required: false, description: 'Cross-tenant target (SUPER_ADMIN only — others 404).' })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiResponse({ status: 200, type: PaginatedNotificationResponse })
  async fetchAll(@Query() query: PaginatedQuery & { tenantId?: string }): Promise<PaginatedNotificationResponse> {
    const { tenantId, ...paginated } = query;
    const props = { ...paginated, sort: query.sort || 'createdAt:desc' };
    const result = tenantId
      ? await this.notificationService.fetchAllByTenantId({ ...props, tenantId })
      : await this.notificationService.fetchAll(props);
    return NotificationDtoMapper.ToPaginatedResponse(result);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get one notification' })
  @ApiParam({ name: 'id', description: 'Notification id' })
  @ApiResponse({ status: 200, type: NotificationResponse })
  @ApiResponse({ status: 404, description: 'Notification not found (or cross-tenant).' })
  async fetchById(@Param('id') id: string): Promise<NotificationResponse> {
    const result = await this.notificationService.fetchById(id);
    return NotificationDtoMapper.ToResponse(result);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update a notification (sparse patch, e.g. mark read)' })
  @ApiParam({ name: 'id', description: 'Notification id' })
  @ApiResponse({ status: 200, type: NotificationResponse })
  @ApiResponse({ status: 404, description: 'Notification not found (or cross-tenant).' })
  async update(@Param('id') id: string, @Body() request: UpdateNotificationRequest): Promise<NotificationResponse> {
    const result = await this.notificationService.update(id, request);
    return NotificationDtoMapper.ToResponse(result);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Soft-delete a notification' })
  @ApiParam({ name: 'id', description: 'Notification id' })
  @ApiResponse({ status: 200, type: NotificationResponse })
  @ApiResponse({ status: 404, description: 'Notification not found (or cross-tenant).' })
  async delete(@Param('id') id: string): Promise<NotificationResponse> {
    const result = await this.notificationService.deleteById(id);
    return NotificationDtoMapper.ToResponse(result);
  }
}
