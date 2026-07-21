import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, Logger, Optional } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { ClsService } from 'nestjs-cls';
import { Job } from 'bullmq';
import {
  DnaWritingStyleReportRepository,
  DnaWritingStyleVersionRepository,
  DnaUsageRecordRepository,
  PromptUsageRecordRepository,
  DnaWritingStyleReportFactory,
  DnaWritingStyleVersionFactory,
  DnaUsageRecordFactory,
  PromptUsageRecordFactory,
  ContextItemRepository,
  ContextItemVersionRepository,
  JobQueue,
} from '@arcaai/domains';
import { PromptManagementService } from '../prompt-management/prompt-management.service';
import { encryptPhiFields } from '../../common';
import { HarnessPolicyService } from '../harness-policy/harness-policy.service';
import { ConfigResolver } from '../config-resolver';
import { IConsultationJobService } from '../consultation/jobs/consultation-job.service';
import { IAppSettingsService } from '../baseServices/_meta/appSettings/IAppSettingsService';
import { SecretsService } from '../baseServices/_meta/secrets';
import { GenerateDnaReportJobPayload, DnaReportJobResult } from './dna-writing-style.service';
import { JobMetricsService } from '../baseServices/observability/job-metrics.service';
import { IActiveUserContext } from '../../interfaces';

const CONTEXT_DEFAULTS = {
  maxSamples: 50,
  maxContextChars: 100_000,
} as const;

@Processor(JobQueue.GenerateDnaReport)
export class DnaWritingStyleProcessor extends WorkerHost {
  private readonly logger = new Logger(DnaWritingStyleProcessor.name);
  private readonly smrServiceUrl: string;

  constructor(
    @Inject(IConsultationJobService) private readonly jobService: IConsultationJobService,
    @Inject(IAppSettingsService) private readonly appSettingsService: IAppSettingsService,
    private readonly contextItemRepository: ContextItemRepository,
    // Used to filter the learning corpus to APPROVED summaries only.
    private readonly contextItemVersionRepository: ContextItemVersionRepository,
    private readonly dnaReportRepository: DnaWritingStyleReportRepository,
    private readonly dnaVersionRepository: DnaWritingStyleVersionRepository,
    private readonly dnaUsageRecordRepository: DnaUsageRecordRepository,
    private readonly promptUsageRecordRepository: PromptUsageRecordRepository,
    private readonly promptManagementService: PromptManagementService,
    private readonly httpService: HttpService,
    private readonly configService: ConfigService,
    private readonly jobMetrics: JobMetricsService,
    private readonly clsService: ClsService<IActiveUserContext>,
    @Optional() @Inject(SecretsService) private readonly secretsService?: SecretsService,
    // Resolver for the tenant's effective SMR {provider, model}.
    @Optional() @Inject(HarnessPolicyService) private readonly harnessPolicyService?: HarnessPolicyService,
    // Gate the AUTOMATIC learning corpus on the
    // effective DNA flag (tenant AND doctor): a doctor who has opted out (or whose
    // tenant disabled DNA) is never learned-from. Optional + trailing so existing
    // positional fixtures keep their arity; production DI supplies it via
    // ConfigResolverModule. When unset, gating is a no-op (pre-Phase-6 behaviour).
    @Optional() @Inject(ConfigResolver) private readonly configResolver?: ConfigResolver,
  ) {
    super();
    this.smrServiceUrl = this.configService.get<string>('SMR_URL') ?? 'http://localhost:8862';
  }

  async process(job: Job<GenerateDnaReportJobPayload>): Promise<DnaReportJobResult> {
    return this.clsService.run(async () => {
      return this.processWithContext(job);
    });
  }

  /**
   * Encrypt PHI on write through the shared env-gated guard: a soft
   * no-op in dev/test (SECRETS_PROVIDER!=vault) but FAIL-CLOSED (throws) in
   * staging/prod (SECRETS_PROVIDER=vault) instead of persisting plaintext-only.
   */
  private async encryptBestEffort(label: string, run: () => Promise<void>): Promise<void> {
    await encryptPhiFields(this.secretsService, label, run, this.logger);
  }

  private async processWithContext(job: Job<GenerateDnaReportJobPayload>): Promise<DnaReportJobResult> {
    const { doctorId, tenantId, userId, textSamples, sourceIds } = job.data;

    this.clsService.set('tenantId', tenantId);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    this.clsService.set('user', { id: userId } as any);

    const maxSamples = this.appSettingsService.getValueWithDefault<number>('dna-regen.max-samples', CONTEXT_DEFAULTS.maxSamples);
    const maxContextChars = this.appSettingsService.getValueWithDefault<number>('dna-regen.max-context-chars', CONTEXT_DEFAULTS.maxContextChars);
    const endTimer = this.jobMetrics.recordJobStart(JobQueue.GenerateDnaReport);
    const waitMs = Date.now() - job.timestamp;
    this.jobMetrics.recordWaitingDuration(JobQueue.GenerateDnaReport, waitMs / 1000);

    try {
      await job.updateProgress(10);
      this.jobService.notifyProgress(job.data.jobId, 10, 'Gathering text samples');
      let samples: string;
      // Explainability: track which context items contributed.
      let sourceContextItemIds: string[] = [];

      if (textSamples && textSamples.length > 0) {
        samples = textSamples.join('\n\n---\n\n');
        // Generate-from-history passes samples directly plus the
        // selected source IDs; record them so the report stays explainable.
        if (sourceIds && sourceIds.length > 0) {
          sourceContextItemIds = sourceIds;
        }
      } else {
        // Gate the AUTOMATIC corpus on the effective
        // DNA flag (tenant AND doctor). A doctor who has opted out (or whose tenant
        // disabled DNA) is never learned-from. Only the automatic path is gated;
        // an explicit textSamples request (admin/migration) bypasses this. No-op
        // when ConfigResolver is unwired (legacy fixtures).
        if (this.configResolver) {
          const { effective } = await this.configResolver.resolveEffectiveDnaStyleEnabled({ tenantId, doctorId });
          if (!effective) {
            this.jobService.notifyFailed(job.data.jobId, 'DNA writing style is disabled for this doctor');
            throw new Error('DNA writing style is disabled for this doctor (opt-out or tenant flag off)');
          }
        }

        const contextItems = await this.contextItemRepository.findAll({
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          filters: { doctorId } as any,
          sort: [{ createdAt: 'desc' }],
          limit: maxSamples,
        });

        if (!contextItems || contextItems.length === 0) {
          this.jobService.notifyFailed(job.data.jobId, 'No text samples available');
          throw new Error('No text samples available for DNA analysis');
        }

        // Corpus filter:
        //   1. Only RAW_SUMMARY or MODIFIED_SUMMARY (final summaries).
        //   2. Only items with at least one ContextItemVersion whose
        //      changeReason is 'approved' (see SummaryService.approveSummary).
        // This prevents the DNA writing-style model from learning from
        // unreviewed AI output or from non-summary content (transcripts,
        // pre-summaries, case notes).
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const finalSummaries = (contextItems as any[]).filter(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (item: any) => item?.type === 'RAW_SUMMARY' || item?.type === 'MODIFIED_SUMMARY',
        );

        // Build draft↔approved PAIRS: for each approved
        // summary also fetch its immutable `ai_draft_v1` snapshot so the DNA model
        // learns the doctor's EDIT behaviour (draft → approved), not just the final
        // prose. Back-compat: a legacy summary with no v1 snapshot
        // falls back to final-only.
        const pairs: Array<{ id: string; draft: string | null; approved: string }> = [];
        for (const item of finalSummaries) {
          if (!item?.id) continue;
          const approvedVersions = await this.contextItemVersionRepository.getVersionsByChangeReason(item.id, 'approved');
          if (approvedVersions && approvedVersions.length > 0) {
            const approvedContent: string = item.content ?? item.text ?? '';
            const draftVersions = await this.contextItemVersionRepository.getVersionsByChangeReason(item.id, 'ai_draft_v1');
            const draftContent: string | null = draftVersions?.[0]?.content ?? null;
            pairs.push({ id: item.id, draft: draftContent, approved: approvedContent });
          }
        }

        if (pairs.length === 0) {
          this.jobService.notifyFailed(job.data.jobId, 'No approved samples available');
          throw new Error('No approved text samples available for DNA analysis');
        }

        sourceContextItemIds = pairs.map((p) => p.id);
        samples = DnaWritingStyleProcessor.buildCorpus(pairs);
      }

      if (samples.length > maxContextChars) {
        samples = samples.substring(0, maxContextChars);
      }

      await job.updateProgress(20);
      this.jobService.notifyProgress(job.data.jobId, 20, 'Loading DNA analysis prompt');
      const templates = await this.promptManagementService.listPromptTemplates({ category: 'DNA_ANALYSIS' });
      const resolvedTemplate = templates[0] ?? null;
      const systemPrompt = resolvedTemplate?.content ?? 'Analyze the following text samples and extract the writing style patterns.';

      await job.updateProgress(40);
      this.jobService.notifyProgress(job.data.jobId, 40, 'Generating DNA analysis');
      const smrResponse = await this.callSmrV2(samples, systemPrompt);

      await job.updateProgress(80);
      this.jobService.notifyProgress(job.data.jobId, 80, 'Storing results');

      let reportData: Record<string, unknown> = {};
      let styleText = '';

      try {
        const parsed = JSON.parse(smrResponse.content);
        reportData = parsed.reportData ?? parsed;
        styleText = parsed.styleText ?? smrResponse.content;
      } catch {
        styleText = smrResponse.content;
      }

      // Explainability: persist the corpus source IDs alongside
      // the analytic report. Consumers can audit which approved summaries
      // shaped this DNA writing-style snapshot.
      if (sourceContextItemIds.length > 0) {
        reportData = { ...reportData, sourceContextItemIds };
      }

      const previousLatest = await this.dnaReportRepository.findLatestForDoctor(doctorId);
      if (previousLatest) {
        previousLatest.isLatest = false;
        await this.dnaReportRepository.update(previousLatest.id, previousLatest);
      }

      const reportEntity = DnaWritingStyleReportFactory.CreateDnaWritingStyleReport({
        tenantId,
        doctorId,
        reportData,
        styleText,
        isLatest: true,
        currentVersionNumber: 1,
        createdBy: userId,
      });

      // Encrypt reportData/styleText into the ciphertext
      // columns before the first persist (dual-write; plaintext retained for the
      // soak). Best-effort: a Vault outage must not fail DNA generation.
      await this.encryptBestEffort('DnaWritingStyleReport', () =>
        this.dnaReportRepository.encryptFieldsIntoEntity(reportEntity, this.secretsService!),
      );

      const saved = await this.dnaReportRepository.create(reportEntity);

      const versionEntity = DnaWritingStyleVersionFactory.CreateDnaWritingStyleVersion({
        tenantId,
        dnaReportId: saved.id,
        versionNumber: 1,
        reportData,
        styleText,
        changeReason: 'AI-generated initial analysis',
        changedBy: userId,
      });

      await this.encryptBestEffort('DnaWritingStyleVersion', () =>
        this.dnaVersionRepository.encryptFieldsIntoEntity(versionEntity, this.secretsService!),
      );

      await this.dnaVersionRepository.create(versionEntity);

      const usageEntity = DnaUsageRecordFactory.CreateDnaUsageRecord({
        tenantId,
        doctorId,
        dnaReportId: saved.id,
        dnaVersionNumber: 1,
      });

      await this.dnaUsageRecordRepository.create(usageEntity);

      if (resolvedTemplate) {
        const promptUsageEntity = PromptUsageRecordFactory.CreatePromptUsageRecord({
          tenantId,
          doctorId,
          promptTemplateId: resolvedTemplate.id,
          promptVersionNumber: resolvedTemplate.currentVersionNumber ?? 1,
        });
        await this.promptUsageRecordRepository.create(promptUsageEntity);
      }

      const duration = endTimer();
      this.jobMetrics.recordJobComplete(JobQueue.GenerateDnaReport, 'DnaWritingStyleProcessor', duration);

      await job.updateProgress(100);
      this.jobService.notifyProgress(job.data.jobId, 100, 'Complete');
      this.jobService.notifyComplete(job.data.jobId, { reportId: saved.id });

      return {
        reportId: saved.id,
        reportData,
        styleText,
      };
    } catch (error) {
      endTimer();
      this.jobMetrics.recordJobFailed(
        JobQueue.GenerateDnaReport,
        'DnaWritingStyleProcessor',
        error instanceof Error ? error.constructor.name : 'UnknownError',
      );
      this.logger.error(`DNA report generation failed: ${error}`);
      this.jobService.notifyFailed(job.data.jobId, `DNA generation failed: ${error}`);
      throw error;
    }
  }

  /**
   * Render the learning corpus from draft↔approved pairs.
   * A pair whose captured AI draft DIFFERS from the approved text is rendered as
   * an explicit `AI DRAFT` → `DOCTOR APPROVED` block so the model learns the
   * doctor's edit behaviour. Pairs with no draft snapshot (legacy) or an unchanged
   * draft fall back to the raw approved text only — byte-identical to the
   * pre-Phase-6 final-only corpus (so empty approvals still contribute nothing).
   */
  private static buildCorpus(pairs: Array<{ draft: string | null; approved: string }>): string {
    return pairs
      .map(({ draft, approved }) => {
        const hasDraftDelta = !!draft && draft.trim().length > 0 && draft !== approved;
        return hasDraftDelta ? `AI DRAFT:\n${draft}\n\nDOCTOR APPROVED:\n${approved}` : approved;
      })
      .filter((s) => s.length > 0)
      .join('\n\n---\n\n');
  }

  private async callSmrV2(
    textSamples: string,
    systemPrompt: string,
  ): Promise<{
    content: string;
    usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
    latency_ms?: number;
  }> {
    const smrStart = Date.now();
    // SMR is a stateless gateway with no model default; resolve the
    // tenant's effective {provider, model} (CLS tenant set by processWithContext)
    // and pass both explicitly on the generate call.
    let provider: string | undefined;
    let model: string | undefined;
    if (this.harnessPolicyService) {
      ({ provider, model } = await this.harnessPolicyService.resolveSmrSelection());
    }
    const response = await this.httpService.axiosRef.post(
      `${this.smrServiceUrl}/api/v1/generate`,
      {
        prompt: textSamples,
        system_prompt: systemPrompt,
        stream: false,
        provider,
        model,
      },
      {
        timeout: 120000,
        headers: {
          'Content-Type': 'application/json',
          'X-Service-Token': (await this.secretsService?.getSecretOptional('SMR_SERVICE_TOKEN')) ?? '',
        },
      },
    );
    this.jobMetrics.recordSmrCallDuration(JobQueue.GenerateDnaReport, 'smr-v2', (Date.now() - smrStart) / 1000);
    return response.data;
  }
}
