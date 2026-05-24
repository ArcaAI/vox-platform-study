import {
  IConsultationService,
  IContextService,
  ISummaryService,
  TimelineService,
  ComprehensiveSummaryRequest,
  OpenConsultationRequest,
  ConsultationResponse,
  PaginatedConsultationResponse,
  AddContextRequest,
  UpdateContextRequest,
  ContextItemResponse,
  ContextItemVersionResponse,
  ComprehensiveSummaryResponse as ComprehensiveSummaryResponseDto,
  GenerateSummaryRequest,
  GeneratePreSummaryRequest,
  UpdateSummaryRequest,
  SummaryResponse,
  AggregateNerResponse,
  ConsultationTimelineResponse,
  PaginatedQuery,
  HttpMethod,
  PolicyEngine,
  AppAbility,
} from '@arcaai/applications';
import { Controller, Body, Param, Inject, Query, ForbiddenException, NotFoundException, UnauthorizedException, Logger } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiParam, ApiProperty, ApiPropertyOptional, ApiQuery, ApiResponse } from '@nestjs/swagger';
import { ApiEndpoint, Authorize } from '../../decorators';
import { ClsService } from 'nestjs-cls';
import type { IActiveUserContext } from '@arcaai/applications';
import { ChainSummaryService } from '@arcaai/applications';
import { IConsultationJobService } from '@arcaai/applications';
import { GlobalSettingRepository } from '@arcaai/domains';

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
      const setting = settings[0];
      if (!setting) return true;
      return setting.value !== 'false';
    } catch {
      return true;
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
  async approveSummary(@Param('id') id: string, @Param('contextItemId') contextItemId: string): Promise<SummaryApprovalResponseDto> {
    await this.verifyConsultationOwnership(id);
    const result = await this.summaryService.approveSummary(contextItemId);
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
