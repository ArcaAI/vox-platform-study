import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import {
    JobQueue,
    ContextItemRepository,
    ConsultationRepository,
    ContextItemFactory,
    ContextItemType,
} from '@arcaai/domains';
import { IConsultationJobService } from '../consultation-job.service';
import { GeneratePreSummaryJobPayload, PreSummaryJobResult } from '../dto';
import { PromptResolutionService } from '../../prompt/prompt-resolution.service';
import { PromptAssemblyService } from '../../prompt/prompt-assembly.service';
import { JobMetricsService } from '../../../baseServices/observability/job-metrics.service';

@Processor(JobQueue.GeneratePreSummary)
export class PreSummaryProcessor extends WorkerHost {
    private readonly logger = new Logger(PreSummaryProcessor.name);
    private readonly smrServiceUrl: string;

    constructor(
        @Inject(IConsultationJobService) private readonly jobService: IConsultationJobService,
        private readonly contextItemRepository: ContextItemRepository,
        private readonly consultationRepository: ConsultationRepository,
        private readonly httpService: HttpService,
        private readonly configService: ConfigService,
        private readonly promptResolutionService: PromptResolutionService,
        private readonly promptAssemblyService: PromptAssemblyService,
        private readonly jobMetrics: JobMetricsService,
    ) {
        super();
        this.smrServiceUrl = this.configService.get<string>('SMR_URL') ?? 'http://localhost:8862';
    }

    async process(job: Job<GeneratePreSummaryJobPayload>): Promise<PreSummaryJobResult> {
        const { jobId, consultationId, tenantId, userId } = job.data;
        let request = job.data.request;
        const endTimer = this.jobMetrics.recordJobStart(JobQueue.GeneratePreSummary);
        const waitMs = Date.now() - job.timestamp;
        this.jobMetrics.recordWaitingDuration(JobQueue.GeneratePreSummary, waitMs / 1000);

        this.logger.log({
            message: 'Processing pre-summary job',
            jobId,
            consultationId,
        });

        try {
            // Step 1: Gathering case notes (10%)
            await this.jobService.notifyProgress(jobId, 10, 'Gathering case notes');

            const consultation = await this.consultationRepository.findById(consultationId);
            if (!consultation) {
                throw new Error(`Consultation ${consultationId} not found`);
            }

            // Resolve prompt config for pre-summary (GAP-3)
            // DNA style is per-doctor and resolved separately — not part of prompt resolution (TASK-025).
            const resolved = await this.promptResolutionService.resolve({
                departmentId: consultation.departmentId ?? undefined,
                promptType: 'pre-summary',
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
                const caseNotes = await Promise.all(
                    request.caseNoteIds.map((id) => this.contextItemRepository.findById(id)),
                );
                content = caseNotes
                    .filter(Boolean)
                    .map((c) => c!.content)
                    .join('\n\n');
            } else {
                // Get all case notes from the consultation
                const caseNotes = await this.contextItemRepository.findByConsultation(
                    consultationId,
                    { type: ContextItemType.CASE_NOTE },
                );
                content = caseNotes.map((c) => c.content).join('\n\n');
            }

            if (!content.trim()) {
                throw new Error('No case notes available for pre-summary generation');
            }

            const assembledPrompt = await this.promptAssemblyService.assemble({
                departmentId: consultation.departmentId ?? undefined,
                promptType: 'pre-summary',
                transcript: content,
                conversationLanguage: this.resolveConversationLanguage(request.options),
                dnaStyleId: request.dnaStyleId,
            });

            // Step 2: Calling AI service (30%)
            await this.jobService.notifyProgress(jobId, 30, 'Generating pre-summary with AI');

            const smrResponse = await this.callSmrService(assembledPrompt.userPrompt, {
                ...request,
                options: {
                    ...request.options,
                    promptResolvedFrom: assembledPrompt.resolvedFrom,
                    promptHyperparameters: assembledPrompt.hyperparameters,
                },
            }, jobId);

            // Step 3: Saving results (70%)
            await this.jobService.notifyProgress(jobId, 70, 'Saving results');

            const contextItem = ContextItemFactory.CreatePreSummary(
                tenantId,
                consultationId,
                smrResponse.summary,
                request.dnaStyleId,
                userId,
            );

            const savedContext = await this.contextItemRepository.create(contextItem);

            // Step 4: Complete (100%)
            const result: PreSummaryJobResult = {
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

            const duration = endTimer();
            this.jobMetrics.recordJobComplete(JobQueue.GeneratePreSummary, 'PreSummaryProcessor', duration);

            this.logger.log({
                message: 'Pre-summary job completed',
                jobId,
                contextItemId: savedContext.id,
                processingTimeMs: smrResponse.processingTimeMs,
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
    }

    private async callSmrService(
        content: string,
        request: GeneratePreSummaryJobPayload['request'],
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
            const response = await this.httpService.axiosRef.post(
                `${this.smrServiceUrl}/api/v1/presummary/sync`,
                {
                    text: content,
                    dnaStyleId: request.dnaStyleId,
                    options: request.options,
                },
                {
                    timeout: 120000,
                    headers: {
                        'Content-Type': 'application/json',
                        'X-Service-Token': process.env.SMR_SERVICE_TOKEN || '',
                        ...(jobId && { 'X-Request-ID': jobId }),
                    },
                },
            );
            this.jobMetrics.recordSmrCallDuration(JobQueue.GeneratePreSummary, 'smr-v1', (Date.now() - smrStart) / 1000);
            return response.data;
        } catch (error) {
            this.logger.error({
                message: 'SMR service call failed',
                error: error instanceof Error ? error.message : String(error),
            });
            throw new Error('Failed to generate pre-summary from AI service');
        }
    }

    private resolveConversationLanguage(options?: Record<string, unknown>): string {
        const candidate = options?.conversationLanguage
            ?? options?.language
            ?? options?.locale;

        return typeof candidate === 'string' && candidate.trim().length > 0
            ? candidate
            : 'en';
    }
}
