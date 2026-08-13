import {
  AcknowledgeChangelogRequest,
  ChangelogEntryResponse,
  IChangelogService,
  ListChangelogQuery,
  PaginatedChangelogEntryResponse,
} from '@arcaai/applications';
import { Body, Controller, Get, HttpCode, HttpStatus, Inject, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Authorize } from '../../decorators';

/**
 * Reader surface for the curated release notes (/, frozen
 * contract `/changelog/*`).
 *
 * Open to ANY authenticated user — `@Authorize()` with no ability, exactly
 * like `/user/me/preferences`. Visibility is a property of the ROW (its
 * `audience`), not of the route, so the filtering lives in `ChangelogService`
 * and cannot be expressed by a permission decorator.
 */
@ApiBearerAuth()
@ApiTags('changelog')
@Controller('changelog')
@Authorize()
export class ChangelogController {
  constructor(
    @Inject(IChangelogService)
    private readonly changelogService: IChangelogService,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'List the release notes visible to the caller',
    description: 'Audience-filtered, newest published first. Global admins additionally see DRAFT entries.',
  })
  @ApiResponse({ status: 200, type: PaginatedChangelogEntryResponse })
  async list(@Query() query: ListChangelogQuery): Promise<PaginatedChangelogEntryResponse> {
    return this.changelogService.list(query);
  }

  @Get('unseen')
  @ApiOperation({
    summary: "Entries driving the one-time What's New dialog",
    description:
      'PUBLISHED entries matching the caller audience with no acknowledgement row, newest first, capped at 3. ' +
      'Returns an empty array — never an error — when there is nothing to show, and returns EMPTY while impersonating.',
  })
  @ApiResponse({ status: 200, type: [ChangelogEntryResponse] })
  async listUnseen(): Promise<ChangelogEntryResponse[]> {
    return this.changelogService.listUnseen();
  }

  @Post('acknowledge')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Mark entries as seen for the current user',
    description: 'Idempotent — acknowledging an already-acknowledged entry is a no-op, not a conflict.',
  })
  @ApiResponse({ status: 204, description: 'Acknowledged' })
  async acknowledge(@Body() request: AcknowledgeChangelogRequest): Promise<void> {
    await this.changelogService.acknowledge(request.entryIds);
  }
}
