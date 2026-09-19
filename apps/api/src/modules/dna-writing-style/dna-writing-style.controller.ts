import {
  IDnaWritingStyleService,
  DnaReportResponse,
  DnaVersionResponse,
  DnaSettingsResponse,
  GenerateDnaReportRequest,
  UpdateDnaReportRequest,
  UpdateDnaSettingsRequest,
  DnaErasureResponse,
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
  Delete,
  Sse,
  type MessageEvent,
} from '@nestjs/common';

// Admin vs. doctor role sets, mirroring the UI's
// `useDoctorContext` gate. A "global"/tenant admin who is NOT also a clinical
// user and is NOT impersonating one must not generate a DNA style (which would
// be owned by their own account — a per-doctor isolation break).
// The pre- SUPER_ADMIN role is retired; SUPER_ADMIN (formerly
// SUPER_ADMIN, renamed) is the sole elevated role.
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
import { ApiEndpoint, Authorize, RequiresIfMatch, ExpectedVersion, ForbidApiKey } from '../../decorators';
import { StreamScope } from '../auth/decorators/stream-scope.decorator';
import { getDnaJobStatus, streamDnaJobStatus, type DnaJobAccess } from './dna-writing-style-job-stream';

@ApiBearerAuth()
@ApiTags('dna-writing-styles')
@Controller('dna-writing-styles')
@Authorize()
// API-KEY-NOTE — REASONED EXEMPTION from policy A1 (JWT + API key on the
// business plane), recorded and policed by the boot audit
// `BUSINESS_PLANE_KEY_FORBIDDEN` (bootstrap/business-plane-apikey-exemptions-audit.ts).
// A clinician's PERSONAL writing model. The owner/doctor checks live in the
// service (see the AUTH-NOTEs there) — and, for the two `jobs/:jobId` routes
// that talk to BullMQ directly instead of going through the service, in
// `dna-writing-style-job-stream.ts` (finding C-01: the rationale and the code
// had diverged; those routes carried NO owner check at all). Either way the class-level `@Authorize()`
// understates the real gate — converting would hand a long-lived static
// credential a principal's private model on the strength of a bare
// authenticated check. JWT only.
//
// `jobs/:jobId/stream` now carries `@StreamScope({ namespace: 'dna_job', param: 'jobId' })`
// (TASK-991, mirroring the admin twin), so a `?ticket=` request authenticates instead of
// 401ing — this is no longer a blocker if the class is ever un-exempted.
@ForbidApiKey()
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
  // TASK-974 §9.2 — DNA draws on the tenant's LLM allowance like every other text call, and is
  // pre-checked before the job is queued rather than after the model has spent.
  @ApiResponse({ status: 402, description: 'The tenant has reached the monthly spend ceiling it set; nothing was queued.' })
  @ApiResponse({ status: 429, description: 'The tenant is over its monthly LLM-token allowance; nothing was queued.' })
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
  // Storage is the doctor's `UserSettings` preference (`dna` / `styleEnabled`, TASK-882); the
  // tenant gate is the assigned graph's `agent.dna_style` node.
  // `effective = tenant AND doctor`; the UI binds the switch to `doctorToggle`
  // and disables it when `tenantEnabled` is false.
  @Get('settings')
  @ApiOperation({ summary: "Get the caller doctor's DNA writing-style on/off settings" })
  @ApiResponse({ status: 200, description: 'Per-doctor DNA settings', type: DnaSettingsResponse })
  async getSettings(): Promise<DnaSettingsResponse> {
    return this.dnaService.getDnaSettings(this.getDoctorId());
  }

  @Put('settings')
  @RequiresIfMatch()
  @ApiOperation({
    summary: "Set the caller doctor's DNA writing-style on/off toggle",
    description:
      'Writes the caller doctor`s DNA preference (`UserSettings` `dna` / `styleEnabled`). `enabled: false` is an explicit ' +
      'opt-out, `enabled: null` clears the override (revert to the implicit opt-in). Optimistic concurrency is ' +
      'ENFORCED: `If-Match` (RFC 7232) is REQUIRED and overrides the body `expectedVersion`. `GET settings` ' +
      'answers `version: 0` while no DOCTOR-scope row exists, so the FIRST write echoes the create-intent ' +
      'validator `If-Match: "0"`. Drift is `412`; a missing header is `428`. The DNA learning processor honours ' +
      'the resulting opt-out on its next BATCH run.',
  })
  @ApiHeader({
    name: 'If-Match',
    description: 'RFC 7232 strong validator carrying the version `GET settings` returned (`"0"` before the first write).',
    required: true,
    example: '"0"',
  })
  @ApiResponse({ status: 200, description: 'Updated per-doctor DNA settings', type: DnaSettingsResponse })
  @ApiResponse({ status: 403, description: 'An admin not acting as a doctor cannot toggle DNA under their own account.' })
  @ApiResponse({ status: 412, description: 'Optimistic concurrency conflict — re-fetch and retry with the new version.' })
  @ApiResponse({ status: 428, description: 'If-Match header is required for this operation.' })
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
  @RequiresIfMatch()
  @ApiOperation({
    summary: "Promote one of the caller's reports to their active/default style",
    description:
      'Optimistic concurrency is ENFORCED: `If-Match` (RFC 7232) is REQUIRED and CASes against the report row. ' +
      'Promotion is idempotent (a report that is already the default returns unchanged) — the precondition is ' +
      'still evaluated first, so a stale client gets `412` rather than a misleading `200`. A missing header is `428`.',
  })
  @ApiHeader({
    name: 'If-Match',
    description: 'RFC 7232 strong validator carrying the report version the client read (e.g. `"3"`).',
    required: true,
    example: '"3"',
  })
  @ApiParam({ name: 'reportId', description: 'Report ID', type: String })
  @ApiResponse({ status: 403, description: "Cannot set another doctor's report as default" })
  @ApiResponse({ status: 404, description: 'Report not found' })
  @ApiResponse({ status: 412, description: 'Optimistic concurrency conflict — re-fetch and try again with the new version.' })
  @ApiResponse({ status: 428, description: 'If-Match header is required for this operation.' })
  async setDefault(@Param('reportId') reportId: string, @ExpectedVersion() expectedFromHeader: number | undefined): Promise<DnaReportResponse> {
    return this.dnaService.setDefaultReport(reportId, expectedFromHeader);
  }

  // ─── Erasure — the other half of the opt-out (INV-240 / INV-241) ──────────
  //
  // `PUT settings { enabled: false }` only stops FUTURE learning; the profile
  // already learned stays stored and keeps being injected into this doctor's
  // summary prompts. INV-167 requires style learning to be reversible BY THE
  // CLINICIAN, which needs an erasure path, not just a toggle.
  //
  // AUTH-NOTE: declared with the class-level `@Authorize()` (any authenticated
  // user) because the subject is ALWAYS the caller — the service derives the
  // doctor from CLS, so there is no id to smuggle and nothing to widen. This is
  // the same owner-scoped self-service shape as `my-style` / `settings`, and it
  // matches rule 05's "owner-scoped self-service write declared with the
  // ability the clinician actually holds" pattern: requiring `delete` would
  // lock clinicians out of erasing their own profile.
  @Delete('my-style')
  @ApiOperation({
    summary: "Erase the caller doctor's entire learned DNA writing-style profile",
    description:
      'Soft-deletes every DNA writing-style report the caller owns, plus each report version. The profile stops ' +
      'being injected into subsequent summaries immediately. Idempotent — a doctor with no profile gets zero counts. ' +
      'This does NOT change the on/off toggle: erase and opt out are independent, so a doctor may erase and keep ' +
      'learning enabled (a fresh profile is then built from their approved notes).',
  })
  @ApiResponse({ status: 200, description: 'Erasure counts', type: DnaErasureResponse })
  @ApiResponse({ status: 403, description: 'An admin not acting as a doctor cannot erase a profile under their own account.' })
  async resetMyStyle(): Promise<DnaErasureResponse> {
    // Mirror `generate`/`setSettings`: a non-impersonating admin must not act
    // on a DNA profile under their OWN account.
    this.assertActingAsDoctor();
    return this.dnaService.resetMyDnaProfile();
  }

  // AUTH-NOTE: as above — class-level `@Authorize()`, owner-scoped. The
  // service enforces BOTH boundaries on the supplied id: a cross-TENANT report
  // is 404 (never 403 — the 404-over-403 posture hides existence), while a
  // same-tenant report owned by another doctor is a genuine privilege 403.
  @Delete(':reportId')
  @ApiOperation({
    summary: "Erase one of the caller doctor's DNA writing-style reports",
    description:
      'Soft-deletes a single owned report and its versions — for dropping one bad snapshot rather than the whole ' +
      'profile. Use `DELETE my-style` to erase everything.',
  })
  @ApiParam({ name: 'reportId', description: 'Report ID', type: String })
  @ApiResponse({ status: 200, description: 'Erasure counts', type: DnaErasureResponse })
  @ApiResponse({ status: 403, description: "Cannot erase another doctor's report" })
  @ApiResponse({ status: 404, description: 'Report not found (also returned for a report in another tenant)' })
  async deleteReport(@Param('reportId') reportId: string): Promise<DnaErasureResponse> {
    this.assertActingAsDoctor();
    return this.dnaService.deleteReport(reportId);
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

  /**
   * The caller's identity as the DNA job routes see it: active (CLS) tenant +
   * own user id. Both are compared against the owner fields stamped on the job
   * payload at enqueue time.
   */
  private jobAccess(): DnaJobAccess {
    return { tenantId: this.cls.get('tenantId') ?? null, doctorId: this.getDoctorId() };
  }

  // AUTH-NOTE: declared with the class-level bare `@Authorize()` (any
  // authenticated user) DELIBERATELY — there is no ability that expresses
  // "your own generation job", and requiring one would lock clinicians out of
  // polling a job they just started. OWNERSHIP, not permission, is the gate,
  // and it is enforced below by `jobAccess()` + `assertDnaJobAccess`: the job
  // payload's `tenantId` must equal the caller's active tenant and its
  // `doctorId`/`userId` must be the caller. This is the same owner-scoped
  // self-service shape as `my-style` / `settings` (rule 05 §Imperative
  // Privilege Checks). Before this check existed, the bare `@Authorize()` was
  // the WHOLE gate and any authenticated user could read any doctor's
  // writing-style model by guessing a sequential BullMQ job id.
  @Get('jobs/:jobId')
  @ApiOperation({ summary: 'Get current user DNA generation job status' })
  @ApiParam({ name: 'jobId', description: 'BullMQ job ID', type: String })
  @ApiResponse({ status: 200, description: 'Job status', type: DnaJobStatusResponseDto })
  @ApiResponse({ status: 404, description: 'Job not found (also returned for a job owned by another doctor or tenant)' })
  async getJobStatus(@Param('jobId') jobId: string): Promise<DnaJobStatusResponseDto> {
    return getDnaJobStatus(this.dnaQueue, jobId, this.jobAccess());
  }

  // AUTH-NOTE: as above — ownership is the gate, enforced per emission.
  @Get('jobs/:jobId/stream')
  @Sse()
  @StreamScope({ namespace: 'dna_job', param: 'jobId' })
  @ApiOperation({ summary: 'Stream current user DNA generation job status via SSE' })
  @ApiParam({ name: 'jobId', description: 'BullMQ job ID', type: String })
  @ApiResponse({ status: 200, description: 'SSE job status stream' })
  streamJobStatus(@Param('jobId') jobId: string): Observable<MessageEvent> {
    return streamDnaJobStatus(this.dnaQueue, jobId, this.jobAccess());
  }
}
