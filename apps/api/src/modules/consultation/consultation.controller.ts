import {
  IConsultationService,
  IContextService,
  ISummaryService,
  TimelineService,
  ComprehensiveSummaryRequest,
  OpenConsultationRequest,
  UpdateConsultationRequest,
  ConsultationResponse,
  PaginatedConsultationResponse,
  AddContextRequest,
  AddAudioRecordingRequest,
  AudioRecordingResponse,
  UpdateContextRequest,
  ContextItemResponse,
  ContextItemVersionResponse,
  VersionDiffResponse,
  ComprehensiveSummaryResponse as ComprehensiveSummaryResponseDto,
  GenerateSummaryRequest,
  GeneratePreSummaryRequest,
  UpdateSummaryRequest,
  SummaryApprovalRequest,
  SummaryResponse,
  SummaryProvenanceResponse,
  AggregateNerResponse,
  ConsultationTimelineResponse,
  PaginatedQuery,
  HttpMethod,
  PolicyEngine,
  AppAbility,
  ITagService,
  CreateTagRequest,
  TagResponse,
  TagDtoMapper,
  LiveDocumentationService,
  StartRecordingRequest,
  StopRecordingRequest,
  RecordingStateResponse,
  // TASK-344 Workstream B — manual doctor highlighting.
  IHighlightService,
  CreateHighlightRequest,
  HighlightResponse,
  // TASK-345 — live harness activity/progress feed.
  HarnessProgressService,
  // TASK-355 Phase D Slice 5d — live per-claim assurance feed.
  HarnessAssuranceService,
} from '@arcaai/applications';
import {
  Controller,
  Body,
  Param,
  Inject,
  Query,
  ForbiddenException,
  NotFoundException,
  UnauthorizedException,
  Logger,
  Get,
  Sse,
  type MessageEvent,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiParam, ApiProperty, ApiPropertyOptional, ApiQuery, ApiResponse, ApiOperation } from '@nestjs/swagger';
import type { Observable } from 'rxjs';
import { ApiEndpoint, Authorize } from '../../decorators';
import { TenantOwnedResource } from '../../common';
import { StreamScope } from '../auth';
import { ClsService } from 'nestjs-cls';
import type { IActiveUserContext } from '@arcaai/applications';
import { ChainSummaryService } from '@arcaai/applications';
import { IConsultationJobService } from '@arcaai/applications';
import { GlobalSettingRepository, ResourceType } from '@arcaai/domains';

class AsyncJobResponseDto {
  @ApiProperty({ description: 'Async job ID' })
  jobId: string;

  @ApiProperty({ description: 'Job status', enum: ['pending', 'processing', 'completed', 'failed'] })
  status: 'pending' | 'processing' | 'completed' | 'failed';

  @ApiProperty({ description: 'Associated consultation ID' })
  consultationId: string;

  @ApiProperty({ description: 'Job creation timestamp' })
  createdAt: string;

  @ApiPropertyOptional({ description: 'Job progress percentage (0-100)' })
  progress?: number;

  @ApiPropertyOptional({ description: 'Job result (partial summary)' })
  result?: Partial<SummaryResponse>;

  @ApiPropertyOptional({ description: 'Error message if job failed' })
  errorMessage?: string;

  constructor(data: {
    jobId: string;
    status: 'pending' | 'processing' | 'completed' | 'failed';
    consultationId: string;
    createdAt: string;
    progress?: number;
    result?: Partial<SummaryResponse>;
    errorMessage?: string;
  }) {
    this.jobId = data.jobId;
    this.status = data.status;
    this.consultationId = data.consultationId;
    this.createdAt = data.createdAt;
    this.progress = data.progress;
    this.result = data.result;
    this.errorMessage = data.errorMessage;
  }
}

class SummaryApprovalResponseDto {
  @ApiProperty({ description: 'Context item ID of the approved summary' })
  contextItemId: string;

  @ApiProperty({ description: 'Approval status' })
  approvalStatus: string;

  @ApiProperty({ description: 'User ID who approved' })
  approvedBy: string;

  @ApiProperty({ description: 'Approval timestamp' })
  approvedAt: string;

  constructor(data: { contextItemId: string; approvalStatus: string; approvedBy: string; approvedAt: string }) {
    this.contextItemId = data.contextItemId;
    this.approvalStatus = data.approvalStatus;
    this.approvedBy = data.approvedBy;
    this.approvedAt = data.approvedAt;
  }
}

class OkResponseDto {
  @ApiProperty({ description: 'Success indicator', example: true })
  ok: true;

  constructor() {
    this.ok = true;
  }
}

@ApiBearerAuth()
@ApiTags('consultations')
@Controller('consultations')
@Authorize()
export class ConsultationController {
  private readonly logger = new Logger(ConsultationController.name);

  constructor(
    @Inject(IConsultationService)
    private readonly consultationService: IConsultationService,
    @Inject(IContextService)
    private readonly contextService: IContextService,
    @Inject(ISummaryService)
    private readonly summaryService: ISummaryService,
    private readonly chainSummaryService: ChainSummaryService,
    @Inject(IConsultationJobService)
    private readonly consultationJobService: IConsultationJobService,
    private readonly timelineService: TimelineService,
    private readonly cls: ClsService<IActiveUserContext>,
    private readonly policyEngine: PolicyEngine,
    private readonly globalSettingRepository: GlobalSettingRepository,
    @Inject(ITagService)
    private readonly tagService: ITagService,
    // Clinical Workflow Playground (WS1/WS2) — per-consultation realtime watcher.
    private readonly liveDocumentationService: LiveDocumentationService,
    // TASK-344 Workstream B — manual doctor highlighting.
    @Inject(IHighlightService)
    private readonly highlightService: IHighlightService,
    // TASK-345 — live harness activity/progress feed (SSE relay).
    private readonly harnessProgressService: HarnessProgressService,
    // TASK-355 Phase D Slice 5d — live per-claim assurance feed (SSE relay).
    private readonly harnessAssuranceService: HarnessAssuranceService,
  ) {}

  private getDoctorId(): string {
    const user = this.cls.get('user');
    if (!user?.id) {
      throw new UnauthorizedException('User context not available');
    }
    return user.id;
  }

  private getUserAbility(): AppAbility | undefined {
    return this.cls.get('userAbility') as AppAbility | undefined;
  }

  /**
   * Check if consultation sharing is enabled for the current tenant.
   * Reads the `enable-consultation-sharing` feature flag from GlobalSetting.
   *
   * TASK-307 W5.4 (AC-18, audit D-2): default-CLOSED. The flag must be
   * EXPLICITLY set to the string `'true'` to enable shared-patient reads.
   *   - missing row    -> false
   *   - any other value -> false
   *   - DB error       -> false (fail-closed, log for ops)
   */
  private async isSharingEnabled(): Promise<boolean> {
    const tenantId = this.cls.get('tenantId');
    if (!tenantId) return false;
    try {
      const settings = await this.globalSettingRepository.findAll({
        where: {
          tenantId,
          key: 'enable-consultation-sharing',
        },
      });
      return settings[0]?.value === 'true';
    } catch (err) {
      this.logger.warn({
        message: 'isSharingEnabled lookup failed; defaulting to CLOSED',
        tenantId,
        error: (err as Error)?.message,
      });
      return false;
    }
  }

  /**
   * Two-layer READ access check:
   *
   * Layer 1 — CASL PolicyEngine (database-driven):
   *   The `@Authorize()` decorator already ran the guard and built the
   *   user's ability. If the static CASL rules grant `read Consultation`
   *   with matching conditions (e.g., owner via `doctorId: ${user.id}`),
   *   access is allowed immediately.
   *
   * Layer 2 — Dynamic shared-patient fallback:
   *   If the caller is NOT the owner, check whether they have any
   *   consultation with the same patient in the same tenant AND the
   *   `enable-consultation-sharing` feature flag is on. This is a
   *   runtime DB lookup that cannot be expressed as a static CASL
   *   condition.
   */
  private async verifyConsultationAccess(consultationId: string): Promise<void> {
    const consultation = await this.consultationService.getById(consultationId);
    if (!consultation) {
      throw new NotFoundException(`Consultation ${consultationId} not found`);
    }

    const doctorId = this.getDoctorId();

    // Layer 1: owner check (matches CASL `consultation-own-manage` policy)
    if (consultation.doctorId === doctorId) {
      return;
    }

    // Layer 1b: CASL ability check for non-owner read (e.g., tenant-admin, dept-head)
    const ability = this.getUserAbility();
    if (ability) {
      const canRead = this.policyEngine.can(ability, 'read', 'Consultation', {
        tenantId: this.cls.get('tenantId'),
        doctorId: consultation.doctorId,
      } as Record<string, unknown>);
      if (canRead) return;
    }

    // Layer 2: dynamic shared-patient check (configurable per tenant)
    const sharingEnabled = await this.isSharingEnabled();
    if (!sharingEnabled) {
      throw new ForbiddenException('You do not have access to this consultation');
    }

    const tenantId = this.cls.get('tenantId') ?? '';
    const hasSharedPatient = await this.consultationService.doctorHasPatientRelationship(doctorId, consultation.patientId, tenantId);
    if (!hasSharedPatient) {
      throw new ForbiddenException('You do not have access to this consultation');
    }

    this.logger.debug({
      message: 'Shared-patient read access granted',
      doctorId,
      consultationId,
      patientId: consultation.patientId,
    });
  }

  /**
   * Two-layer WRITE access check:
   *
   * Layer 1 — Ownership: only the assigned doctor can mutate.
   * Layer 1b — CASL: admin/dept-head with `manage Consultation` bypasses.
   *
   * Shared-patient doctors NEVER get write access.
   */
  private async verifyConsultationOwnership(consultationId: string): Promise<void> {
    const consultation = await this.consultationService.getById(consultationId);
    if (!consultation) {
      throw new NotFoundException(`Consultation ${consultationId} not found`);
    }

    const doctorId = this.getDoctorId();
    if (consultation.doctorId === doctorId) {
      return;
    }

    // Allow admin/dept-head with broad `manage` permission
    const ability = this.getUserAbility();
    if (ability) {
      const canManage = this.policyEngine.can(ability, 'manage', 'Consultation', {
        tenantId: this.cls.get('tenantId'),
        doctorId: consultation.doctorId,
      } as Record<string, unknown>);
      if (canManage) return;
    }

    throw new ForbiddenException('Only the assigned doctor can modify this consultation');
  }

  /**
   * Verify the caller has a relationship with a patient (at least one
   * consultation with them) before allowing access to patient-level data.
   */
  private async verifyPatientAccess(patientId: string): Promise<void> {
    const doctorId = this.getDoctorId();
    const tenantId = this.cls.get('tenantId') ?? '';
    const hasRelationship = await this.consultationService.doctorHasPatientRelationship(doctorId, patientId, tenantId);
    if (!hasRelationship) {
      throw new ForbiddenException('You do not have access to this patient');
    }
  }

  // ─── Consultation CRUD ───────────────────────────────────────────

  @ApiEndpoint({
    returnedModel: ConsultationResponse,
    method: HttpMethod.POST,
    path: 'open',
  })
  @Authorize(['create', 'Consultation'])
  @ApiResponse({ status: 400, description: 'Bad request' })
  async open(@Body() request: OpenConsultationRequest): Promise<ConsultationResponse> {
    return this.consultationService.getOrCreate(request, this.getDoctorId());
  }

  @ApiEndpoint({
    returnedModel: ConsultationResponse,
    path: ':id',
    by: ['id'],
  })
  @ApiParam({ name: 'id', description: 'Consultation ID' })
  @ApiResponse({ status: 404, description: 'Consultation not found' })
  async getById(@Param('id') id: string): Promise<ConsultationResponse> {
    await this.verifyConsultationAccess(id);
    const result = await this.consultationService.getByIdWithRelations(id);
    if (!result) throw new NotFoundException(`Consultation ${id} not found`);
    return result;
  }

  @ApiEndpoint({
    returnedModel: ConsultationResponse,
    multi: true,
  })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiQuery({ name: 'patientId', required: false, type: String })
  async list(@Query() query: PaginatedQuery & { patientId?: string }): Promise<PaginatedConsultationResponse> {
    return this.consultationService.listConsultations({
      page: Number(query.page) || 1,
      pageSize: Number(query.limit) || 10,
      doctorId: this.getDoctorId(),
      patientId: query.patientId,
    });
  }

  @ApiEndpoint({
    returnedModel: ConsultationResponse,
    multi: true,
    path: 'patient/:patientId/history',
    by: ['patientId'],
  })
  @ApiParam({ name: 'patientId', description: 'Patient ID' })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  async getPatientHistory(@Param('patientId') patientId: string, @Query() query: PaginatedQuery): Promise<PaginatedConsultationResponse> {
    await this.verifyPatientAccess(patientId);
    return this.consultationService.getPatientHistoryPaginated(patientId, Number(query.page) || 1, Number(query.limit) || 10);
  }

  @ApiEndpoint({
    returnedModel: ConsultationResponse,
    multi: true,
    path: 'patient/:patientId/date/:date',
    by: ['patientId', 'date'],
  })
  @ApiParam({ name: 'patientId', description: 'Patient ID' })
  @ApiParam({ name: 'date', description: 'Appointment date (YYYY-MM-DD)' })
  async getByPatientAndDate(@Param('patientId') patientId: string, @Param('date') date: string): Promise<ConsultationResponse[]> {
    await this.verifyPatientAccess(patientId);
    return this.consultationService.getByPatientAndDate(patientId, date);
  }

  @ApiEndpoint({
    returnedModel: ConsultationResponse,
    multi: true,
    path: ':id/chain',
    by: ['id'],
  })
  @ApiParam({ name: 'id', description: 'Consultation ID' })
  async getChain(@Param('id') id: string): Promise<ConsultationResponse[]> {
    await this.verifyConsultationAccess(id);
    return this.consultationService.getConsultationChain(id);
  }

  // ─── Lifecycle (TASK-322) ────────────────────────────────────────

  @ApiEndpoint({
    returnedModel: ConsultationResponse,
    method: HttpMethod.PATCH,
    path: ':id',
    by: ['id'],
  })
  @ApiParam({ name: 'id', description: 'Consultation ID' })
  @ApiResponse({ status: 404, description: 'Consultation not found' })
  async update(@Param('id') id: string, @Body() request: UpdateConsultationRequest): Promise<ConsultationResponse> {
    await this.verifyConsultationOwnership(id);
    return this.consultationService.updateConsultation(id, request);
  }

  @ApiEndpoint({
    returnedModel: ConsultationResponse,
    method: HttpMethod.POST,
    path: ':id/close',
    by: ['id'],
  })
  @ApiParam({ name: 'id', description: 'Consultation ID' })
  @ApiResponse({ status: 404, description: 'Consultation not found' })
  async close(@Param('id') id: string): Promise<ConsultationResponse> {
    await this.verifyConsultationOwnership(id);
    return this.consultationService.closeConsultation(id);
  }

  @ApiEndpoint({
    returnedModel: ConsultationResponse,
    method: HttpMethod.POST,
    path: ':id/reopen',
    by: ['id'],
  })
  @ApiParam({ name: 'id', description: 'Consultation ID' })
  @ApiResponse({ status: 404, description: 'Consultation not found' })
  async reopen(@Param('id') id: string): Promise<ConsultationResponse> {
    await this.verifyConsultationOwnership(id);
    return this.consultationService.reopenConsultation(id);
  }

  // ─── Recording lifecycle + live summary (Clinical Workflow Playground) ───
  //
  // WS2 — recording/start flips Consultation.status → RECORDING and starts the
  // per-consultation LiveDocumentationService session; recording/stop tears the
  // session down (optionally persisting a PRE_SUMMARY snapshot) and reverts the
  // status to OPEN (the harness later promotes it to PENDING_REVIEW).
  // WS1 — live-summary/stream relays the Redis pub/sub channel
  // `consultation:live-summary:{id}` to the client over SSE, mirroring the
  // consultation job-updates stream (auth via @TenantOwnedResource pre-stream
  // guard + @StreamScope ticket).

  @ApiEndpoint({
    returnedModel: RecordingStateResponse,
    method: HttpMethod.POST,
    path: ':id/recording/start',
    by: ['id'],
  })
  @ApiParam({ name: 'id', description: 'Consultation ID' })
  @ApiResponse({ status: 404, description: 'Consultation not found' })
  async startRecording(@Param('id') id: string, @Body() request: StartRecordingRequest): Promise<RecordingStateResponse> {
    await this.verifyConsultationOwnership(id);
    const consultation = await this.consultationService.startRecording(id);
    this.liveDocumentationService.start({
      consultationId: id,
      tenantId: this.cls.get('tenantId') ?? '',
      userId: this.getDoctorId(),
      sessionId: request?.sessionId,
    });
    return {
      consultationId: id,
      status: consultation.status ?? 'RECORDING',
      recording: true,
      sessionId: request?.sessionId,
      sseUrl: `/consultations/${id}/live-summary/stream`,
      updatedAt: new Date().toISOString(),
    };
  }

  @ApiEndpoint({
    returnedModel: RecordingStateResponse,
    method: HttpMethod.POST,
    path: ':id/recording/stop',
    by: ['id'],
  })
  @ApiParam({ name: 'id', description: 'Consultation ID' })
  @ApiResponse({ status: 404, description: 'Consultation not found' })
  async stopRecording(@Param('id') id: string, @Body() request: StopRecordingRequest): Promise<RecordingStateResponse> {
    await this.verifyConsultationOwnership(id);
    await this.liveDocumentationService.stop(id, { persistSnapshot: request?.persistSnapshot });
    const consultation = await this.consultationService.stopRecording(id);
    return {
      consultationId: id,
      status: consultation.status ?? 'OPEN',
      recording: false,
      sseUrl: `/consultations/${id}/live-summary/stream`,
      updatedAt: new Date().toISOString(),
    };
  }

  @Get(':id/live-summary/stream')
  @Sse()
  @TenantOwnedResource({ modelName: 'Consultation', paramName: 'id' })
  @StreamScope({ namespace: 'consultation_live_summary', param: 'id' })
  @ApiOperation({
    summary: 'Stream the running live summary for an in-progress consultation via SSE',
    description:
      'Server-Sent Events stream relaying the Redis channel `consultation:live-summary:{id}`. Each event is a LiveSummaryEventDto JSON. Accepts either `Authorization: Bearer <jwt>` or a single-use `?ticket=<ticket>` issued by `POST /auth/stream-ticket` with scope `consultation_live_summary:<id>`. The terminal event carries `closed: true` when recording stops.',
  })
  @ApiParam({ name: 'id', description: 'Consultation ID' })
  streamLiveSummary(@Param('id') id: string): Observable<MessageEvent> {
    return this.liveDocumentationService.subscribeToLiveSummary(id);
  }

  // TASK-345 — relays `consultation:harness-progress:{id}` (published by the
  // internal POST /internal/harness/consultations/:id/progress route) so the
  // review panel can show the live stage checklist while the draft generates.
  @Get(':id/harness-progress/stream')
  @Sse()
  @TenantOwnedResource({ modelName: 'Consultation', paramName: 'id' })
  @StreamScope({ namespace: 'consultation_harness_progress', param: 'id' })
  @ApiOperation({
    summary: 'Stream live harness draft-generation progress for a consultation via SSE',
    description:
      'Server-Sent Events stream relaying the Redis channel `consultation:harness-progress:{id}`. Each event is a HarnessProgressEventDto JSON carrying the full accumulated stage list (no PHI). Accepts either `Authorization: Bearer <jwt>` or a single-use `?ticket=<ticket>` issued by `POST /auth/stream-ticket` with scope `consultation_harness_progress:<id>`. The terminal event carries `closed: true` when the draft is persisted.',
  })
  @ApiParam({ name: 'id', description: 'Consultation ID' })
  streamHarnessProgress(@Param('id') id: string): Observable<MessageEvent> {
    return this.harnessProgressService.subscribeToProgress(id);
  }

  // TASK-355 Phase D Slice 5d — relays `consultation:harness-assurance:{id}`
  // (published per-claim by the internal POST .../assurance-event route and closed
  // by .../assurance) so the review panel can stream each verdict live, enable
  // sign-off when assurance lands, and surface a safety flag / amendment alert.
  // Its OWN @StreamScope namespace: a progress ticket must not read verdicts.
  @Get(':id/harness-assurance/stream')
  @Sse()
  @TenantOwnedResource({ modelName: 'Consultation', paramName: 'id' })
  @StreamScope({ namespace: 'consultation_harness_assurance', param: 'id' })
  @ApiOperation({
    summary: 'Stream live harness assurance (per-claim verdicts) for a consultation via SSE',
    description:
      'Server-Sent Events stream relaying the Redis channel `consultation:harness-assurance:{id}`. Each event is a HarnessAssuranceEventDto JSON carrying the full accumulated claim-verdict list (no PHI — ids, sensor keys, verdict labels only). Accepts either `Authorization: Bearer <jwt>` or a single-use `?ticket=<ticket>` issued by `POST /auth/stream-ticket` with scope `consultation_harness_assurance:<id>`. The terminal `assurance_complete` event carries `closed: true` plus the aggregate gateDecision, safetyFlag, and postSignAlert.',
  })
  @ApiParam({ name: 'id', description: 'Consultation ID' })
  streamHarnessAssurance(@Param('id') id: string): Observable<MessageEvent> {
    return this.harnessAssuranceService.subscribeToAssurance(id);
  }

  // ─── Timeline ────────────────────────────────────────────────────

  @ApiEndpoint({
    returnedModel: ConsultationTimelineResponse,
    path: ':id/timeline',
    by: ['id'],
  })
  @ApiParam({ name: 'id', description: 'Consultation ID' })
  @ApiQuery({ name: 'scope', required: false, enum: ['single', 'chain'] })
  async getTimeline(@Param('id') id: string, @Query('scope') scope?: 'single' | 'chain'): Promise<ConsultationTimelineResponse> {
    await this.verifyConsultationAccess(id);
    return this.timelineService.getTimeline(id, scope ?? 'chain');
  }

  // ─── Context Items ───────────────────────────────────────────────

  @ApiEndpoint({
    returnedModel: ContextItemResponse,
    method: HttpMethod.POST,
    path: ':id/context',
    by: ['id'],
  })
  @ApiParam({ name: 'id', description: 'Consultation ID' })
  async addContext(@Param('id') id: string, @Body() request: AddContextRequest): Promise<ContextItemResponse> {
    await this.verifyConsultationOwnership(id);
    return this.contextService.addContext(id, request);
  }

  @ApiEndpoint({
    returnedModel: ContextItemResponse,
    multi: true,
    path: ':id/context',
    by: ['id'],
  })
  @ApiParam({ name: 'id', description: 'Consultation ID' })
  async getContextItems(@Param('id') id: string): Promise<ContextItemResponse[]> {
    await this.verifyConsultationAccess(id);
    return this.contextService.getContextItems(id);
  }

  @ApiEndpoint({
    returnedModel: ContextItemResponse,
    multi: true,
    path: ':id/context/shared',
    by: ['id'],
  })
  @ApiParam({ name: 'id', description: 'Consultation ID' })
  async getSharedContext(@Param('id') id: string): Promise<ContextItemResponse[]> {
    await this.verifyConsultationAccess(id);
    return this.contextService.getSharedContext(id);
  }

  @ApiEndpoint({
    returnedModel: ContextItemResponse,
    multi: true,
    path: ':id/context/transcriptions',
    by: ['id'],
  })
  @ApiParam({ name: 'id', description: 'Consultation ID' })
  async getTranscriptions(@Param('id') id: string): Promise<ContextItemResponse[]> {
    await this.verifyConsultationAccess(id);
    return this.contextService.getTranscriptions(id);
  }

  @ApiEndpoint({
    returnedModel: ContextItemResponse,
    multi: true,
    path: ':id/context/case-notes',
    by: ['id'],
  })
  @ApiParam({ name: 'id', description: 'Consultation ID' })
  async getCaseNotes(@Param('id') id: string): Promise<ContextItemResponse[]> {
    await this.verifyConsultationAccess(id);
    return this.contextService.getContextItems(id, { type: 'CASE_NOTE' });
  }

  // ─── Audio Recordings (TASK-329 P2 — dual-capture X8) ────────────

  @ApiEndpoint({
    returnedModel: ContextItemResponse,
    method: HttpMethod.POST,
    path: ':id/recordings',
    by: ['id'],
  })
  @ApiParam({ name: 'id', description: 'Consultation ID' })
  async addRecording(@Param('id') id: string, @Body() request: AddAudioRecordingRequest): Promise<ContextItemResponse> {
    await this.verifyConsultationOwnership(id);
    return this.contextService.addAudioRecording(id, request);
  }

  @ApiEndpoint({
    returnedModel: AudioRecordingResponse,
    multi: true,
    path: ':id/recordings',
    by: ['id'],
  })
  @ApiParam({ name: 'id', description: 'Consultation ID' })
  async getRecordings(@Param('id') id: string): Promise<AudioRecordingResponse[]> {
    await this.verifyConsultationAccess(id);
    return this.contextService.getAudioRecordings(id);
  }

  @ApiEndpoint({
    returnedModel: ContextItemResponse,
    method: HttpMethod.PATCH,
    path: ':id/context/:contextId',
    by: ['id', 'contextId'],
  })
  @ApiParam({ name: 'id', description: 'Consultation ID' })
  @ApiParam({ name: 'contextId', description: 'Context Item ID' })
  async updateContext(
    @Param('id') id: string,
    @Param('contextId') contextId: string,
    @Body() request: UpdateContextRequest,
  ): Promise<ContextItemResponse> {
    await this.verifyConsultationOwnership(id);
    return this.contextService.updateContext(contextId, request);
  }

  // TASK-342 GAP #3 — soft-delete a context item (note / case-note / work-note
  // / attachment). Ownership-guarded like the other write routes; the service
  // performs the tenant-scoped soft-delete + ResourceDeleted broadcast.
  @ApiEndpoint({
    returnedModel: OkResponseDto,
    method: HttpMethod.DELETE,
    path: ':id/context/:contextId',
    by: ['id', 'contextId'],
    additionalData: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
        },
      },
    },
  })
  @ApiParam({ name: 'id', description: 'Consultation ID' })
  @ApiParam({ name: 'contextId', description: 'Context Item ID' })
  async deleteContext(@Param('id') id: string, @Param('contextId') contextId: string): Promise<OkResponseDto> {
    await this.verifyConsultationOwnership(id);
    await this.contextService.deleteContext(contextId);
    return new OkResponseDto();
  }

  // ─── Manual Highlights (TASK-344 Workstream B) ───────────────────
  // Doctor-authored highlights anchored to a persisted surface (transcript /
  // case note / work note / summary) via W3C dual selectors. A SEPARATE
  // aggregate from NamedEntity so manual marks never pollute the AI NER
  // aggregation. Writes are ownership-guarded; reads use the broader access
  // guard, mirroring the Context Item routes above.

  @ApiEndpoint({
    returnedModel: HighlightResponse,
    method: HttpMethod.POST,
    path: ':id/highlights',
    by: ['id'],
  })
  @ApiParam({ name: 'id', description: 'Consultation ID' })
  async createHighlight(@Param('id') id: string, @Body() request: CreateHighlightRequest): Promise<HighlightResponse> {
    await this.verifyConsultationOwnership(id);
    return this.highlightService.createHighlight(id, request);
  }

  @ApiEndpoint({
    returnedModel: HighlightResponse,
    multi: true,
    path: ':id/highlights',
    by: ['id'],
  })
  @ApiParam({ name: 'id', description: 'Consultation ID' })
  async getHighlights(@Param('id') id: string): Promise<HighlightResponse[]> {
    await this.verifyConsultationAccess(id);
    return this.highlightService.getHighlights(id);
  }

  @ApiEndpoint({
    returnedModel: OkResponseDto,
    method: HttpMethod.DELETE,
    path: ':id/highlights/:highlightId',
    by: ['id', 'highlightId'],
    additionalData: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
        },
      },
    },
  })
  @ApiParam({ name: 'id', description: 'Consultation ID' })
  @ApiParam({ name: 'highlightId', description: 'Highlight ID' })
  async deleteHighlight(@Param('id') id: string, @Param('highlightId') highlightId: string): Promise<OkResponseDto> {
    await this.verifyConsultationOwnership(id);
    await this.highlightService.deleteHighlight(id, highlightId);
    return new OkResponseDto();
  }

  @ApiEndpoint({
    returnedModel: ContextItemVersionResponse,
    multi: true,
    path: ':id/context/:contextId/versions',
    by: ['id', 'contextId'],
  })
  @ApiParam({ name: 'id', description: 'Consultation ID' })
  @ApiParam({ name: 'contextId', description: 'Context Item ID' })
  async getContextVersions(@Param('id') id: string, @Param('contextId') contextId: string): Promise<ContextItemVersionResponse[]> {
    await this.verifyConsultationAccess(id);
    return this.contextService.getVersionHistory(contextId);
  }

  @ApiEndpoint({
    returnedModel: ContextItemVersionResponse,
    path: ':id/context/:contextId/versions/:versionNumber',
    by: ['id', 'contextId', 'versionNumber'],
  })
  @ApiParam({ name: 'id', description: 'Consultation ID' })
  @ApiParam({ name: 'contextId', description: 'Context Item ID' })
  @ApiParam({ name: 'versionNumber', description: 'Version number', type: Number })
  async getContextVersion(
    @Param('id') id: string,
    @Param('contextId') contextId: string,
    @Param('versionNumber') versionNumber: string,
  ): Promise<ContextItemVersionResponse | null> {
    await this.verifyConsultationAccess(id);
    return this.contextService.getVersion(contextId, Number(versionNumber));
  }

  // ─── Summary ─────────────────────────────────────────────────────

  @ApiEndpoint({
    returnedModel: SummaryResponse,
    method: HttpMethod.POST,
    path: ':id/summary',
    by: ['id'],
  })
  @ApiParam({ name: 'id', description: 'Consultation ID' })
  async generateSummary(@Param('id') id: string, @Body() request: GenerateSummaryRequest): Promise<SummaryResponse> {
    await this.verifyConsultationOwnership(id);
    return this.summaryService.generateSummary(id, request);
  }

  @ApiEndpoint({
    returnedModel: SummaryResponse,
    multi: true,
    path: ':id/summary',
    by: ['id'],
  })
  @ApiParam({ name: 'id', description: 'Consultation ID' })
  async getSummaries(@Param('id') id: string): Promise<SummaryResponse[]> {
    await this.verifyConsultationAccess(id);
    return this.summaryService.getSummaries(id);
  }

  @ApiEndpoint({
    returnedModel: SummaryResponse,
    method: HttpMethod.POST,
    path: ':id/summary/pre-summary',
    by: ['id'],
  })
  @ApiParam({ name: 'id', description: 'Consultation ID' })
  async generatePreSummary(@Param('id') id: string, @Body() request: GeneratePreSummaryRequest): Promise<SummaryResponse> {
    await this.verifyConsultationOwnership(id);
    return this.summaryService.generatePreSummary(id, request);
  }

  @ApiEndpoint({
    returnedModel: SummaryResponse,
    path: ':id/summary/latest',
    by: ['id'],
  })
  @ApiParam({ name: 'id', description: 'Consultation ID' })
  async getLatestSummary(@Param('id') id: string): Promise<SummaryResponse | null> {
    await this.verifyConsultationAccess(id);
    return this.summaryService.getLatestSummary(id);
  }

  @ApiEndpoint({
    returnedModel: SummaryResponse,
    path: ':id/summary/pre-summary/latest',
    by: ['id'],
  })
  @ApiParam({ name: 'id', description: 'Consultation ID' })
  async getLatestPreSummary(@Param('id') id: string): Promise<SummaryResponse | null> {
    await this.verifyConsultationAccess(id);
    return this.summaryService.getLatestPreSummary(id);
  }

  @ApiEndpoint({
    returnedModel: SummaryResponse,
    method: HttpMethod.PATCH,
    path: ':id/summary/:summaryId',
    by: ['id', 'summaryId'],
  })
  @ApiParam({ name: 'id', description: 'Consultation ID' })
  @ApiParam({ name: 'summaryId', description: 'Summary Context Item ID' })
  async updateSummary(
    @Param('id') id: string,
    @Param('summaryId') summaryId: string,
    @Body() request: UpdateSummaryRequest,
  ): Promise<SummaryResponse> {
    await this.verifyConsultationOwnership(id);
    return this.summaryService.updateSummary(summaryId, request);
  }

  @ApiEndpoint({
    returnedModel: ContextItemVersionResponse,
    multi: true,
    path: ':id/summary/:contextItemId/versions',
    by: ['id', 'contextItemId'],
  })
  @ApiParam({ name: 'id', description: 'Consultation ID' })
  @ApiParam({ name: 'contextItemId', description: 'Summary Context Item ID' })
  async getSummaryVersions(@Param('id') id: string, @Param('contextItemId') contextItemId: string): Promise<ContextItemVersionResponse[]> {
    await this.verifyConsultationAccess(id);
    return this.contextService.getVersionHistory(contextItemId);
  }

  // TASK-330 follow-up — read-only harness provenance (citationsMap + sensor
  // scores + modelName) for a generated summary. Normal clinician auth (inherits
  // the class-level @Authorize() + verifyConsultationAccess read gate); NOT the
  // service-to-service HarnessServiceTokenGuard.
  @ApiEndpoint({
    returnedModel: SummaryProvenanceResponse,
    path: ':id/summary/:contextItemId/provenance',
    by: ['id', 'contextItemId'],
  })
  @ApiParam({ name: 'id', description: 'Consultation ID' })
  @ApiParam({ name: 'contextItemId', description: 'Summary Context Item ID' })
  async getSummaryProvenance(@Param('id') id: string, @Param('contextItemId') contextItemId: string): Promise<SummaryProvenanceResponse> {
    await this.verifyConsultationAccess(id);
    return this.summaryService.getSummaryProvenance(contextItemId);
  }

  // TASK-329 (P6) — diff two summary versions; the UI version-diff-panel renders the result
  @ApiEndpoint({
    returnedModel: VersionDiffResponse,
    path: ':id/summary/:contextItemId/diff',
    by: ['id', 'contextItemId'],
  })
  @ApiParam({ name: 'id', description: 'Consultation ID' })
  @ApiParam({ name: 'contextItemId', description: 'Summary Context Item ID' })
  @ApiQuery({ name: 'from', description: 'Earlier version number', type: Number })
  @ApiQuery({ name: 'to', description: 'Later version number', type: Number })
  async diffSummaryVersions(
    @Param('id') id: string,
    @Param('contextItemId') contextItemId: string,
    @Query('from') from: string,
    @Query('to') to: string,
  ): Promise<VersionDiffResponse> {
    await this.verifyConsultationAccess(id);
    return this.contextService.diffVersions(contextItemId, Number(from), Number(to));
  }

  // ─── Summary Tags (TASK-329) ─────────────────────────────────────

  @ApiEndpoint({
    returnedModel: TagResponse,
    multi: true,
    path: ':id/summary/:contextItemId/tags',
    by: ['id', 'contextItemId'],
  })
  @ApiParam({ name: 'id', description: 'Consultation ID' })
  @ApiParam({ name: 'contextItemId', description: 'Summary Context Item ID' })
  async getSummaryTags(@Param('id') id: string, @Param('contextItemId') contextItemId: string): Promise<TagResponse[]> {
    await this.verifyConsultationAccess(id);
    const tags = await this.tagService.fetchByResource(ResourceType.ContextItem, contextItemId);
    return tags.map((tag) => TagDtoMapper.ToResponse(tag));
  }

  @ApiEndpoint({
    returnedModel: TagResponse,
    method: HttpMethod.POST,
    path: ':id/summary/:contextItemId/tags',
    by: ['id', 'contextItemId'],
  })
  @ApiParam({ name: 'id', description: 'Consultation ID' })
  @ApiParam({ name: 'contextItemId', description: 'Summary Context Item ID' })
  async tagSummary(@Param('id') id: string, @Param('contextItemId') contextItemId: string, @Body() body: CreateTagRequest): Promise<TagResponse> {
    await this.verifyConsultationOwnership(id);
    // Server controls the polymorphic target + tenant; client-supplied values are ignored.
    const created = await this.tagService.create({
      ...body,
      resourceTypeName: ResourceType.ContextItem,
      resourceId: contextItemId,
      tenantId: this.cls.get('tenantId') ?? undefined,
    });
    return TagDtoMapper.ToResponse(created);
  }

  @ApiEndpoint({
    returnedModel: OkResponseDto,
    method: HttpMethod.DELETE,
    path: ':id/summary/:contextItemId/tags/:tagId',
    by: ['id', 'contextItemId', 'tagId'],
    additionalData: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
        },
      },
    },
  })
  @ApiParam({ name: 'id', description: 'Consultation ID' })
  @ApiParam({ name: 'contextItemId', description: 'Summary Context Item ID' })
  @ApiParam({ name: 'tagId', description: 'Tag ID' })
  async deleteSummaryTag(
    @Param('id') id: string,
    @Param('contextItemId') contextItemId: string,
    @Param('tagId') tagId: string,
  ): Promise<OkResponseDto> {
    await this.verifyConsultationOwnership(id);
    // Ensure the tag actually belongs to this summary before deleting (tenant-scoped fetch).
    const tag = await this.tagService.fetchById(tagId);
    if (tag.resourceId !== contextItemId) {
      throw new NotFoundException('Tag not found for this summary');
    }
    await this.tagService.deleteById(tagId);
    return new OkResponseDto();
  }

  @ApiEndpoint({
    returnedModel: OkResponseDto,
    method: HttpMethod.POST,
    path: ':id/summary/:contextItemId/extract-entities',
    by: ['id', 'contextItemId'],
    additionalData: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
        },
      },
    },
  })
  @ApiParam({ name: 'id', description: 'Consultation ID' })
  @ApiParam({ name: 'contextItemId', description: 'Summary Context Item ID' })
  async extractEntities(@Param('id') id: string, @Param('contextItemId') contextItemId: string): Promise<OkResponseDto> {
    await this.verifyConsultationOwnership(id);
    await this.summaryService.extractEntities(contextItemId);
    return new OkResponseDto();
  }

  @ApiEndpoint({
    returnedModel: AsyncJobResponseDto,
    method: HttpMethod.POST,
    path: ':id/summary/async',
    by: ['id'],
  })
  @ApiParam({ name: 'id', description: 'Consultation ID' })
  async generateSummaryAsync(@Param('id') consultationId: string, @Body() request: GenerateSummaryRequest): Promise<AsyncJobResponseDto> {
    await this.verifyConsultationOwnership(consultationId);
    const tenantId = this.cls.get('tenantId') ?? 'unknown';
    const userId = this.getDoctorId();
    /* eslint-disable @typescript-eslint/no-explicit-any */
    const job = await this.consultationJobService.createSummaryJob(
      consultationId,
      tenantId,
      userId,
      {
        dnaStyleId: (request as any)?.dnaStyleId,
        template: (request as any)?.template,
        includeNER: (request as any)?.includeNER,
        contextItemIds: (request as any)?.contextItemIds,
        options: (request as any)?.options,
      },
      undefined,
      // TASK-299 D-10 — forward the SDK-supplied idempotency key.
      (request as any)?.idempotencyKey,
    );
    /* eslint-enable @typescript-eslint/no-explicit-any */
    return new AsyncJobResponseDto({
      jobId: job.jobId,
      status: 'pending',
      consultationId,
      createdAt: new Date().toISOString(),
    });
  }

  @ApiEndpoint({
    returnedModel: AsyncJobResponseDto,
    method: HttpMethod.POST,
    path: ':id/summary/pre-summary/async',
    by: ['id'],
  })
  @ApiParam({ name: 'id', description: 'Consultation ID' })
  async generatePreSummaryAsync(@Param('id') consultationId: string, @Body() request: GeneratePreSummaryRequest): Promise<AsyncJobResponseDto> {
    await this.verifyConsultationOwnership(consultationId);
    const tenantId = this.cls.get('tenantId') ?? 'unknown';
    const userId = this.getDoctorId();
    /* eslint-disable @typescript-eslint/no-explicit-any */
    const job = await this.consultationJobService.createPreSummaryJob(
      consultationId,
      tenantId,
      userId,
      {
        dnaStyleId: (request as any)?.dnaStyleId,
        caseNoteIds: (request as any)?.caseNoteIds,
        options: (request as any)?.options,
      },
      undefined,
      // TASK-299 D-10 — forward the SDK-supplied idempotency key.
      (request as any)?.idempotencyKey,
    );
    /* eslint-enable @typescript-eslint/no-explicit-any */
    return new AsyncJobResponseDto({
      jobId: job.jobId,
      status: 'pending',
      consultationId,
      createdAt: new Date().toISOString(),
    });
  }

  @ApiEndpoint({
    returnedModel: ComprehensiveSummaryResponseDto,
    method: HttpMethod.POST,
    path: ':id/summary/comprehensive',
    by: ['id'],
  })
  @ApiParam({ name: 'id', description: 'Consultation ID' })
  async generateComprehensiveSummary(
    @Param('id') consultationId: string,
    @Body() request: ComprehensiveSummaryRequest,
  ): Promise<{
    id: string;
    content: string;
    consultationIds: string[];
    createdAt: string;
    modelName?: string;
    processingTimeMs?: number;
    dnaStyleId?: string;
  }> {
    await this.verifyConsultationOwnership(consultationId);
    const result = await this.chainSummaryService.generateComprehensiveSummary(consultationId, request);

    return {
      id: result.id,
      content: result.content,
      consultationIds: result.sourceConsultationIds,
      createdAt: result.createdAt,
      modelName: result.structuredData?.modelName,
      processingTimeMs: result.structuredData?.processingTimeMs,
      dnaStyleId: request.dnaStyleId,
    };
  }

  @ApiEndpoint({
    returnedModel: ComprehensiveSummaryResponseDto,
    method: HttpMethod.POST,
    path: ':id/summary/comprehensive/async',
    by: ['id'],
  })
  @ApiParam({ name: 'id', description: 'Consultation ID' })
  async generateComprehensiveSummaryAsync(
    @Param('id') consultationId: string,
    @Body() request: ComprehensiveSummaryRequest,
  ): Promise<AsyncJobResponseDto> {
    await this.verifyConsultationOwnership(consultationId);
    const tenantId = this.cls.get('tenantId') ?? 'unknown';
    const userId = this.getDoctorId();
    const job = await this.consultationJobService.createComprehensiveSummaryJob(
      consultationId,
      tenantId,
      userId,
      {
        dnaStyleId: request.dnaStyleId,
        template: request.template,
        includeNER: request.includeNER,
        includeLabResults: request.includeLabResults,
        options: request.options,
      },
      undefined,
      // TASK-299 D-10 — forward the SDK-supplied idempotency key.
      request.idempotencyKey,
    );
    return new AsyncJobResponseDto({
      jobId: job.jobId,
      status: 'pending',
      consultationId,
      createdAt: new Date().toISOString(),
    });
  }

  @ApiEndpoint({
    returnedModel: SummaryApprovalResponseDto,
    method: HttpMethod.POST,
    path: ':id/summary/:contextItemId/approve',
    by: ['id', 'contextItemId'],
  })
  @ApiParam({ name: 'id', description: 'Consultation ID' })
  @ApiParam({ name: 'contextItemId', description: 'Summary Context Item ID' })
  async approveSummary(
    @Param('id') id: string,
    @Param('contextItemId') contextItemId: string,
    // TASK-355 Phase D Slice 6a — optional one-click safety-flag override (Q4).
    @Body() body?: SummaryApprovalRequest,
  ): Promise<SummaryApprovalResponseDto> {
    await this.verifyConsultationOwnership(id);
    const result = await this.summaryService.approveSummary(contextItemId, { overrideSafetyFlag: body?.overrideSafetyFlag });
    return new SummaryApprovalResponseDto(result);
  }

  // ─── Named Entities ──────────────────────────────────────────────

  @ApiEndpoint({
    returnedModel: AggregateNerResponse,
    path: ':id/named-entities',
    by: ['id'],
  })
  @ApiParam({ name: 'id', description: 'Consultation ID' })
  @ApiQuery({ name: 'scope', required: false, enum: ['single', 'chain'] })
  async getNamedEntities(@Param('id') id: string, @Query('scope') scope?: 'single' | 'chain'): Promise<AggregateNerResponse> {
    await this.verifyConsultationAccess(id);
    return this.contextService.getAggregateNamedEntities(id, scope ?? 'single');
  }
}
