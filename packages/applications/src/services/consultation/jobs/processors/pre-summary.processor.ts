import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, Logger, Optional } from '@nestjs/common';
import { Job } from 'bullmq';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { ClsService } from 'nestjs-cls';
import { JobQueue, ContextItemRepository, ConsultationRepository, ContextItemFactory, ContextItemType } from '@arcaai/domains';
import { IConsultationJobService } from '../consultation-job.service';
import { GeneratePreSummaryJobPayload, PreSummaryJobResult } from '../dto';
import { PromptResolutionService, type PromptResolutionTier } from '../../prompt/prompt-resolution.service';
import { PromptAssemblyService } from '../../prompt/prompt-assembly.service';
import { JobMetricsService } from '../../../baseServices/observability/job-metrics.service';
import { SecretsService } from '../../../baseServices/_meta/secrets';
import { buildTextGeneratePayload, mapTextGenerateResponse } from '../../summary/text-generate';
import { HarnessPolicyService } from '../../../harness-policy/harness-policy.service';
import { TextRequestEnrichmentService } from '../../../text-request/text-request-enrichment.service';
import { ConfigResolver } from '../../../config-resolver';
import { IActiveUserContext } from '../../../../interfaces';
import {
  TENANTLESS,
  assertEqualTenants,
  createWorkerSession,
  encryptPhiFields,
  internalServiceHeaders,
  resolveInternalAccessToken,
} from '../../../../common';
import { INoteGenerationService, GenerationTrigger } from '../../note-generation';
import { DEFAULT_VISIT_TYPE_SERVICE, VisitTypeService, type VisitTypeDefinition } from '../../visit-type/visit-type.service';

// boundary (owner decision,: KEPT,
// un-gated, as an explicitly non-signable helper generator — never had a
// harness equivalent (`GenerationTrigger.PRE_SUMMARY` is not in
// `HARNESS_SUPPORTED_TRIGGERS`), and its output type (`PRE_SUMMARY`) never
// satisfies `ContextItemEntity.isFinalSummary`, so it structurally cannot
// reach `SummaryService.approveSummary` — confirmed by
// `jobs/processors/__tests__/kept-generators-signability.task732.test.ts`.
// Becomes the "pre-summary" half of a future standalone v1-compat feature.
@Processor(JobQueue.GeneratePreSummary)
export class PreSummaryProcessor extends WorkerHost {
  private readonly logger = new Logger(PreSummaryProcessor.name);
  private readonly textServiceUrl: string;

  constructor(
    @Inject(IConsultationJobService) private readonly jobService: IConsultationJobService,
    private readonly contextItemRepository: ContextItemRepository,
    private readonly consultationRepository: ConsultationRepository,
    private readonly httpService: HttpService,
    private readonly configService: ConfigService,
    private readonly promptResolutionService: PromptResolutionService,
    private readonly promptAssemblyService: PromptAssemblyService,
    private readonly jobMetrics: JobMetricsService,
    private readonly cls: ClsService<IActiveUserContext>,
    @Optional() @Inject(SecretsService) private readonly secretsService?: SecretsService,
    // Resolver for the tenant's effective TEXT {provider, model}.
    @Optional() @Inject(HarnessPolicyService) private readonly harnessPolicyService?: HarnessPolicyService,
    // Load the consulting doctor's preferred prompt id so the
    // pre-summary BullMQ path threads it (was previously dropped here, unlike
    // summary.processor). Optional + trailing so existing positional fixtures
    // keep compiling.
    @Optional() @Inject(ConfigResolver) private readonly configResolver?: ConfigResolver,
    // pre-summary has no harness equivalent today (the
    // ticket); this call exists purely to make the harnessEnabled read
    // happen through the single seam and get the decision logged — the
    // decision is always 'legacy'/'harness-not-supported-for-trigger' and
    // this processor's generation body always runs regardless. Optional +
    // trailing so existing positional fixtures keep compiling.
    @Optional() @Inject(INoteGenerationService) private readonly noteGenerationService?: INoteGenerationService,
    // the SHARED TEXT enrichment path. Since lane B
    // (`70eec34d5`) removed TEXT's per-provider env plane, a `/api/v1/generate`
    // body with no `provider_overrides` entry fails closed with 503
    // PROVIDER_CREDENTIALS_MISSING. Optional + trailing so existing positional
    // fixtures keep their arity.
    @Optional() @Inject(TextRequestEnrichmentService) private readonly textRequestEnrichment?: TextRequestEnrichmentService,
    // the tenant's VISIT-TYPE catalogue, which replaces the
    // `parentConsultationId ? 'revisit': 'new-patient'` literal below. Optional
    // + trailing so existing positional fixtures keep their arity; an unwired
    // resolver serves the two shipped visit types, whose keys and follow-up rule
    // are byte-identical to the ternary it replaces.
    @Optional() @Inject(VisitTypeService) private readonly visitTypes?: VisitTypeService,
  ) {
    super();
    this.textServiceUrl = this.configService.get<string>('TEXT_URL') ?? 'http://localhost:8862';
  }

  /**
   * Encrypt PHI on write through the shared env-gated guard: a soft
   * no-op in dev/test (SECRETS_PROVIDER!=vault) but FAIL-CLOSED (throws) in
   * staging/prod (SECRETS_PROVIDER=vault) instead of persisting plaintext-only.
   */
  private async encryptBestEffort(label: string, run: () => Promise<void>): Promise<void> {
    await encryptPhiFields(this.secretsService, label, run, this.logger);
  }

  async process(job: Job<GeneratePreSummaryJobPayload>): Promise<PreSummaryJobResult> {
    const { jobId, consultationId, tenantId, userId } = job.data;
    // Fail-closed when tenantId is missing.
    if (!tenantId) {
      throw new Error(`Job ${jobId ?? job.id} is missing required tenantId`);
    }
    // Rebind tenantId + user into a fresh CLS scope so the
    // tenantScope Prisma extension sees the correct context.
    return this.cls.run(async () => {
      this.cls.set('tenantId', tenantId);
      this.cls.set('user', createWorkerSession({ userId, tenantId, kind: 'pre-summary' }));

      const request = job.data.request;
      const endTimer = this.jobMetrics.recordJobStart(JobQueue.GeneratePreSummary);
      const waitMs = Date.now() - job.timestamp;
      this.jobMetrics.recordWaitingDuration(JobQueue.GeneratePreSummary, waitMs / 1000);

      this.logger.log({
        message: 'Processing pre-summary job',
        jobId,
        consultationId,
      });

      try {
        // route the harnessEnabled read through the single seam.
        // Pre-summary has no harness equivalent (the ticket) — the
        // decision is always 'legacy', logged, and this generation body
        // always runs. Never blocks/short-circuits generation.
        if (this.noteGenerationService) {
          await this.noteGenerationService.generate(GenerationTrigger.PRE_SUMMARY, { consultationId, tenantId, userId });
        }

        // Step 1: Gathering case notes (10%)
        await this.jobService.notifyProgress(jobId, 10, 'Gathering case notes');

        const consultation = await this.consultationRepository.findById(consultationId);
        if (!consultation) {
          throw new Error(`Consultation ${consultationId} not found`);
        }
        // Defense in depth against a poisoned / stale payload.
        assertEqualTenants(consultation, { tenantId });

        // Resolve the consulting doctor's preferred prompt id once so
        // BOTH the prompt resolution and assembly thread it (the pre-summary path
        // previously dropped it). Null-safe + no-op when the resolver isn't wired.
        const preferredPromptTemplateId = this.configResolver
          ? await this.configResolver.resolvePreferredPromptTemplateId(consultation.doctorId ?? null)
          : undefined;

        // Resolve prompt config for pre-summary
        // DNA style is per-doctor and resolved separately — not part of prompt resolution.
        const resolved = await this.promptResolutionService.resolve({
          departmentId: consultation.departmentId ?? undefined,
          // The pre-summary chain has no department axis: without the tenant a
          // job on a consultation with NO department skips the tenant tier and
          // lands on the SYSTEM default (or a 503).
          tenantId: consultation.tenantId,
          promptType: 'pre-summary',
          // Native callers resolve the department-free fork;
          // v1-compat is the ONLY surface that keeps the v1-parity body (RF-1).
          preSummaryVariant: 'dept-free',
          preferredPromptTemplateId: preferredPromptTemplateId ?? undefined,
        });

        this.logger.debug({
          message: 'Prompt config resolved for pre-summary job',
          jobId,
          resolvedFrom: resolved.resolvedFrom,
          template: resolved.template,
        });

        // Get case notes from the consultation chain
        let content = '';
        if (request.caseNoteIds?.length) {
          // Use specific case notes
          const caseNotes = await Promise.all(request.caseNoteIds.map((id) => this.contextItemRepository.findById(id)));
          content = caseNotes
            .filter(Boolean)
            .map((c) => c!.content)
            .join('\n\n');
        } else {
          // Get all case notes from the consultation
          const caseNotes = await this.contextItemRepository.findByConsultation(consultationId, { type: ContextItemType.CASE_NOTE });
          content = caseNotes.map((c) => c.content).join('\n\n');
        }

        if (!content.trim()) {
          throw new Error('No case notes available for pre-summary generation');
        }

        const assembledPrompt = await this.promptAssemblyService.assemble({
          departmentId: consultation.departmentId ?? undefined,
          // Same reason as the resolve() above — assemble() runs its OWN
          // resolution, and that is the one whose body reaches the LLM.
          tenantId: consultation.tenantId,
          promptType: 'pre-summary',
          // Native callers resolve the department-free fork;
          // v1-compat is the ONLY surface that keeps the v1-parity body (RF-1).
          preSummaryVariant: 'dept-free',
          // v1 `{visit_type}`. `parentConsultationId` is the consultation's own
          // follow-up signal; the LABEL comes from the platform's visit types.
          visitType: this.visitType(consultation).label,
          transcript: content,
          conversationLanguage: this.resolveConversationLanguage(request.options),
          dnaStyleId: request.dnaStyleId,
          // Thread the doctor-preferred prompt id into assembly.
          preferredPromptTemplateId: preferredPromptTemplateId ?? undefined,
        });

        // Step 2: Calling AI service (30%)
        await this.jobService.notifyProgress(jobId, 30, 'Generating pre-summary with AI');

        const textResponse = await this.callTextService(
          assembledPrompt,
          {
            ...request,
            options: {
              ...request.options,
              promptResolvedFrom: assembledPrompt.resolvedFrom,
              promptHyperparameters: assembledPrompt.hyperparameters,
            },
          },
          tenantId,
          jobId,
        );

        // Step 3: Saving results (70%)
        await this.jobService.notifyProgress(jobId, 70, 'Saving results');

        const contextItem = ContextItemFactory.CreatePreSummary(tenantId, consultationId, textResponse.summary, request.dnaStyleId, userId);

        // Encrypt the generated pre-summary text into `encryptedContent`
        // before persistence — the plaintext `content` column was dropped by the
        // PHI field-encryption migration, so an unencrypted create silently loses
        // the clinical text at rest (mirrors context.service.ts `encryptContent`).
        await this.encryptBestEffort('ContextItem content', () =>
          this.contextItemRepository.encryptContentIntoEntity(contextItem, this.secretsService!),
        );

        const savedContext = await this.contextItemRepository.create(contextItem);

        // Step 4: Complete (100%)
        const result: PreSummaryJobResult = {
          contextItemId: savedContext.id,
          content: savedContext.content,
          summaryMeta: {
            aiModelId: textResponse.modelName,
            processingTimeMs: textResponse.processingTimeMs,
            inputTokens: textResponse.inputTokens,
            outputTokens: textResponse.outputTokens,
          },
        };

        await this.jobService.notifyComplete(jobId, result);

        const duration = endTimer();
        this.jobMetrics.recordJobComplete(JobQueue.GeneratePreSummary, 'PreSummaryProcessor', duration);

        this.logger.log({
          message: 'Pre-summary job completed',
          jobId,
          contextItemId: savedContext.id,
          processingTimeMs: textResponse.processingTimeMs,
        });

        return result;
      } catch (error) {
        endTimer();
        this.jobMetrics.recordJobFailed(
          JobQueue.GeneratePreSummary,
          'PreSummaryProcessor',
          error instanceof Error ? error.constructor.name : 'UnknownError',
        );
        const errorMessage = error instanceof Error ? error.message : String(error);
        this.logger.error({
          message: 'Pre-summary job failed',
          jobId,
          error: errorMessage,
        });
        await this.jobService.notifyFailed(jobId, errorMessage);
        throw error;
      }
    });
  }

  private async callTextService(
    assembledPrompt: {
      userPrompt: string;
      systemPrompt: string;
      hyperparameters: Record<string, number>;
      responseFormat: {
        type: string;
        json_schema: Record<string, unknown>;
        strict: boolean;
      } | null;
      resolvedFrom: PromptResolutionTier;
    },
    request: GeneratePreSummaryJobPayload['request'],
    // The tenant id `process` already fail-closed
    // validated (job.data.tenantId) is threaded through EXPLICITLY here
    // rather than trusting `resolveTextSelection()`'s own CLS fallback, so
    // this call can never silently serve the SYSTEM default model.
    tenantId: string,
    jobId?: string,
  ): Promise<{
    summary: string;
    llmProvider?: string;
    modelName?: string;
    processingTimeMs?: number;
    inputTokens?: number;
    outputTokens?: number;
  }> {
    try {
      const textStart = Date.now();
      // Resolve the tenant's effective {provider, model} and merge as the
      // base so a caller-supplied model wins.
      let options = request.options;
      if (this.harnessPolicyService) {
        const { provider, model } = await this.harnessPolicyService.resolveTextSelection(tenantId, 'finalize');
        options = { textProvider: provider, textModel: model, ...request.options };
      }
      const textPayload = buildTextGeneratePayload(assembledPrompt, options, {
        dnaStyleId: request.dnaStyleId,
        summaryType: 'pre-summary',
      });
      // inject the tenant's resolved provider credential through the
      // ONE shared implementation (tenant → SYSTEM cascade, `funding` label
      // carried so metering is derived from the supplying row). `process()`
      // rebinds `tenantId` into a fresh CLS scope above, which is where the
      // resolver reads it from.
      // layer the platform admin's runtime profile (hyperparameters + engine
      // extras such as `reasoning_effort`) BEFORE the credential fold, exactly as the
      // TEXT proxy does. Caller-set fields win; a resolver error injects nothing.
      await this.textRequestEnrichment?.applyTextRuntimeProfile(textPayload as { provider?: string; model?: string });
      await this.textRequestEnrichment?.applyTenantProviderOverrides(textPayload as { provider?: string });
      // D-D: the ONE shared `INTERNAL_ACCESS_TOKEN` (`TEXT_SERVICE_TOKEN` is only the
      // migration fallback).: `X-Tenant-Id` is MANDATORY — `tenantId` is the
      // fail-closed-validated `job.data.tenantId` already threaded in above and used
      // one line earlier for `resolveTextSelection`, then dropped before the HTTP call,
      // so Text resolved the platform default provider for a job that HAS a tenant.
      const serviceToken = await resolveInternalAccessToken(this.secretsService, 'TEXT_SERVICE_TOKEN');
      const response = await this.httpService.axiosRef.post(`${this.textServiceUrl}/api/v1/generate`, textPayload, {
        timeout: 120000,
        headers: internalServiceHeaders({
          serviceToken,
          tenantId,
          tenantlessReason: TENANTLESS.JOB_QUEUE,
          extra: jobId ? { 'X-Request-ID': jobId } : undefined,
        }),
      });
      this.jobMetrics.recordTextCallDuration(JobQueue.GeneratePreSummary, 'text', (Date.now() - textStart) / 1000);
      return mapTextGenerateResponse(response.data);
    } catch (error) {
      this.logger.error({
        message: 'TEXT service call failed',
        error: error instanceof Error ? error.message : String(error),
      });
      throw new Error('Failed to generate pre-summary from AI service');
    }
  }

  private resolveConversationLanguage(options?: Record<string, unknown>): string {
    const candidate = options?.conversationLanguage ?? options?.language ?? options?.locale;

    return typeof candidate === 'string' && candidate.trim().length > 0 ? candidate : 'en';
  }

  /**
   * The consultation's visit type — one of the platform's two, selected by the
   * consultation's own follow-up signal (`parentConsultationId`) through the one
   * vocabulary every caller shares rather than a literal repeated at each call site.
   */
  private visitType(consultation: { tenantId?: string | null; parentConsultationId?: string | null }): VisitTypeDefinition {
    return (this.visitTypes ?? DEFAULT_VISIT_TYPE_SERVICE).forConsultation(consultation.tenantId ?? null, {
      isFollowUp: Boolean(consultation.parentConsultationId),
    });
  }
}
