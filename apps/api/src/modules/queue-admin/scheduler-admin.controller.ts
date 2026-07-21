import { Body, Controller, Get, HttpCode, HttpStatus, Inject, Param, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { ISchedulerAdminService } from '@arcaai/applications';
import type { SchedulerInfo } from '@arcaai/domains';
import { Authorize } from '../../decorators';
import { SchedulerInfoResponse, SuccessResponse, ToggleSchedulerRequest, UpdateSchedulerCronRequest } from './dto';

/**
 * Guarded admin surface over the existing
 * scheduler-admin application layer (`@nestjs/schedule` SchedulerRegistry +
 * dynamic, GlobalSetting-backed cron). Reachable at `/api/v1/admin/schedulers`.
 *
 * Access: gated to GLOBAL_ADMIN via `@Authorize(['manage','all'])` — schedulers
 * are platform-wide infrastructure, identical posture to {@link QueueAdminController}.
 *
 * Thin delegate to `ISchedulerAdminService`. Only `dynamic` schedulers can be
 * edited/toggled; the service throws `BadRequestException` for static ones.
 */
@ApiTags('admin-schedulers')
@ApiBearerAuth()
@Authorize(['manage', 'all'])
@Controller('admin/schedulers')
export class SchedulerAdminController {
  constructor(@Inject(ISchedulerAdminService) private readonly schedulerService: ISchedulerAdminService) {}

  @Get()
  @ApiOperation({ summary: 'List all schedulers (static @Cron + dynamic) with cron/interval/run metadata.' })
  @ApiOkResponse({ type: [SchedulerInfoResponse] })
  listSchedulers(): SchedulerInfo[] {
    return this.schedulerService.listSchedulers();
  }

  @Post(':name/pause')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Pause (stop) a running cron scheduler.' })
  @ApiParam({ name: 'name', description: 'Scheduler name.' })
  @ApiOkResponse({ type: SuccessResponse })
  pauseScheduler(@Param('name') name: string): SuccessResponse {
    this.schedulerService.pauseScheduler(name);
    return { success: true };
  }

  @Post(':name/resume')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Resume (start) a paused cron scheduler.' })
  @ApiParam({ name: 'name', description: 'Scheduler name.' })
  @ApiOkResponse({ type: SuccessResponse })
  resumeScheduler(@Param('name') name: string): SuccessResponse {
    this.schedulerService.resumeScheduler(name);
    return { success: true };
  }

  @Patch(':name/cron')
  @ApiOperation({ summary: 'Update a dynamic scheduler cron expression (static schedulers are rejected).' })
  @ApiParam({ name: 'name', description: 'Scheduler name.' })
  @ApiOkResponse({ type: SchedulerInfoResponse })
  updateCron(@Param('name') name: string, @Body() body: UpdateSchedulerCronRequest): Promise<SchedulerInfo> {
    return this.schedulerService.updateSchedulerCron(name, body.cronExpression);
  }

  @Patch(':name/toggle')
  @ApiOperation({ summary: 'Enable/disable a dynamic scheduler (static schedulers are rejected).' })
  @ApiParam({ name: 'name', description: 'Scheduler name.' })
  @ApiOkResponse({ type: SchedulerInfoResponse })
  toggleScheduler(@Param('name') name: string, @Body() body: ToggleSchedulerRequest): Promise<SchedulerInfo> {
    return this.schedulerService.toggleScheduler(name, body.enabled);
  }
}
