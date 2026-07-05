import {
  IDnaWritingStyleService,
  DnaReportResponse,
  DnaVersionResponse,
  DnaDashboardResponse,
  GenerateDnaReportRequest,
  UpdateDnaReportRequest,
  PaginatedQuery,
  HttpMethod,
  type DnaJobResponse,
} from '@arcaai/applications';
import { DnaJobResponseDto, DnaJobStatusResponseDto } from './dna-writing-style.dto';
import { PaginatedDnaReportResponse } from './dto';
import { JobQueue } from '@arcaai/domains';
import { Controller, Body, Param, Inject, Get, Query, Sse, NotFoundException, type MessageEvent } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiHeader, ApiParam, ApiQuery, ApiResponse, ApiOperation } from '@nestjs/swagger';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { Observable } from 'rxjs';
// TASK-326 X7 / D-2 — `@RequiresIfMatch()` + `@ExpectedVersion()` gate the
// OCC-enforced PATCH route below (mirrors PromptManagementController).
import { ApiEndpoint, Authorize, RequiresIfMatch, ExpectedVersion } from '../../decorators';
import { StreamScope } from '../auth/decorators/stream-scope.decorator';
import { getDnaJobStatus, streamDnaJobStatus } from './dna-writing-style-job-stream';

@ApiBearerAuth()
@ApiTags('admin-dna-writing-styles')
@Controller('admin/dna-writing-styles')
// TASK-326 X7 — narrowed from `manage:all` (global-admin-only) to
// `manage:DnaWritingStyleReport` so a TENANT_ADMIN can administer their own
// tenant's writing-style reports (mirrors the TASK-298 AudioPipelineController
// narrowing). Tenant isolation is still enforced in the service layer
// (`assertReportInScope`) and `DnaWritingStyleReport` is tenant-scoped, so this
// only widens WHO may call — never the data each caller may see. The
// `tenant-full-access` policy grants the matching ability (seed 01-policy.ts).
@Authorize(['manage', 'DnaWritingStyleReport'])
export class DnaWritingStyleAdminController {
  constructor(
    @Inject(IDnaWritingStyleService)
    private readonly dnaService: IDnaWritingStyleService,
    @InjectQueue(JobQueue.GenerateDnaReport)
    private readonly dnaQueue: Queue,
  ) {}

  // TASK-328 A5 — DNA aggregate dashboard. Declared before the param-less list
  // route's siblings; `dashboard` is a literal segment so it never collides
  // with `:reportId`-style routes. Tenant scoping is enforced in the service:
  // a global admin may target a tenant via `?tenantId=` (or omit it for an
  // all-tenants roll-up); a tenant admin is pinned to their CLS tenant and any
  // supplied `tenantId` is ignored.
  @Get('dashboard')
  @ApiOperation({ summary: 'DNA aggregate dashboard (users with a style, avg versions, recent usage activity)' })
  @ApiQuery({
    name: 'tenantId',
    required: false,
    type: String,
    description: 'Global-admin only: scope the aggregate to a tenant. Ignored for tenant admins.',
  })
  @ApiResponse({ status: 200, description: 'DNA aggregate dashboard', type: DnaDashboardResponse })
  async getDashboard(@Query('tenantId') tenantId?: string): Promise<DnaDashboardResponse> {
    return this.dnaService.getDashboard(tenantId);
  }

  @ApiEndpoint({
    returnedModel: DnaReportResponse,
    multi: true,
  })
  @ApiQuery({
    name: 'tenantId',
    required: false,
    type: String,
    description: 'Global-admin only: scope the list to a tenant. Ignored for tenant admins.',
  })
  @ApiQuery({ name: 'includeDisabled', required: false, type: Boolean, description: 'Include disabled reports in results' })
  // TASK-388 #13 — cross-user read: narrow the list to a single doctor's
  // reports. The service already PHI-gates results to the caller's tenant.
  @ApiQuery({ name: 'doctorId', required: false, type: String, description: 'Narrow to one doctor (cross-user admin read; tenant-scoped)' })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  async list(
    @Query() queryParams: PaginatedQuery & { tenantId?: string; includeDisabled?: string; doctorId?: string },
  ): Promise<PaginatedDnaReportResponse> {
    // TASK-331 doc-02 F6 — pagination is pushed down to the repository
    // (`findPaginated` → `db.findMany` + `db.count`) instead of materializing
    // the full tenant result set and slicing it in memory. A global admin may
    // scope to a tenant via `?tenantId=`; a tenant admin is pinned to their CLS
    // tenant and the supplied value is ignored in the service.
    return this.dnaService.listReportsPaginated({
      tenantId: queryParams?.tenantId,
      includeDisabled: queryParams?.includeDisabled === 'true',
      // TASK-388 #13 — cross-user read filter.
      doctorId: queryParams?.doctorId,
      page: Number(queryParams?.page) || 1,
      limit: Number(queryParams?.limit) || 10,
    });
  }

  // TASK-388 #13 — admin read of a specific doctor's latest DNA writing-style
  // report (cross-user). Delegates to the PHI-gated service method, which
  // `assertUserBelongsToTenant` before any repository read — even GLOBAL_ADMIN
  // cannot cross tenants on this PHI-derived artifact. Declared before the
  // `:reportId`-family routes; `doctor` is a literal segment so it never
  // collides with `jobs/:jobId`.
  @Get('doctor/:doctorId')
  @ApiOperation({
    summary: 'Latest DNA writing-style report for a doctor (admin cross-user, tenant-scoped PHI-gated)',
  })
  @ApiParam({ name: 'doctorId', description: 'Target doctor ID', type: String })
  @ApiResponse({ status: 200, description: 'Latest DNA report for the doctor', type: DnaReportResponse })
  @ApiResponse({ status: 404, description: 'No report found for the doctor (or doctor is not in the caller tenant)' })
  async getReportForDoctor(@Param('doctorId') doctorId: string): Promise<DnaReportResponse> {
    const report = await this.dnaService.getDnaReport(doctorId);
    if (!report) throw new NotFoundException(`No DNA report found for doctor ${doctorId}`);
    return report;
  }

  @ApiEndpoint({
    returnedModel: DnaReportResponse,
    method: HttpMethod.PATCH,
    path: ':reportId',
    by: ['reportId'],
  })
  @RequiresIfMatch()
  @ApiOperation({
    summary: 'Update a DNA writing-style report (admin)',
    description:
      'Updates one DNA writing-style report row. Optimistic concurrency is ' +
      'enforced (TASK-326 X7 / D-2): the `If-Match` header (RFC 7232) is REQUIRED ' +
      "and the server runs a Compare-And-Set against the row's `_version` column " +
      '(DISTINCT from `currentVersionNumber`, the DnaVersion history counter). When ' +
      'the header is present, its value overrides the body-field `expectedVersion`. ' +
      'On version drift the response is `412 Precondition Failed`; a missing header ' +
      'is `428 Precondition Required`.',
  })
  @ApiHeader({
    name: 'If-Match',
    description: 'RFC 7232 strong validator carrying the row version the client read (e.g. `"1"`).',
    required: true,
    example: '"1"',
  })
  @ApiParam({ name: 'reportId', description: 'Report ID', type: String })
  @ApiResponse({ status: 404, description: 'Report not found' })
  @ApiResponse({ status: 412, description: 'Optimistic concurrency conflict — re-fetch and try again with the new version.' })
  @ApiResponse({ status: 428, description: 'If-Match header is required for this operation.' })
  async update(
    @Param('reportId') reportId: string,
    @Body() dto: UpdateDnaReportRequest,
    @ExpectedVersion() expectedFromHeader: number | undefined,
  ): Promise<DnaReportResponse> {
    // TASK-326 X7 / D-2 — header takes precedence over body when both are
    // present. On this `@RequiresIfMatch()` route the param decorator already
    // fired 428 if the header was missing. The admin ownership escape
    // (`bypassOwnershipCheck`) is preserved.
    const effectiveDto: UpdateDnaReportRequest = expectedFromHeader !== undefined ? { ...dto, expectedVersion: expectedFromHeader } : dto;
    return this.dnaService.updateDnaReport(reportId, effectiveDto, { bypassOwnershipCheck: true });
  }

  @ApiEndpoint({
    returnedModel: DnaJobResponseDto,
    method: HttpMethod.POST,
    path: 'generate/:doctorId',
    by: ['doctorId'],
  })
  @ApiParam({ name: 'doctorId', description: 'Target doctor ID', type: String })
  @ApiResponse({ status: 400, description: 'Bad request — invalid input' })
  async generateForDoctor(@Param('doctorId') doctorId: string, @Body() dto: GenerateDnaReportRequest): Promise<DnaJobResponse> {
    return this.dnaService.generateDnaReport(doctorId, dto);
  }

  @ApiEndpoint({
    returnedModel: DnaVersionResponse,
    multi: true,
    path: ':reportId/versions',
    by: ['reportId'],
  })
  @ApiParam({ name: 'reportId', description: 'Report ID', type: String })
  @ApiResponse({ status: 404, description: 'Report not found' })
  async getVersions(@Param('reportId') reportId: string): Promise<DnaVersionResponse[]> {
    return this.dnaService.getVersions(reportId);
  }

  @Get('jobs/:jobId')
  @ApiOperation({ summary: 'Get DNA generation job status' })
  @ApiParam({ name: 'jobId', description: 'BullMQ job ID', type: String })
  @ApiResponse({ status: 200, description: 'Job status', type: DnaJobStatusResponseDto })
  @ApiResponse({ status: 404, description: 'Job not found' })
  async getJobStatus(@Param('jobId') jobId: string): Promise<DnaJobStatusResponseDto> {
    return getDnaJobStatus(this.dnaQueue, jobId);
  }

  // TASK-419 item 6 — @StreamScope lets single-use tickets from
  // POST /auth/stream-ticket (scope `dna_job:<jobId>`, the namespace the
  // console and the Vox SDK already mint) authenticate this SSE route; without
  // it the JwtAuthGuard rejects every ticket with 401 and the console had to
  // ship a labeled polling fallback.
  @Get('jobs/:jobId/stream')
  @Sse()
  @StreamScope({ namespace: 'dna_job', param: 'jobId' })
  @ApiOperation({
    summary: 'Stream DNA generation job status via SSE',
    description:
      'Accepts either `Authorization: Bearer <jwt>` or a single-use `?ticket=<ticket>` issued by ' +
      '`POST /auth/stream-ticket` with scope `dna_job:<jobId>`.',
  })
  @ApiParam({ name: 'jobId', description: 'BullMQ job ID', type: String })
  @ApiResponse({ status: 200, description: 'SSE job status stream' })
  streamJobStatus(@Param('jobId') jobId: string): Observable<MessageEvent> {
    return streamDnaJobStatus(this.dnaQueue, jobId);
  }
}
