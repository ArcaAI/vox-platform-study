import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, Logger, Optional } from '@nestjs/common';
import { ITenantLockService } from '../../../tenant-checkpoint/contracts';
import { postponeIfTenantLocked } from '../../../../common/worker-session-lock';
import { Job } from 'bullmq';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { ClsService } from 'nestjs-cls';
import { JobQueue, ContextItemRepository, ConsultationRepository, ContextItemFactory, ContextItemType } from '@arcaai/domains';
import { IConsultationJobService } from '../consultation-job.service';
import { GeneratePreSummaryJobPayload, PreSummaryJobResult } from '../dto';
import { PromptResolutionService, type PromptResolutionTier } from '../../prompt/prompt-resolution.service';
import { PromptAssemblyService } from '../../prompt/prompt-assembly.service';
import { clientCaseNoteRenderings, clientClinicalContextReaderFor } from '../../context/client-clinical-context';
import { JobMetricsService } from '../../../baseServices/observability/job-metrics.service';
import { SecretsService } from '../../../baseServices/_meta/secrets';
import { buildTextGeneratePayload, mapTextGenerateResponse, withoutCallerModelSelection } from '../../summary/text-generate';
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
import { readRecordedVisitType } from '../../consultation/open-markers';
import { QUEUE_CONCURRENCY } from '../../../baseServices/redis/queue-concurrency';
import { EffectiveSettingsService } from '../../../settings-registry/effective-settings.service';
import { resolvePlatformOutputLanguage } from '../../summary/platform-output-language';
import { runJobInContext } from '../../../baseServices/observability/job-context';

// boundary (owner decision,: KEPT,
// un-gated, as an explicitly non-signable helper generator — never had a
// harness equivalent (`GenerationTrigger.PRE_SUMMARY` is not in
// `HARNESS_SUPPORTED_TRIGGERS`), and its output type (`PRE_SUMMARY`) never
// satisfies `ContextItemEntity.isFinalSummary`, so it structurally cannot
// reach `SummaryService.approveSummary` — confirmed by
// `jobs/processors/__tests__/kept-generators-signability.task732.test.ts`.
// TASK-993 lane D — concurrency is DECLARED, not inherited. Every processor
// ran at bullmq's default of 1 because no `@Processor` passed options; the
// number, and the Prisma-pool budget it fits inside, live in one table.
@Processor(JobQueue.GeneratePreSummary, { concurrency: QUEUE_CONCURRENCY[JobQueue.GeneratePreSummary] })
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
    // ticket); this call exists purely to make the generator decision
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
    // TASK-1001 (OD-12) — resolves `consultation.summary.outputLanguage`, the platform-default
    // language the pre-summary is WRITTEN in. Optional + trailing so the positional fixtures keep
    // their arity; unwired ⇒ the descriptor's code default (English).
    @Optional() @Inject(EffectiveSettingsService) private readonly effectiveSettings?: EffectiveSettingsService,
    // Postpones the job while a restore holds the tenant's lock. Optional + trailing so positional fixtures keep their arity.
    @Optional() @Inject(ITenantLockService) private readonly tenantLock?: ITenantLockService,
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

  async process(job: Job<GeneratePreSummaryJobPayload>, token?: string): Promise<PreSummaryJobResult> {
    const { jobId, consultationId, tenantId, userId } = job.data;
    // Fail-closed when tenantId is missing.
    if (!tenantId) {
      throw new Error(`Job ${jobId ?? job.id} is missing required tenantId`);
    }
    await postponeIfTenantLocked(this.tenantLock, job, token, tenantId, ['CLINICAL']);
    // Rebind tenantId + user into a fresh CLS scope so the
    // tenantScope Prisma extension sees the correct context.
    return runJobInContext(this.cls, job, async () => {
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
        // route the generator decision through the single seam.
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

        // TASK-1034 R3 — the requested DNA style id applies only when the style is EFFECTIVE (the
        // governing graph's style declaration AND the doctor's opt-in). It used to pass ungated.
        const dnaStyleId = await this.resolveEffectiveDnaStyleId(consultation, request.dnaStyleId);

        // Resolve prompt config for pre-summary
        // DNA style is per-doctor and resolved separately — not part of prompt resolution.
        const resolved = await this.promptResolutionService.resolve({
          departmentId: consultation.departmentId ?? undefined,
          // The pre-summary chain has no department axis: without the tenant a
          // job on a consultation with NO department skips the tenant tier and
          // lands on the SYSTEM default (or a 503).
          tenantId: consultation.tenantId,
          promptType: 'pre-summary',
          // The department-free fork. The v1-parity body (the resolver's `'v1'`
          // default) existed for the v1-compat surface, which is gone (TASK-1004).
          preSummaryVariant: 'dept-free',
          preferredPromptTemplateId: preferredPromptTemplateId ?? undefined,
        });

        this.logger.debug({
          message: 'Prompt config resolved for pre-summary job',
          jobId,
          resolvedFrom: resolved.resolvedFrom,
          template: resolved.template,
        });

        // Get case notes from the consultation chain. Kept as SEPARATE records rather than one
        // joined string: the prompt now carries them as a list, and the de-duplication below
        // compares whole notes — re-splitting a join would cut a note that contains a blank line.
        let caseNoteTexts: string[];
        if (request.caseNoteIds?.length) {
          // Use specific case notes
          const caseNotes = await Promise.all(request.caseNoteIds.map((id) => this.contextItemRepository.findById(id)));
          caseNoteTexts = caseNotes.filter(Boolean).map((c) => c!.content ?? '');
        } else {
          // Get all case notes from the consultation
          const caseNotes = await this.contextItemRepository.findByConsultation(consultationId, { type: ContextItemType.CASE_NOTE });
          caseNoteTexts = caseNotes.map((c) => c.content ?? '');
        }

        if (!caseNoteTexts.join('\n\n').trim()) {
          throw new Error('No case notes available for pre-summary generation');
        }

        // What the CLIENT stated at `open` — measured vitals and a prior-visit history. Read
        // after the "is there anything to summarise" guard, which is still asked of the
        // case-note records as they stand.
        const client = await clientClinicalContextReaderFor(this.contextItemRepository, this.secretsService).read(consultationId);
        // A note the client sent under `previous_case_notes` is persisted twice at open — as the
        // structured kind AND as one `CASE_NOTE` per entry — and the prior-visit history already
        // carries it. Without this the same note reaches the model under two headings.
        const duplicated = client.previousVisits ? clientCaseNoteRenderings(client.raw.previousVisits) : null;
        const promptCaseNotes = caseNoteTexts.map((text) => text.trim()).filter((text) => text.length > 0 && !duplicated?.has(text));

        const assembledPrompt = await this.promptAssemblyService.assemble({
          departmentId: consultation.departmentId ?? undefined,
          vitals: client.vitals,
          previousVisits: client.previousVisits,
          // Same reason as the resolve() above — assemble() runs its OWN
          // resolution, and that is the one whose body reaches the LLM.
          tenantId: consultation.tenantId,
          promptType: 'pre-summary',
          // The department-free fork. The v1-parity body (the resolver's `'v1'`
          // default) existed for the v1-compat surface, which is gone (TASK-1004).
          preSummaryVariant: 'dept-free',
          // v1 `{visit_type}`. `parentConsultationId` is the consultation's own
          // follow-up signal; the LABEL comes from the platform's visit types.
          visitType: this.visitType(consultation).label,
          // EMPTY on purpose: this chain has no recording. The case-note records travel as
          // `caseNotes`, under a section that says what they are — they used to arrive as the
          // transcript, which told the model that text from previous encounters was said today.
          transcript: '',
          caseNotes: promptCaseNotes,
          // TASK-1001 (OD-12) — the platform-default OUTPUT language; never a per-request option.
          conversationLanguage: (await resolvePlatformOutputLanguage(this.effectiveSettings, tenantId, this.logger)).tag,
          dnaStyleId,
          // Thread the doctor-preferred prompt id into assembly.
          preferredPromptTemplateId: preferredPromptTemplateId ?? undefined,
        });

        // Step 2: Calling AI service (30%)
        await this.jobService.notifyProgress(jobId, 30, 'Generating pre-summary with AI');

        const textResponse = await this.callTextService(
          assembledPrompt,
          {
            ...request,
            dnaStyleId,
            options: {
              ...request.options,
              promptResolvedFrom: assembledPrompt.resolvedFrom,
              promptHyperparameters: assembledPrompt.hyperparameters,
            },
          },
          tenantId,
          jobId,
          consultationId,
        );

        // Step 3: Saving results (70%)
        await this.jobService.notifyProgress(jobId, 70, 'Saving results');

        const contextItem = ContextItemFactory.CreatePreSummary(tenantId, consultationId, textResponse.summary, dnaStyleId, userId);

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
    // The consultation this pre-summary is for: its known PHI rides the egress enrichment.
    consultationId?: string,
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
      // Resolve the tenant's effective {provider, model} (its TEXT_GENERATION agent). The caller's
      // `options` ride along, but NEVER select the engine (TASK-1012 item 11): model-selecting
      // keys are dropped before the resolved pair is merged in.
      const callerOptions = withoutCallerModelSelection(request.options);
      let options = callerOptions;
      // TASK-891 — the resolved selection's `generation` block, carried alongside
      // {provider, model} so its reasoning posture can reach `applyTextRuntimeProfile` below.
      let generation: Record<string, unknown> | undefined;
      let deploymentKind: string | undefined;
      if (this.harnessPolicyService) {
        const selection = await this.harnessPolicyService.resolveTextSelection(tenantId, 'finalize');
        options = { ...callerOptions, textProvider: selection.provider, textModel: selection.model };
        generation = selection.generation;
        deploymentKind = selection.deploymentKind;
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
      // TASK-891 — `generation` carries the resolved agent's reasoning posture (OD-4) onto the
      // `extra` ride-along; an agent with no opinion injects nothing.
      await this.textRequestEnrichment?.applyTextRuntimeProfile(textPayload as { provider?: string; model?: string }, generation);
      await this.textRequestEnrichment?.applyTenantProviderOverrides(textPayload as { provider?: string }, {
        deploymentKind: deploymentKind ?? null,
        consultationId: consultationId ?? null,
      });
      // D-D: the ONE shared `INTERNAL_ACCESS_TOKEN` (the per-service `TEXT_SERVICE_TOKEN`
      // fallback was retired with its descriptor, TASK-888). `X-Tenant-Id` is MANDATORY — `tenantId` is the
      // fail-closed-validated `job.data.tenantId` already threaded in above and used
      // one line earlier for `resolveTextSelection`, then dropped before the HTTP call,
      // so Text resolved the platform default provider for a job that HAS a tenant.
      const serviceToken = await resolveInternalAccessToken(this.secretsService, 'INTERNAL_ACCESS_TOKEN');
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

  /**
   * The consultation's visit type — one of the platform's two, through the one
   * vocabulary every caller shares rather than a literal repeated at each call site.
   *
   * TASK-951 §D-3 — the value the CALLER stated at open (`metadata.visitType`) ranks above the
   * consultation's own follow-up signal (`parentConsultationId`), which is what
   * `selectVisitType` has always done with a recorded value; until this ticket nothing on this
   * path ever supplied one. A consultation with no stated visit type derives exactly as before.
   */
  /**
   * TASK-1034 R3 — the requested DNA style id when the style is EFFECTIVE, else `undefined`.
   * Pass-through when nothing was requested or the resolver is unwired (positional fixtures);
   * FAIL-CLOSED (no style) when the gate read throws.
   */
  private async resolveEffectiveDnaStyleId(
    consultation: { tenantId: string; departmentId?: string | null; doctorId?: string | null },
    dnaStyleId: string | undefined,
  ): Promise<string | undefined> {
    if (!dnaStyleId || !this.configResolver) return dnaStyleId;
    try {
      const { effective } = await this.configResolver.resolveEffectiveDnaStyleEnabled({
        tenantId: consultation.tenantId,
        departmentId: consultation.departmentId ?? null,
        doctorId: consultation.doctorId ?? null,
      });
      return effective ? dnaStyleId : undefined;
    } catch (error) {
      this.logger.warn({
        message: 'Effective DNA style could not be resolved for the pre-summary — generating without it',
        error: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
  }

  private visitType(consultation: { tenantId?: string | null; parentConsultationId?: string | null; metadata?: unknown }): VisitTypeDefinition {
    return (this.visitTypes ?? DEFAULT_VISIT_TYPE_SERVICE).forConsultation(consultation.tenantId ?? null, {
      recorded: readRecordedVisitType(consultation.metadata),
      isFollowUp: Boolean(consultation.parentConsultationId),
    });
  }
}
