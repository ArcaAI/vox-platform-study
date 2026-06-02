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
    // TASK-299 D-11 — used to filter the learning corpus to APPROVED summaries only.
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
  ) {
    super();
    this.smrServiceUrl = this.configService.get<string>('SMR_URL') ?? 'http://localhost:8862';
  }

  async process(job: Job<GenerateDnaReportJobPayload>): Promise<DnaReportJobResult> {
    return this.clsService.run(async () => {
      return this.processWithContext(job);
    });
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
      // TASK-299 D-11 — explainability: track which context items contributed.
      let sourceContextItemIds: string[] = [];

      if (textSamples && textSamples.length > 0) {
        samples = textSamples.join('\n\n---\n\n');
        // TASK-329 P5 — generate-from-history passes samples directly plus the
        // selected source IDs; record them so the report stays explainable.
        if (sourceIds && sourceIds.length > 0) {
          sourceContextItemIds = sourceIds;
        }
      } else {
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

        // TASK-299 D-11 — corpus filter:
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

        const approved: Array<{ id: string; content: string }> = [];
        for (const item of finalSummaries) {
          if (!item?.id) continue;
          const approvedVersions = await this.contextItemVersionRepository.getVersionsByChangeReason(item.id, 'approved');
          if (approvedVersions && approvedVersions.length > 0) {
            const content: string = item.content ?? item.text ?? '';
            approved.push({ id: item.id, content });
          }
        }

        if (approved.length === 0) {
          this.jobService.notifyFailed(job.data.jobId, 'No approved samples available');
          throw new Error('No approved text samples available for DNA analysis');
        }

        sourceContextItemIds = approved.map((a) => a.id);
        samples = approved
          .map((a) => a.content)
          .filter((s: string) => s.length > 0)
          .join('\n\n---\n\n');
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

      // TASK-299 D-11 — explainability: persist the corpus source IDs alongside
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

  private async callSmrV2(
    textSamples: string,
    systemPrompt: string,
  ): Promise<{
    content: string;
    usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
    latency_ms?: number;
  }> {
    const smrStart = Date.now();
    const response = await this.httpService.axiosRef.post(
      `${this.smrServiceUrl}/api/v1/generate`,
      {
        prompt: textSamples,
        system_prompt: systemPrompt,
        stream: false,
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
