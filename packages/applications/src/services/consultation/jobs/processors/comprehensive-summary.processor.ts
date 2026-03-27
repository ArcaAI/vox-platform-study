import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import {
  JobQueue,
  ContextItemRepository,
  ConsultationRepository,
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
import { buildSmrGeneratePayload, mapSmrGenerateResponse } from '../../summary/smr-v2-generate';

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
  ) {
    super();
    this.smrServiceUrl = this.configService.get<string>('SMR_URL') ?? 'http://localhost:8862';
  }

  async process(job: Job<GenerateComprehensiveSummaryJobPayload>): Promise<ComprehensiveSummaryJobResult> {
    const { jobId, consultationId, tenantId, userId, request } = job.data;
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

      // Resolve prompt config if template not explicitly provided (TASK-025)
      // DNA style is per-doctor and resolved separately — not part of prompt resolution.
      let resolvedRequest = request;
      if (!request.template) {
        const resolved = await this.promptResolutionService.resolve({
          departmentId: consultation.departmentId ?? undefined,
          explicitTemplate: request.template,
        });
        resolvedRequest = {
          ...request,
          template: resolved.template || 'comprehensive',
        };
      }

      // Step 4: Call SMR service (60%)
      await this.jobService.notifyProgress(jobId, 60, 'Generating comprehensive summary with AI');

      const smrResponse = await this.callSmrService(consultation, sections, aggregatedEntities, resolvedRequest, jobId);

      // Step 5: Save results (85%)
      await this.jobService.notifyProgress(jobId, 85, 'Saving results');

      const contextItem = ContextItemFactory.CreateRawSummary(tenantId, consultationId, smrResponse.summary, resolvedRequest.dnaStyleId, userId);

      const savedContext = await this.contextItemRepository.create(contextItem);

      const summaryMeta = SummaryMetaFactory.CreateSummaryMeta({
        tenantId,
        contextItemId: savedContext.id,
        aiModelId: smrResponse.modelName,
        processingTimeMs: smrResponse.processingTimeMs,
        inputTokens: smrResponse.inputTokens,
        outputTokens: smrResponse.outputTokens,
      });
      await this.summaryMetaRepository.create(summaryMeta);

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
    jobId?: string,
  ): Promise<{
    summary: string;
    llmProvider?: string;
    modelName?: string;
    processingTimeMs?: number;
    inputTokens?: number;
    outputTokens?: number;
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
    });

    try {
      const smrStart = Date.now();
      const smrPayload = buildSmrGeneratePayload(assembledPrompt, request.options, {
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
      const response = await this.httpService.axiosRef.post(`${this.smrServiceUrl}/api/v1/generate`, smrPayload, {
        timeout: 180000,
        headers: {
          'Content-Type': 'application/json',
          // eslint-disable-next-line turbo/no-undeclared-env-vars
          'X-Service-Token': process.env.SMR_SERVICE_TOKEN || '',
          ...(jobId && { 'X-Request-ID': jobId }),
        },
      });
      this.jobMetrics.recordSmrCallDuration(JobQueue.GenerateComprehensiveSummary, 'smr-v2', (Date.now() - smrStart) / 1000);
      return mapSmrGenerateResponse(response.data);
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
}
