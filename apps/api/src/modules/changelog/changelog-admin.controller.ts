import { ChangelogEntryResponse, CreateChangelogEntryRequest, IChangelogService, UpdateChangelogEntryRequest } from '@arcaai/applications';
import { Body, Controller, Get, Inject, Param, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { CanManage, ExpectedVersion, RequiresIfMatch, ForbidApiKey, RequiredSvcScopes } from '../../decorators';

/**
 * Authoring surface for the curated release notes (frozen
 * contract `/admin/changelog/*`).
 *
 * AUTH-NOTE: the class-level `@CanManage('ChangelogEntry')` UNDERSTATES the
 * real gate. Every route here is SUPER_ADMIN-only, enforced imperatively in
 * `ChangelogService.assertSuperAdmin()` — the decorators cannot express
 * "super admin only" (`05-nestjs-api.md` §Imperative Privilege Checks), and a
 * release note is a platform-wide broadcast that a tenant admin must never
 * author or publish. That is a 403 privilege boundary, NOT the 404-over-403
 * cross-tenant posture. The decorator is still required so the deny-by-default
 * boot audit stays green.
 */
@ApiBearerAuth()
@ApiTags('admin-changelog')
@ForbidApiKey()
@RequiredSvcScopes('svc:admin:changelog:manage')
@Controller('admin/changelog')
@CanManage('ChangelogEntry')
export class ChangelogAdminController {
  constructor(
    @Inject(IChangelogService)
    private readonly changelogService: IChangelogService,
  ) {}

  // AUTH-NOTE: SUPER_ADMIN-only — enforced in ChangelogService, see class doc.
  @Get(':id')
  @ApiOperation({
    summary: 'Read a release note for editing (DRAFT included)',
    description:
      'The authoring read. Answers a strong `ETag` carrying `_version`, which `PATCH` and `publish` both require as ' +
      '`If-Match` — this route is how the client learns it. The reader plane (`GET /changelog`) is unaffected and ' +
      'still serves PUBLISHED entries only.',
  })
  @ApiParam({ name: 'id', description: 'Changelog entry id' })
  @ApiResponse({ status: 200, type: ChangelogEntryResponse })
  @ApiResponse({ status: 403, description: 'Not a super admin.' })
  @ApiResponse({ status: 404, description: 'No such entry.' })
  async get(@Param('id') id: string): Promise<ChangelogEntryResponse> {
    return this.changelogService.get(id);
  }

  // AUTH-NOTE: SUPER_ADMIN-only — enforced in ChangelogService, see class doc.
  @Post()
  @ApiOperation({
    summary: 'Create a release note (always DRAFT)',
    description: 'CI creates DRAFTs by this route. Nothing here makes an entry visible — publishing is a separate human action.',
  })
  @ApiResponse({ status: 201, type: ChangelogEntryResponse })
  @ApiResponse({ status: 403, description: 'Not a super admin.' })
  async create(@Body() request: CreateChangelogEntryRequest): Promise<ChangelogEntryResponse> {
    return this.changelogService.create(request);
  }

  // AUTH-NOTE: SUPER_ADMIN-only — enforced in ChangelogService, see class doc.
  @Patch(':id')
  @RequiresIfMatch()
  @ApiOperation({
    summary: 'Edit a release note (If-Match OCC)',
    description: 'Sparse patch. `If-Match` (RFC 7232) is REQUIRED and CASes against `_version`; drift → 412, missing → 428.',
  })
  @ApiParam({ name: 'id', description: 'Changelog entry id' })
  @ApiHeader({ name: 'If-Match', description: 'Strong validator carrying the version the client read (e.g. `"1"`).', required: true, example: '"1"' })
  @ApiResponse({ status: 200, type: ChangelogEntryResponse })
  @ApiResponse({ status: 403, description: 'Not a super admin.' })
  @ApiResponse({ status: 412, description: 'Version drift — re-fetch and retry.' })
  @ApiResponse({ status: 428, description: 'If-Match header is required.' })
  async update(
    @Param('id') id: string,
    @Body() request: UpdateChangelogEntryRequest,
    @ExpectedVersion() expectedFromHeader: number | undefined,
  ): Promise<ChangelogEntryResponse> {
    const dto = expectedFromHeader !== undefined ? { ...request, expectedVersion: expectedFromHeader } : request;
    return this.changelogService.update(id, dto);
  }

  // AUTH-NOTE: SUPER_ADMIN-only — enforced in ChangelogService, see class doc.
  @Post(':id/publish')
  @RequiresIfMatch()
  @ApiOperation({
    summary: 'Publish a release note',
    description:
      'The ONLY path from DRAFT to PUBLISHED, and always a human action — CI never publishes. Publishing an ' +
      'already-published entry is rejected with 409.',
  })
  @ApiParam({ name: 'id', description: 'Changelog entry id' })
  @ApiHeader({ name: 'If-Match', description: 'Strong validator carrying the version the client read (e.g. `"1"`).', required: true, example: '"1"' })
  @ApiResponse({ status: 200, type: ChangelogEntryResponse })
  @ApiResponse({ status: 403, description: 'Not a super admin.' })
  @ApiResponse({ status: 409, description: 'Already published.' })
  @ApiResponse({ status: 412, description: 'Version drift — re-fetch and retry.' })
  @ApiResponse({ status: 428, description: 'If-Match header is required.' })
  async publish(@Param('id') id: string, @ExpectedVersion() expectedFromHeader: number | undefined): Promise<ChangelogEntryResponse> {
    return this.changelogService.publish(id, expectedFromHeader);
  }
}
