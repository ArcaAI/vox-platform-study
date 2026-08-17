import {
  IDnaWritingStyleService,
  DnaReportResponse,
  DnaVersionResponse,
  DnaSettingsResponse,
  GenerateDnaReportRequest,
  UpdateDnaReportRequest,
  UpdateDnaSettingsRequest,
  HttpMethod,
  type DnaJobResponse,
  type RedactionRuleSet,
} from '@arcaai/applications';
import { DnaJobResponseDto, DnaJobStatusResponseDto } from './dna-writing-style.dto';
import { JobQueue } from '@arcaai/domains';
import {
  Controller,
  Body,
  Param,
  Inject,
  ForbiddenException,
  NotFoundException,
  UnauthorizedException,
  Get,
  Put,
  Sse,
  type MessageEvent,
} from '@nestjs/common';

// Admin vs. doctor role sets, mirroring the UI's
// `useDoctorContext` gate. A "global"/tenant admin who is NOT also a clinical
// user and is NOT impersonating one must not generate a DNA style (which would
// be owned by their own account — a per-doctor isolation break).
// The pre- SUPER_ADMIN role is retired; SUPER_ADMIN (formerly
// SUPER_ADMIN, renamed ) is the sole elevated role.
const DNA_ADMIN_ROLES = ['SUPER_ADMIN', 'TENANT_ADMIN'];
const DNA_DOCTOR_ROLES = ['DOCTOR', 'SPECIALIST', 'CONSULTANT'];
import { ApiTags, ApiBearerAuth, ApiHeader, ApiParam, ApiResponse, ApiOperation } from '@nestjs/swagger';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { ClsService } from 'nestjs-cls';
import type { IActiveUserContext } from '@arcaai/applications';
import { Observable } from 'rxjs';
// `@RequiresIfMatch()` + `@ExpectedVersion()` gate the
// OCC-enforced doctor self-edit PATCH route below (mirrors the admin controller).
import { ApiEndpoint, Authorize, RequiresIfMatch, ExpectedVersion } from '../../decorators';
import { getDnaJobStatus, streamDnaJobStatus } from './dna-writing-style-job-stream';

@ApiBearerAuth()
@ApiTags('dna-writing-styles')
@Controller('dna-writing-styles')
@Authorize()
export class DnaWritingStyleController {
  constructor(
    @Inject(IDnaWritingStyleService)
    private readonly dnaService: IDnaWritingStyleService,
    private readonly cls: ClsService<IActiveUserContext>,
    @InjectQueue(JobQueue.GenerateDnaReport)
    private readonly dnaQueue: Queue,
  ) {}

  private getDoctorId(): string {
    const user = this.cls.get('user');
    if (!user?.id) {
      throw new UnauthorizedException('User context not available');
    }
    return user.id;
  }

  /**
   * Defense-in-depth doctor-scope gate for `generate`.
   *
   * `generate` derives the owner from the caller (`getDoctorId()`), so a
   * non-impersonating admin would create a DNA writing-style under their OWN
   * account. Reject when the caller is an admin who is neither a clinical user
   * nor actively impersonating a doctor (impersonation swaps the CLS user to the
   * doctor and stamps `impersonatedBy`). Non-admin/doctor callers are unaffected.
   */
  private assertActingAsDoctor(): void {
    const user = this.cls.get('user');
    const roles = user?.roles ?? [];
    const isAdmin = roles.some((r) => DNA_ADMIN_ROLES.includes(r));
    const isDoctor = roles.some((r) => DNA_DOCTOR_ROLES.includes(r));
    const isImpersonating = Boolean(user?.impersonatedBy);
    if (isAdmin && !isDoctor && !isImpersonating) {
      throw new ForbiddenException(
        'DNA writing styles are personalized per doctor. Impersonate a doctor to generate a style; an admin cannot generate one under their own account.',
      );
    }
  }

  @ApiEndpoint({
    returnedModel: DnaJobResponseDto,
    method: HttpMethod.POST,
    path: 'generate',
  })
  @ApiResponse({ status: 400, description: 'Bad request — invalid input' })
  async generate(@Body() dto: GenerateDnaReportRequest): Promise<DnaJobResponse> {
    // Block a non-impersonating admin from self-generating.
    this.assertActingAsDoctor();
    return this.dnaService.generateDnaReport(this.getDoctorId(), dto);
  }

  @ApiEndpoint({
    returnedModel: DnaReportResponse,
    path: 'my-style',
  })
  @ApiResponse({ status: 404, description: 'No DNA style found for current user' })
  async getMyStyle(): Promise<DnaReportResponse> {
    const report = await this.dnaService.getDnaReport(this.getDoctorId());
    if (!report) {
      throw new NotFoundException('No DNA writing style found for current user');
    }
    return report;
  }

  // The caller's decrypted DNA redaction/rewrite rule set. Read-only
  // companion to the redaction editor (rules are WRITTEN via the report PATCH's
  // `redactionRules` field). The set is always well-formed (`{ rules: [] }` when
  // the doctor has no report or no rules), so the editor never 404s here.
  @Get('my-style/redaction-rules')
  @ApiOperation({
    summary: "Get the caller doctor's DNA redaction/rewrite rule set",
    description:
      'Returns the decrypted `{ rules: [...] }` authored by the caller (owner derived from CLS). An empty set means no rules are configured. Rules are WRITTEN through the report PATCH `redactionRules` field, not here.',
  })
  @ApiResponse({ status: 200, description: 'Redaction rule set ({ rules: [...] })' })
  async getMyRedactionRules(): Promise<RedactionRuleSet> {
    return this.dnaService.getRedactionRules(this.getDoctorId());
  }

  // ─── Per-doctor DNA on/off settings ──────────────────────────────────
  // Storage is the Phase-5 DOCTOR-scope `PipelinePolicy.dnaStyleEnabled`.
  // `effective = tenant AND doctor`; the UI binds the switch to `doctorToggle`
  // and disables it when `tenantEnabled` is false.
  @Get('settings')
  @ApiOperation({ summary: "Get the caller doctor's DNA writing-style on/off settings" })
  @ApiResponse({ status: 200, description: 'Per-doctor DNA settings', type: DnaSettingsResponse })
  async getSettings(): Promise<DnaSettingsResponse> {
    return this.dnaService.getDnaSettings(this.getDoctorId());
  }

  @Put('settings')
  @ApiOperation({
    summary: "Set the caller doctor's DNA writing-style on/off toggle",
    description:
      'Writes the DOCTOR-scope `PipelinePolicy.dnaStyleEnabled` for the caller. `enabled: false` is an explicit ' +
      'opt-out, `enabled: null` clears the override (revert to the implicit opt-in). Optimistic concurrency is ' +
      'optional: when an `If-Match` header is present it overrides the body `expectedVersion`. The DNA learning ' +
      'processor honours the resulting opt-out on its next BATCH run.',
  })
  @ApiResponse({ status: 200, description: 'Updated per-doctor DNA settings', type: DnaSettingsResponse })
  @ApiResponse({ status: 403, description: 'An admin not acting as a doctor cannot toggle DNA under their own account.' })
  @ApiResponse({ status: 412, description: 'Optimistic concurrency conflict — re-fetch and retry with the new version.' })
  async setSettings(@Body() dto: UpdateDnaSettingsRequest, @ExpectedVersion() expectedFromHeader: number | undefined): Promise<DnaSettingsResponse> {
    // Mirror `generate`: a non-impersonating admin must not toggle DNA under
    // their OWN account (per-doctor isolation — the toggle is owned by CLS user).
    this.assertActingAsDoctor();
    const effective: UpdateDnaSettingsRequest = expectedFromHeader !== undefined ? { ...dto, expectedVersion: expectedFromHeader } : dto;
    return this.dnaService.setDnaEnabled(this.getDoctorId(), effective);
  }

  // Owner-scoped report history for the playground's report list
  // and set-default picker. Tenant scope is enforced in the service.
  @ApiEndpoint({
    returnedModel: DnaReportResponse,
    multi: true,
    path: 'mine',
  })
  async getMine(): Promise<DnaReportResponse[]> {
    return this.dnaService.listReports({ doctorId: this.getDoctorId() });
  }

  @ApiEndpoint({
    returnedModel: DnaReportResponse,
    path: 'doctor/:doctorId',
    by: ['doctorId'],
  })
  @ApiParam({ name: 'doctorId', description: 'Doctor ID', type: String })
  @ApiResponse({ status: 403, description: "Cannot access another doctor's DNA style" })
  @ApiResponse({ status: 404, description: 'No DNA style found for doctor' })
  async getByDoctor(@Param('doctorId') doctorId: string): Promise<DnaReportResponse> {
    const currentUserId = this.getDoctorId();
    if (doctorId !== currentUserId) {
      throw new ForbiddenException("Cannot access another doctor's DNA writing style");
    }
    const report = await this.dnaService.getDnaReport(doctorId);
    if (!report) {
      throw new NotFoundException(`No DNA writing style found for doctor ${doctorId}`);
    }
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
    summary: "Update the current doctor's DNA writing-style report",
    description:
      'Updates one DNA writing-style report row owned by the caller. Optimistic ' +
      'concurrency is enforced: the `If-Match` header (RFC ' +
      "7232) is REQUIRED and the server runs a Compare-And-Set against the row's " +
      '`_version` column (DISTINCT from `currentVersionNumber`, the DnaVersion ' +
      'history counter). When the header is present, its value overrides the ' +
      'body-field `expectedVersion`. On version drift the response is `412 ' +
      'Precondition Failed`; a missing header is `428 Precondition Required`. The ' +
      'doctor is derived from CLS, so an admin-impersonated doctor session works ' +
      'identically.',
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
    // Header takes precedence over body when both are
    // present. On this `@RequiresIfMatch()` route the param decorator already
    // fired 428 if the header was missing. The service runs CAS with
    // `dto.expectedVersion` (no service change needed).
    const effectiveDto: UpdateDnaReportRequest = expectedFromHeader !== undefined ? { ...dto, expectedVersion: expectedFromHeader } : dto;
    return this.dnaService.updateDnaReport(reportId, effectiveDto);
  }

  // Promote a report to the doctor's active/default. Owner +
  // tenant scope enforced in the service.
  @ApiEndpoint({
    returnedModel: DnaReportResponse,
    method: HttpMethod.PATCH,
    path: ':reportId/default',
    by: ['reportId'],
  })
  @ApiParam({ name: 'reportId', description: 'Report ID', type: String })
  @ApiResponse({ status: 403, description: "Cannot set another doctor's report as default" })
  @ApiResponse({ status: 404, description: 'Report not found' })
  async setDefault(@Param('reportId') reportId: string): Promise<DnaReportResponse> {
    return this.dnaService.setDefaultReport(reportId);
  }

  @ApiEndpoint({
    returnedModel: DnaVersionResponse,
    multi: true,
    path: ':reportId/versions',
    by: ['reportId'],
  })
  @ApiParam({ name: 'reportId', description: 'Report ID', type: String })
  @ApiResponse({ status: 403, description: "Cannot access another doctor's report versions" })
  @ApiResponse({ status: 404, description: 'Report not found' })
  async getVersions(@Param('reportId') reportId: string): Promise<DnaVersionResponse[]> {
    return this.dnaService.getVersionsForDoctor(reportId, this.getDoctorId());
  }

  @Get('jobs/:jobId')
  @ApiOperation({ summary: 'Get current user DNA generation job status' })
  @ApiParam({ name: 'jobId', description: 'BullMQ job ID', type: String })
  @ApiResponse({ status: 200, description: 'Job status', type: DnaJobStatusResponseDto })
  @ApiResponse({ status: 404, description: 'Job not found' })
  async getJobStatus(@Param('jobId') jobId: string): Promise<DnaJobStatusResponseDto> {
    return getDnaJobStatus(this.dnaQueue, jobId);
  }

  @Get('jobs/:jobId/stream')
  @Sse()
  @ApiOperation({ summary: 'Stream current user DNA generation job status via SSE' })
  @ApiParam({ name: 'jobId', description: 'BullMQ job ID', type: String })
  @ApiResponse({ status: 200, description: 'SSE job status stream' })
  streamJobStatus(@Param('jobId') jobId: string): Observable<MessageEvent> {
    return streamDnaJobStatus(this.dnaQueue, jobId);
  }
}
