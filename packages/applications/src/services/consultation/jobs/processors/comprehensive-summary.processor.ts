import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, Logger, Optional } from '@nestjs/common';
import { Job } from 'bullmq';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { ClsService } from 'nestjs-cls';
import {
  JobQueue,
  ContextItemRepository,
  ConsultationRepository,
  CorePrisma,
  CoreUnitOfWorkService,
  SummaryMetaRepository,
  NamedEntityRepository,
  ContextItemFactory,
  SummaryMetaFactory,
} from '@arcaai/domains';
import { IConsultationJobService } from '../consultation-job.service';
import { GenerateComprehensiveSummaryJobPayload, ComprehensiveSummaryJobResult } from '../dto';
import { ChainSummaryService } from '../../summary/chain-summary.service';
import { PromptResolutionService } from '../../prompt/prompt-resolution.service';
import { PromptAssemblyService } from '../../prompt/prompt-assembly.service';
import { JobMetricsService } from '../../../baseServices/observability/job-metrics.service';
import { SecretsService } from '../../../baseServices/_meta/secrets';
import { encryptPhiFields } from '../../../../common';
import { buildSmrGeneratePayload, mapSmrGenerateResponse } from '../../summary/smr-generate';
import { buildGuardrailUsageInput, buildLlmUsageInput, parseSmrUsageDetail, type SmrUsageDetail } from '../../summary/smr-usage';
import { HarnessPolicyService } from '../../../harness-policy/harness-policy.service';
import { ConfigResolver } from '../../../config-resolver';
import { IActiveUserContext } from '../../../../interfaces';
import { assertEqualTenants, createWorkerSession } from '../../../../common';
import { IUsageLedgerService } from '../../../usageLedger';

/**
 * BullMQ processor for async comprehensive summary generation.
 *
 * Follows the same pattern as SummaryProcessor but aggregates content
 * across the entire consultation chain before calling the SMR service.
 *
 * Progress steps:
 *   10% — Resolving linked consultations
 *   25% — Gathering sections from chain
 *   40% — Gathering NER entities
 *   60% — Generating comprehensive summary with AI
 *   85% — Saving results
 *  100% — Complete
 */
@Processor(JobQueue.GenerateComprehensiveSummary)
export class ComprehensiveSummaryProcessor extends WorkerHost {
  private readonly logger = new Logger(ComprehensiveSummaryProcessor.name);
  private readonly smrServiceUrl: string;

  constructor(
    @Inject(IConsultationJobService) private readonly jobService: IConsultationJobService,
    private readonly chainSummaryService: ChainSummaryService,
    private readonly contextItemRepository: ContextItemRepository,
    private readonly consultationRepository: ConsultationRepository,
    private readonly summaryMetaRepository: SummaryMetaRepository,
    private readonly namedEntityRepository: NamedEntityRepository,
    private readonly httpService: HttpService,
    private readonly configService: ConfigService,
    private readonly promptResolutionService: PromptResolutionService,
    private readonly promptAssemblyService: PromptAssemblyService,
    private readonly jobMetrics: JobMetricsService,
    private readonly cls: ClsService<IActiveUserContext>,
    @Optional() @Inject(SecretsService) private readonly secretsService?: SecretsService,
    // Resolver for the tenant's effective SMR {provider, model}.
    @Optional() @Inject(HarnessPolicyService) private readonly harnessPolicyService?: HarnessPolicyService,
    // Load the requesting doctor's preferred prompt id so this async
    // comprehensive path threads it into BOTH resolution and assembly (was dropped
    // here before). Optional + trailing so existing positional fixtures keep compiling.
    @Optional() @Inject(ConfigResolver) private readonly configResolver?: ConfigResolver,
    // TASK-615 WS-D2 (item 1a) — records the LLM (+ guardrail, when SMR
    // forwarded one) token consumption this generation produced. Optional +
    // trailing so existing positional fixtures keep compiling; absent ⇒ the
    // SummaryMeta persists unmetered (see `persistSummaryMetaWithUsage`).
    @Optional() @Inject(IUsageLedgerService) private readonly usageLedgerService?: IUsageLedgerService,
    // Lets the SummaryMeta write and the usage emission share ONE
    // transaction. This is the DOMAINS `CoreUnitOfWorkService` (its
    // `runInTransaction` is the one production callers actually use — see the
    // outbox drainer / sttInternal.service.ts / AgentTrajectoryService
    // precedent), NOT the identically-named, unwired class under
    // `services/baseServices` (see summary.service.ts, which imports the
    // wrong one — flagged separately, out of this lane's scope). Optional +
    // trailing so existing positional fixtures keep compiling.
    @Optional() private readonly unitOfWorkService?: CoreUnitOfWorkService,
  ) {
    super();
    this.smrServiceUrl = this.configService.get<string>('SMR_URL') ?? 'http://localhost:8862';
  }

  /**
   * Encrypt PHI on write through the shared env-gated guard: a soft
   * no-op in dev/test (SECRETS_PROVIDER!=vault) but FAIL-CLOSED (throws) in
   * staging/prod (SECRETS_PROVIDER=vault) instead of persisting plaintext-only.
   */
  private async encryptBestEffort(label: string, run: () => Promise<void>): Promise<void> {
    await encryptPhiFields(this.secretsService, label, run, this.logger);
  }

  async process(job: Job<GenerateComprehensiveSummaryJobPayload>): Promise<ComprehensiveSummaryJobResult> {
    const { jobId, consultationId, tenantId, userId, request } = job.data;
    // Fail-closed when tenantId is missing.
    if (!tenantId) {
      throw new Error(`Job ${jobId ?? job.id} is missing required tenantId`);
    }
    // Rebind tenantId + user into a fresh CLS scope so the
    // tenantScope Prisma extension sees the correct context.
    return this.cls.run(async () => {
      this.cls.set('tenantId', tenantId);
      this.cls.set('user', createWorkerSession({ userId, tenantId, kind: 'comprehensive-summary' }));

      const endTimer = this.jobMetrics.recordJobStart(JobQueue.GenerateComprehensiveSummary);
      const waitMs = Date.now() - job.timestamp;
      this.jobMetrics.recordWaitingDuration(JobQueue.GenerateComprehensiveSummary, waitMs / 1000);

      this.logger.log({
        message: 'Processing comprehensive summary job',
        jobId,
        consultationId,
      });

      try {
        // Step 1: Resolve linked consultations (10%)
        await this.jobService.notifyProgress(jobId, 10, 'Resolving linked consultations');

        const consultation = await this.consultationRepository.findById(consultationId);
        if (!consultation) {
          throw new Error(`Consultation ${consultationId} not found`);
        }
        // Defense in depth against a poisoned / stale payload.
        assertEqualTenants(consultation, { tenantId });

        // Resolve the requesting doctor's preferred prompt id once so
        // BOTH prompt resolution and assembly thread it (this async comprehensive
        // path dropped it before). Null-safe + no-op when the resolver isn't wired.
        const preferredPromptTemplateId = this.configResolver
          ? await this.configResolver.resolvePreferredPromptTemplateId(consultation.doctorId ?? null)
          : undefined;

        const linkedConsultations = await this.chainSummaryService.resolveLinkedConsultations(consultation);
        if (linkedConsultations.length === 0) {
          throw new Error('No linked consultations found for comprehensive summary');
        }

        const allConsultationIds = linkedConsultations.map((c) => c.id);

        this.logger.log({
          message: 'Resolved linked consultations',
          jobId,
          linkedCount: linkedConsultations.length,
        });

        // Step 2: Gather sections from chain (25%)
        await this.jobService.notifyProgress(jobId, 25, 'Gathering content from linked consultations');

        const sections = await this.chainSummaryService.gatherSections(linkedConsultations);
        if (sections.length === 0) {
          throw new Error('No content available across linked consultations');
        }

        // Step 3: Gather NER entities (40%)
        let aggregatedEntities:
          | Record<
              string,
              Array<{
                text: string;
                confidence?: number;
                sourceConsultationId: string;
              }>
            >
          | undefined;

        if (request.includeNER !== false) {
          await this.jobService.notifyProgress(jobId, 40, 'Gathering named entities');
          aggregatedEntities = await this.chainSummaryService.gatherNamedEntities(allConsultationIds);
        }

        // Resolve prompt config if template not explicitly provided
        // DNA style is per-doctor and resolved separately — not part of prompt resolution.
        let resolvedRequest = request;
        if (!request.template) {
          const resolved = await this.promptResolutionService.resolve({
            departmentId: consultation.departmentId ?? undefined,
            explicitTemplate: request.template,
            // Thread the doctor's preferred prompt id into resolution.
            preferredPromptTemplateId: preferredPromptTemplateId ?? undefined,
          });
          resolvedRequest = {
            ...request,
            template: resolved.template || 'comprehensive',
          };
        }

        // Step 4: Call SMR service (60%)
        await this.jobService.notifyProgress(jobId, 60, 'Generating comprehensive summary with AI');

        const smrResponse = await this.callSmrService(consultation, sections, aggregatedEntities, resolvedRequest, preferredPromptTemplateId, jobId);

        // Step 5: Save results (85%)
        await this.jobService.notifyProgress(jobId, 85, 'Saving results');

        const contextItem = ContextItemFactory.CreateRawSummary(tenantId, consultationId, smrResponse.summary, resolvedRequest.dnaStyleId, userId);

        // Encrypt the generated summary text into `encryptedContent`
        // before persistence — the plaintext `content` column was dropped by the
        // PHI field-encryption migration, so an unencrypted create silently loses
        // the clinical text at rest (mirrors context.service.ts `encryptContent`).
        await this.encryptBestEffort('ContextItem content', () =>
          this.contextItemRepository.encryptContentIntoEntity(contextItem, this.secretsService!),
        );

        const savedContext = await this.contextItemRepository.create(contextItem);

        const summaryMeta = SummaryMetaFactory.CreateSummaryMeta({
          tenantId,
          contextItemId: savedContext.id,
          aiModelId: smrResponse.modelName,
          processingTimeMs: smrResponse.processingTimeMs,
          inputTokens: smrResponse.inputTokens,
          outputTokens: smrResponse.outputTokens,
        });
        await this.encryptBestEffort('SummaryMeta', () => this.summaryMetaRepository.encryptFieldsIntoEntity(summaryMeta, this.secretsService!));
        await this.persistSummaryMetaWithUsage(summaryMeta, smrResponse, {
          tenantId,
          consultationId,
          doctorId: consultation.doctorId,
          departmentId: consultation.departmentId,
        });

        // Step 6: Complete (100%)
        const result: ComprehensiveSummaryJobResult = {
          contextItemId: savedContext.id,
          content: savedContext.content ?? '',
          sourceConsultationIds: allConsultationIds,
          sectionCount: sections.length,
          summaryMeta: {
            aiModelId: smrResponse.modelName,
            processingTimeMs: smrResponse.processingTimeMs,
            inputTokens: smrResponse.inputTokens,
            outputTokens: smrResponse.outputTokens,
          },
          namedEntities: aggregatedEntities,
        };

        await this.jobService.notifyComplete(jobId, result);

        const duration = endTimer();
        this.jobMetrics.recordJobComplete(JobQueue.GenerateComprehensiveSummary, 'ComprehensiveSummaryProcessor', duration);

        this.logger.log({
          message: 'Comprehensive summary job completed',
          jobId,
          contextItemId: savedContext.id,
          sectionCount: sections.length,
          sourceConsultationCount: allConsultationIds.length,
          processingTimeMs: smrResponse.processingTimeMs,
        });

        return result;
      } catch (error) {
        endTimer();
        this.jobMetrics.recordJobFailed(
          JobQueue.GenerateComprehensiveSummary,
          'ComprehensiveSummaryProcessor',
          error instanceof Error ? error.constructor.name : 'UnknownError',
        );
        const errorMessage = error instanceof Error ? error.message : String(error);
        this.logger.error({
          message: 'Comprehensive summary job failed',
          jobId,
          error: errorMessage,
        });
        await this.jobService.notifyFailed(jobId, errorMessage);
        throw error;
      }
    });
  }

  private async callSmrService(
    consultation: {
      departmentId?: string | null;
      parentConsultationId?: string | null;
    },
    sections: Array<{
      consultationId: string;
      department?: string;
      doctor?: string;
      type: string;
      content: string;
      createdAt?: string;
    }>,
    namedEntities:
      | Record<
          string,
          Array<{
            text: string;
            confidence?: number;
            sourceConsultationId: string;
          }>
        >
      | undefined,
    request: GenerateComprehensiveSummaryJobPayload['request'],
    // Doctor's preferred prompt id, threaded into assembly below.
    preferredPromptTemplateId: string | null | undefined,
    jobId?: string,
  ): Promise<{
    summary: string;
    llmProvider?: string;
    modelName?: string;
    processingTimeMs?: number;
    inputTokens?: number;
    outputTokens?: number;
    /** SMR's billing passthrough for this call (TASK-615 WS-D2). */
    usage: SmrUsageDetail | null;
    /** The guardrail call this generation triggered, forwarded by SMR. */
    guardrailUsage: SmrUsageDetail | null;
  }> {
    // Build structured text from sections
    const sectionTexts = sections.map((section, index) => {
      const header = [
        `--- Section ${index + 1} ---`,
        section.department ? `Department: ${section.department}` : null,
        section.doctor ? `Doctor: ${section.doctor}` : null,
        `Type: ${section.type}`,
        section.createdAt ? `Date: ${section.createdAt}` : null,
      ]
        .filter(Boolean)
        .join('\n');

      return `${header}\n\n${section.content}`;
    });

    let fullText = sectionTexts.join('\n\n');

    // Append NER context if available
    if (namedEntities && Object.keys(namedEntities).length > 0) {
      const nerLines = Object.entries(namedEntities).map(([className, entities]) => {
        const uniqueTexts = [...new Set(entities.map((e) => e.text))];
        return `${className}: ${uniqueTexts.join(', ')}`;
      });
      fullText += `\n\n--- Named Entities (auto-extracted) ---\n${nerLines.join('\n')}`;
    }

    const assembledPrompt = await this.promptAssemblyService.assemble({
      departmentId: consultation.departmentId ?? undefined,
      promptType: consultation.parentConsultationId ? 'revisit' : 'new-patient',
      transcript: fullText,
      conversationLanguage: this.resolveConversationLanguage(request.options),
      dnaStyleId: request.dnaStyleId,
      explicitTemplate: request.template ?? 'comprehensive',
      // Thread the doctor's preferred prompt id into assembly.
      preferredPromptTemplateId: preferredPromptTemplateId ?? undefined,
    });

    try {
      const smrStart = Date.now();
      // Resolve the tenant's effective {provider, model} (CLS tenant
      // set by process()) and merge as the base so a caller-supplied model wins.
      let options = request.options;
      if (this.harnessPolicyService) {
        const { provider, model } = await this.harnessPolicyService.resolveSmrSelection();
        options = { smrProvider: provider, smrModel: model, ...request.options };
      }
      const smrPayload = buildSmrGeneratePayload(assembledPrompt, options, {
        dnaStyleId: request.dnaStyleId,
        template: request.template ?? 'comprehensive',
        includeNER: request.includeNER,
        summaryType: 'summary',
        isComprehensiveSummary: true,
        sectionCount: sections.length,
        sourceConsultationCount: new Set(sections.map((s) => s.consultationId)).size,
        promptResolvedFrom: assembledPrompt.resolvedFrom,
        promptHyperparameters: assembledPrompt.hyperparameters,
      });
      const smrServiceToken = (await this.secretsService?.getSecretOptional('SMR_SERVICE_TOKEN')) ?? '';
      const response = await this.httpService.axiosRef.post(`${this.smrServiceUrl}/api/v1/generate`, smrPayload, {
        timeout: 180000,
        headers: {
          'Content-Type': 'application/json',
          'X-Service-Token': smrServiceToken,
          ...(jobId && { 'X-Request-ID': jobId }),
        },
      });
      this.jobMetrics.recordSmrCallDuration(JobQueue.GenerateComprehensiveSummary, 'smr', (Date.now() - smrStart) / 1000);
      const data = response.data as { usage_detail?: unknown; guardrail_usage?: unknown };
      return {
        ...mapSmrGenerateResponse(response.data),
        usage: parseSmrUsageDetail(data?.usage_detail),
        guardrailUsage: parseSmrUsageDetail(data?.guardrail_usage),
      };
    } catch (error) {
      this.logger.error({
        message: 'SMR service call failed for comprehensive summary',
        error: error instanceof Error ? error.message : String(error),
      });
      throw new Error('Failed to generate comprehensive summary from AI service');
    }
  }

  private resolveConversationLanguage(options?: Record<string, unknown>): string {
    const candidate = options?.conversationLanguage ?? options?.language ?? options?.locale;

    return typeof candidate === 'string' && candidate.trim().length > 0 ? candidate : 'en';
  }

  /**
   * Persist a `SummaryMeta` and, in the SAME transaction, record the tokens
   * the generation consumed (TASK-615 WS-D2 — mirrors
   * `SummaryService.persistSummaryMetaWithUsage` exactly).
   *
   * TWO deliberate degradations:
   *   - No ledger / no unit-of-work wired (legacy positional test fixtures)
   *     ⇒ plain create, unmetered. Metering is additive; it must not become a
   *     precondition for saving a clinical note.
   *   - A metering failure is swallowed. The model already ran and the job is
   *     about to notify completion: "not metered" is recoverable from the
   *     provider's own usage API, a failed job over a delivered summary is not.
   */
  private async persistSummaryMetaWithUsage(
    summaryMeta: Parameters<SummaryMetaRepository['create']>[0],
    smrResponse: { usage: SmrUsageDetail | null; guardrailUsage: SmrUsageDetail | null },
    attribution: { tenantId: string; consultationId: string; doctorId?: string | null; departmentId?: string | null },
  ): Promise<void> {
    const llmInput = smrResponse.usage
      ? buildLlmUsageInput({
          usage: smrResponse.usage,
          tenantId: attribution.tenantId,
          operation: 'generate',
          consultationId: attribution.consultationId,
          doctorId: attribution.doctorId,
          departmentId: attribution.departmentId,
        })
      : null;
    const guardrailInput = smrResponse.guardrailUsage
      ? buildGuardrailUsageInput({
          usage: smrResponse.guardrailUsage,
          tenantId: attribution.tenantId,
          consultationId: attribution.consultationId,
          doctorId: attribution.doctorId,
          departmentId: attribution.departmentId,
          fallbackRequestId: smrResponse.usage?.taskId ?? null,
        })
      : null;

    const inputs = [llmInput, guardrailInput].filter((input): input is NonNullable<typeof input> => input !== null);

    if (!this.usageLedgerService || !this.unitOfWorkService || inputs.length === 0) {
      await this.summaryMetaRepository.create(summaryMeta);
      return;
    }

    try {
      await this.unitOfWorkService.runInTransaction(async (tx: CorePrisma.TransactionClient) => {
        await this.summaryMetaRepository.create(summaryMeta, tx);
        for (const input of inputs) {
          await this.usageLedgerService!.recordUsage(input, tx);
        }
      });
    } catch (error) {
      this.logger.warn({
        message: 'Usage metering failed for a generated comprehensive summary; persisting the summary metadata unmetered',
        consultationId: attribution.consultationId,
        error: error instanceof Error ? error.message : String(error),
      });
      // The transaction rolled back, so the SummaryMeta was never written.
      // Re-create it on its own — losing the metadata over a metering problem
      // would be strictly worse than losing the meter.
      await this.summaryMetaRepository.create(summaryMeta);
    }
  }
}
