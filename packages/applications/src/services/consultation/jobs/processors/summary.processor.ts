import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, Logger, Optional } from '@nestjs/common';
import { Job } from 'bullmq';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { JobQueue, ContextItemRepository, ConsultationRepository, ContextItemFactory } from '@arcaai/domains';
import { IConsultationJobService } from '../consultation-job.service';
import { GenerateSummaryJobPayload, SummaryJobResult } from '../dto';
import { ConsultationPipelineEvent, SummaryGeneratedPayload } from '../../events';
import { PromptResolutionService, type PromptResolutionTier } from '../../prompt/prompt-resolution.service';
import { PromptAssemblyService } from '../../prompt/prompt-assembly.service';
import { JobMetricsService } from '../../../baseServices/observability/job-metrics.service';
import { SecretsService } from '../../../baseServices/_meta/secrets';
import { buildSmrGeneratePayload, mapSmrGenerateResponse } from '../../summary/smr-v2-generate';

@Processor(JobQueue.GenerateSummary)
export class SummaryProcessor extends WorkerHost {
  private readonly logger = new Logger(SummaryProcessor.name);
  private readonly smrServiceUrl: string;

  constructor(
    @Inject(IConsultationJobService) private readonly jobService: IConsultationJobService,
    private readonly contextItemRepository: ContextItemRepository,
    private readonly consultationRepository: ConsultationRepository,
    private readonly httpService: HttpService,
    private readonly configService: ConfigService,
    private readonly eventEmitter: EventEmitter2,
    private readonly promptResolutionService: PromptResolutionService,
    private readonly promptAssemblyService: PromptAssemblyService,
    private readonly jobMetrics: JobMetricsService,
    @Optional() @Inject(SecretsService) private readonly secretsService?: SecretsService,
  ) {
    super();
    this.smrServiceUrl = this.configService.get<string>('SMR_URL') ?? 'http://localhost:8862';
  }

  async process(job: Job<GenerateSummaryJobPayload>): Promise<SummaryJobResult> {
    const { jobId, consultationId, tenantId, userId } = job.data;
    let request = job.data.request;
    const endTimer = this.jobMetrics.recordJobStart(JobQueue.GenerateSummary);
    const waitMs = Date.now() - job.timestamp;
    this.jobMetrics.recordWaitingDuration(JobQueue.GenerateSummary, waitMs / 1000);

    this.logger.log({
      message: 'Processing summary job',
      jobId,
      consultationId,
    });

    try {
      // Step 1: Gathering context (10%)
      await this.jobService.notifyProgress(jobId, 10, 'Gathering context');

      const consultation = await this.consultationRepository.findById(consultationId);
      if (!consultation) {
        throw new Error(`Consultation ${consultationId} not found`);
      }

      // Resolve prompt config if template not explicitly provided (GAP-3)
      // DNA style is per-doctor and resolved separately — not part of prompt resolution (TASK-025).
      if (!request.template) {
        const resolved = await this.promptResolutionService.resolve({
          departmentId: consultation.departmentId ?? undefined,
          explicitTemplate: request.template,
        });

        if (!request.template) {
          request = { ...request, template: resolved.template };
        }

        this.logger.debug({
          message: 'Prompt config resolved for summary job',
          jobId,
          resolvedFrom: resolved.resolvedFrom,
          dnaStyleId: request.dnaStyleId,
          template: request.template,
        });
      }

      // Get content from selected context items or all transcriptions
      let content = '';
      if (request.contextItemIds?.length) {
        const contextItems = await Promise.all(request.contextItemIds.map((id) => this.contextItemRepository.findById(id)));
        content = contextItems
          .filter(Boolean)
          .map((c) => c!.content)
          .join('\n\n');
      } else {
        // Get all transcripts for this consultation
        const transcripts = await this.contextItemRepository.findTranscripts(consultationId);
        content = transcripts.map((c) => c.content).join('\n\n');
      }

      if (!content.trim()) {
        throw new Error('No content available for summary generation');
      }

      const latestPreSummary = await this.contextItemRepository.findLatestPreSummary(consultationId);
      const assembledPrompt = await this.promptAssemblyService.assemble({
        departmentId: consultation.departmentId ?? undefined,
        promptType: consultation.parentConsultationId ? 'revisit' : 'new-patient',
        transcript: content,
        conversationLanguage: this.resolveConversationLanguage(request.options),
        dnaStyleId: request.dnaStyleId,
        preSummaryText: latestPreSummary?.content ?? undefined,
        explicitTemplate: request.template,
      });

      // Step 2: Calling AI service (30%)
      await this.jobService.notifyProgress(jobId, 30, 'Generating summary with AI');

      const smrResponse = await this.callSmrService(
        assembledPrompt,
        {
          ...request,
          options: {
            ...request.options,
            promptResolvedFrom: assembledPrompt.resolvedFrom,
            promptHyperparameters: assembledPrompt.hyperparameters,
          },
        },
        jobId,
      );

      // Step 3: Saving results (70%)
      await this.jobService.notifyProgress(jobId, 70, 'Saving results');

      const contextItem = ContextItemFactory.CreateRawSummary(tenantId, consultationId, smrResponse.summary, request.dnaStyleId, userId);

      const savedContext = await this.contextItemRepository.create(contextItem);

      // Step 4: Complete (100%)
      const result: SummaryJobResult = {
        contextItemId: savedContext.id,
        content: savedContext.content,
        summaryMeta: {
          aiModelId: smrResponse.modelName,
          processingTimeMs: smrResponse.processingTimeMs,
          inputTokens: smrResponse.inputTokens,
          outputTokens: smrResponse.outputTokens,
        },
      };

      await this.jobService.notifyComplete(jobId, result);

      // Emit SummaryGenerated event for auto-pipeline (GAP-1)
      const isAutoGenerated = job.data.request.options?.autoGenerated === true;
      this.eventEmitter.emit(ConsultationPipelineEvent.SummaryGenerated, {
        consultationId,
        tenantId,
        userId,
        timestamp: new Date().toISOString(),
        correlationId: job.data.request.options?.correlationId as string | undefined,
        contextItemId: savedContext.id,
        jobId,
        dnaStyleId: request.dnaStyleId,
        template: request.template,
        isAutoGenerated,
        summaryMeta: result.summaryMeta,
      } satisfies SummaryGeneratedPayload);

      const duration = endTimer();
      this.jobMetrics.recordJobComplete(JobQueue.GenerateSummary, 'SummaryProcessor', duration);

      this.logger.log({
        message: 'Summary job completed',
        jobId,
        contextItemId: savedContext.id,
        processingTimeMs: smrResponse.processingTimeMs,
        isAutoGenerated,
      });

      return result;
    } catch (error) {
      endTimer();
      this.jobMetrics.recordJobFailed(JobQueue.GenerateSummary, 'SummaryProcessor', error instanceof Error ? error.constructor.name : 'UnknownError');
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error({
        message: 'Summary job failed',
        jobId,
        error: errorMessage,
      });
      await this.jobService.notifyFailed(jobId, errorMessage);
      throw error;
    }
  }

  private async callSmrService(
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
    request: GenerateSummaryJobPayload['request'],
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
      const smrStart = Date.now();
      const smrPayload = buildSmrGeneratePayload(assembledPrompt, request.options, {
        dnaStyleId: request.dnaStyleId,
        template: request.template,
        includeNER: request.includeNER,
        summaryType: 'summary',
      });
      const smrServiceToken = (await this.secretsService?.getSecretOptional('SMR_SERVICE_TOKEN')) ?? '';
      const response = await this.httpService.axiosRef.post(`${this.smrServiceUrl}/api/v1/generate`, smrPayload, {
        timeout: 120000,
        headers: {
          'Content-Type': 'application/json',
          'X-Service-Token': smrServiceToken,
          ...(jobId && { 'X-Request-ID': jobId }),
        },
      });
      this.jobMetrics.recordSmrCallDuration(JobQueue.GenerateSummary, 'smr-v2', (Date.now() - smrStart) / 1000);
      return mapSmrGenerateResponse(response.data);
    } catch (error) {
      this.logger.error({
        message: 'SMR service call failed',
        error: error instanceof Error ? error.message : String(error),
      });
      throw new Error('Failed to generate summary from AI service');
    }
  }

  private resolveConversationLanguage(options?: Record<string, unknown>): string {
    const candidate = options?.conversationLanguage ?? options?.language ?? options?.locale;

    return typeof candidate === 'string' && candidate.trim().length > 0 ? candidate : 'en';
  }
}
