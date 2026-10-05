import { BadRequestException, Controller, Get, Inject, Param, ParseIntPipe, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import {
  ActivityRunRecordResponse,
  ConsultationActivityPageResponse,
  ConsultationActivityQuery,
  IConsultationHistoryServiceToken,
  ItemRunsQuery,
  ItemVersionDetailResponse,
  ItemVersionDiffQuery,
  ItemVersionSummaryResponse,
  VersionDiffResponse,
  type IConsultationHistoryService,
} from '@arcaai/applications';
import { CanRead, ForbidApiKey, RequiredSvcScopes } from '../../decorators';

const ADMIN = { admin: true } as const;

function assertVersion(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 1) throw new BadRequestException(`${name} must be a positive integer`);
}

/**
 * The admin read plane over a consultation's history: the oldest-first activity feed, an item's
 * version history, one decrypted version, a diff and the AI runs behind a version.
 *
 * Every route acts on the caller's CLS tenant; a consultation or item of another tenant is 404,
 * never 403. Reads are audited — the content is PHI.
 */
@ApiBearerAuth()
@ApiTags('admin-consultations')
@ForbidApiKey()
@RequiredSvcScopes('svc:admin:consultation-admin:manage')
@Controller('admin/consultations')
@CanRead('Consultation')
export class AdminConsultationHistoryController {
  constructor(@Inject(IConsultationHistoryServiceToken) private readonly history: IConsultationHistoryService) {}

  // AUTH-NOTE: the class decorator UNDERSTATES this route's gate — ConsultationHistoryService admits
  // only a SUPER_ADMIN, a TENANT_ADMIN of the working tenant or a service account on the admin plane
  // (assertPromptInspectorAccess, 403 `CONSULTATION_HISTORY_FORBIDDEN`; a doctor holding
  // read:Consultation is refused). Row-independent, so it runs before the consultation is resolved;
  // another tenant's consultation is still 404 for an admin. The same holds for every handler below.
  @Get(':id/activity')
  @ApiOperation({
    summary: 'Read a consultation`s activity feed',
    description:
      'The consultation`s items, feedback and lifecycle moments as one oldest-first, keyset-paged series, with run summaries and first-page aggregates. ' +
      'Consecutive transcript segments collapse into runs unless `grouping=none`. Audited.',
  })
  @ApiParam({ name: 'id', description: 'Consultation ID' })
  @ApiResponse({ status: 200, type: ConsultationActivityPageResponse })
  @ApiResponse({ status: 400, description: 'Invalid query or cursor.' })
  @ApiResponse({ status: 403, description: 'Not a super administrator or a tenant administrator of this tenant (`CONSULTATION_HISTORY_FORBIDDEN`).' })
  @ApiResponse({ status: 404, description: 'No such consultation in this tenant.' })
  async getActivity(@Param('id') id: string, @Query() query: ConsultationActivityQuery): Promise<ConsultationActivityPageResponse> {
    return (await this.history.getActivity(id, query, ADMIN)) as ConsultationActivityPageResponse;
  }

  // AUTH-NOTE: see getActivity — the service gate is the real one.
  @Get(':id/items/:itemId/versions')
  @ApiOperation({ summary: 'List an item`s versions', description: 'Newest first, metadata only — no content. Audited.' })
  @ApiParam({ name: 'id', description: 'Consultation ID' })
  @ApiParam({ name: 'itemId', description: 'Context item ID' })
  @ApiResponse({ status: 200, type: ItemVersionSummaryResponse, isArray: true })
  @ApiResponse({ status: 403, description: 'Not a super administrator or a tenant administrator of this tenant (`CONSULTATION_HISTORY_FORBIDDEN`).' })
  @ApiResponse({ status: 404, description: 'No such consultation or item in this tenant.' })
  async listVersions(@Param('id') id: string, @Param('itemId') itemId: string): Promise<ItemVersionSummaryResponse[]> {
    return (await this.history.listItemVersions(id, itemId, ADMIN)) as ItemVersionSummaryResponse[];
  }

  // AUTH-NOTE: see getActivity — the service gate is the real one.
  @Get(':id/items/:itemId/versions/:n')
  @ApiOperation({ summary: 'Read one version of an item, decrypted', description: 'The version`s content, decrypted from Vault-Transit ciphertext. Audited.' })
  @ApiParam({ name: 'id', description: 'Consultation ID' })
  @ApiParam({ name: 'itemId', description: 'Context item ID' })
  @ApiParam({ name: 'n', description: 'Version number', type: Number })
  @ApiResponse({ status: 200, type: ItemVersionDetailResponse })
  @ApiResponse({ status: 400, description: 'Invalid version number.' })
  @ApiResponse({ status: 403, description: 'Not a super administrator or a tenant administrator of this tenant (`CONSULTATION_HISTORY_FORBIDDEN`).' })
  @ApiResponse({ status: 404, description: 'No such consultation, item or version in this tenant.' })
  async getVersion(
    @Param('id') id: string,
    @Param('itemId') itemId: string,
    @Param('n', ParseIntPipe) n: number,
  ): Promise<ItemVersionDetailResponse> {
    assertVersion(n, 'n');
    return (await this.history.getItemVersion(id, itemId, n, ADMIN)) as ItemVersionDetailResponse;
  }

  // AUTH-NOTE: see getActivity — the service gate is the real one.
  @Get(':id/items/:itemId/versions/:n/diff')
  @ApiOperation({ summary: 'Diff two versions of an item', description: 'Version `n` (`to`) against `against` (`from`), both decrypted. Audited.' })
  @ApiParam({ name: 'id', description: 'Consultation ID' })
  @ApiParam({ name: 'itemId', description: 'Context item ID' })
  @ApiParam({ name: 'n', description: 'Version number (the `to` side)', type: Number })
  @ApiResponse({ status: 200, type: VersionDiffResponse })
  @ApiResponse({ status: 400, description: 'Invalid version number or `against`.' })
  @ApiResponse({ status: 403, description: 'Not a super administrator or a tenant administrator of this tenant (`CONSULTATION_HISTORY_FORBIDDEN`).' })
  @ApiResponse({ status: 404, description: 'No such consultation, item or version in this tenant.' })
  async diff(
    @Param('id') id: string,
    @Param('itemId') itemId: string,
    @Param('n', ParseIntPipe) n: number,
    @Query() query: ItemVersionDiffQuery,
  ): Promise<VersionDiffResponse> {
    assertVersion(n, 'n');
    return this.history.diffItemVersions(id, itemId, n, query.against, ADMIN);
  }

  // AUTH-NOTE: see getActivity — the service gate is the real one.
  @Get(':id/items/:itemId/runs')
  @ApiOperation({ summary: 'List the AI runs behind an item version', description: 'The run that produced `version` (the current one when absent); empty when none is recorded. Audited.' })
  @ApiParam({ name: 'id', description: 'Consultation ID' })
  @ApiParam({ name: 'itemId', description: 'Context item ID' })
  @ApiResponse({ status: 200, type: ActivityRunRecordResponse, isArray: true })
  @ApiResponse({ status: 400, description: 'Invalid `version`.' })
  @ApiResponse({ status: 403, description: 'Not a super administrator or a tenant administrator of this tenant (`CONSULTATION_HISTORY_FORBIDDEN`).' })
  @ApiResponse({ status: 404, description: 'No such consultation or item in this tenant.' })
  async listRuns(
    @Param('id') id: string,
    @Param('itemId') itemId: string,
    @Query() query: ItemRunsQuery,
  ): Promise<ActivityRunRecordResponse[]> {
    return (await this.history.listItemRuns(id, itemId, query.version, ADMIN)) as ActivityRunRecordResponse[];
  }
}
