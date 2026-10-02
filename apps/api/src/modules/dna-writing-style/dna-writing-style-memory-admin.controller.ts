import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import {
  DnaMemoryAdminService,
  DnaMemoryDoctorSummaryResponse,
  DnaMemorySamplePageResponse,
  DnaRegenRunResponse,
  DnaRegenScheduleResponse,
  ListDnaMemoryQuery,
  UpdateDnaRegenScheduleRequest,
} from '@arcaai/applications';
import { Authorize, ForbidApiKey, RequiredSvcScopes } from '../../decorators';

/**
 * TASK-1034 — DNA writing-style MEMORY and the weekly regeneration SCHEDULE, for a tenant admin.
 *
 * Same prefix, class gates and scope as `DnaWritingStyleAdminController`; a separate controller so
 * the memory/schedule surface stays one file. Every route acts on the caller's CLS tenant (a super
 * admin's working tenant); a clinician or sample of another tenant is 404, never 403. Literal
 * `memory` / `schedule` segments never collide with the `:reportId` routes (none is a one-segment
 * GET).
 */
@ApiBearerAuth()
@ApiTags('admin-dna-writing-styles')
@ForbidApiKey()
@RequiredSvcScopes('svc:admin:dna-writing-style:manage')
@Controller('admin/dna-writing-styles')
@Authorize(['manage', 'DnaWritingStyleReport'])
export class DnaWritingStyleMemoryAdminController {
  constructor(private readonly memoryAdmin: DnaMemoryAdminService) {}

  @Get('memory/summary')
  @Authorize(['read', 'DnaWritingStyleReport'])
  @ApiOperation({
    summary: 'DNA writing-style memory per clinician',
    description:
      'One row per clinician of this tenant who has DNA memory or a DNA report: sample counts (total, not yet consumed, ' +
      'by source EDIT / SIGNOFF / INGEST), the newest sample, the latest report, and whether DNA is effectively on for them.',
  })
  @ApiResponse({ status: 200, type: [DnaMemoryDoctorSummaryResponse] })
  @ApiResponse({ status: 400, description: 'No tenant in context (a super admin must select a working tenant).' })
  @ApiResponse({ status: 403, description: 'The caller may not read DNA writing-style reports.' })
  async getMemorySummary(): Promise<DnaMemoryDoctorSummaryResponse[]> {
    return this.memoryAdmin.getMemorySummary();
  }

  @Get('memory')
  @Authorize(['read', 'DnaWritingStyleReport'])
  @ApiOperation({
    summary: 'List DNA writing-style memory samples',
    description:
      'Newest first, filterable by clinician, source and consumed state. Never returns sample text: each row carries a ' +
      'PHI-redacted preview of at most 200 characters (empty when redaction is unavailable).',
  })
  @ApiResponse({ status: 200, type: DnaMemorySamplePageResponse })
  @ApiResponse({ status: 400, description: 'Invalid query, or no tenant in context.' })
  @ApiResponse({ status: 404, description: 'The clinician is not a member of this tenant.' })
  async listMemory(@Query() query: ListDnaMemoryQuery): Promise<DnaMemorySamplePageResponse> {
    return this.memoryAdmin.listMemory(query);
  }

  @Delete('memory/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Delete a DNA writing-style memory sample',
    description: 'Soft delete: the sample stops counting as feedback and is never read into a future profile.',
  })
  @ApiParam({ name: 'id', description: 'Memory sample id', type: String })
  @ApiResponse({ status: 204, description: 'Deleted.' })
  @ApiResponse({ status: 404, description: 'No such sample in this tenant.' })
  async deleteMemory(@Param('id') id: string): Promise<void> {
    await this.memoryAdmin.deleteMemory(id);
  }

  @Get('schedule')
  @Authorize(['read', 'DnaWritingStyleReport'])
  @ApiOperation({
    summary: 'Weekly DNA regeneration schedule',
    description:
      'The effective schedule for this tenant (its own settings, else the platform default), the time zone the cron is ' +
      'read in, the next run, and the result of the last run.',
  })
  @ApiResponse({ status: 200, type: DnaRegenScheduleResponse })
  @ApiResponse({ status: 400, description: 'No tenant in context.' })
  async getSchedule(): Promise<DnaRegenScheduleResponse> {
    return this.memoryAdmin.getSchedule();
  }

  @Put('schedule')
  @ApiOperation({
    summary: 'Update the weekly DNA regeneration schedule',
    description:
      'Writes the supplied fields as this tenant`s own `dna-regen.*` settings (omitted fields are left as they are). ' +
      'The values are validated by the settings registry.',
  })
  @ApiResponse({ status: 200, type: DnaRegenScheduleResponse })
  @ApiResponse({ status: 400, description: 'Invalid value (for example a cron expression that does not parse), or no tenant in context.' })
  @ApiResponse({ status: 412, description: 'The setting changed concurrently; read and retry.' })
  async updateSchedule(@Body() dto: UpdateDnaRegenScheduleRequest): Promise<DnaRegenScheduleResponse> {
    return this.memoryAdmin.updateSchedule(dto);
  }

  @Post('schedule/run')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Run the DNA regeneration now (this tenant)',
    description:
      'Evaluates every clinician of this tenant exactly as the weekly run does and queues those with enough new memory. ' +
      'Idempotent per ISO week: a clinician already queued this week is not queued again.',
  })
  @ApiResponse({ status: 200, type: DnaRegenRunResponse })
  @ApiResponse({ status: 400, description: 'No tenant in context.' })
  async runSchedule(): Promise<DnaRegenRunResponse> {
    return this.memoryAdmin.runNow();
  }
}
