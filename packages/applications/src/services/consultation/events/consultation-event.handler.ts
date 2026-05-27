/**
 * ConsultationEventHandler
 *
 * Drives the automatic consultation processing pipeline (GAP-1).
 *
 * Listens for domain events emitted by SttInternalService, SummaryProcessor,
 * and NerProcessor, then triggers the next pipeline step via BullMQ jobs.
 *
 * Pipeline flow:
 *   TranscriptionCreated → auto-generate summary (if enabled)
 *   SummaryGenerated     → auto-extract NER (if enabled)
 *   NerExtracted         → emit PipelineCompleted
 *
 * Pipeline configuration is resolved from the consultation's metadata
 * JSON field (`metadata.pipelineConfig`), falling back to system defaults.
 */

import { Inject, Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ClsService } from 'nestjs-cls';
import { ConsultationRepository } from '@arcaai/domains';
import { IConsultationJobService } from '../jobs/consultation-job.service';
import { PromptResolutionService } from '../prompt/prompt-resolution.service';
import { createWorkerSession } from '../../../common';
import { IActiveUserContext } from '../../../interfaces';
import {
  ConsultationPipelineEvent,
  ConsultationPipelineConfig,
  DEFAULT_PIPELINE_CONFIG,
  TranscriptionCreatedPayload,
  SummaryGeneratedPayload,
  NerExtractedPayload,
  PipelineCompletedPayload,
  PipelineStepFailedPayload,
  PipelineStep,
} from './consultation.events';

@Injectable()
export class ConsultationEventHandler {
  private readonly logger = new Logger(ConsultationEventHandler.name);

  constructor(
    @Inject(IConsultationJobService) private readonly consultationJobService: IConsultationJobService,
    private readonly consultationRepository: ConsultationRepository,
    private readonly promptResolutionService: PromptResolutionService,
    private readonly eventEmitter: EventEmitter2,
    private readonly cls: ClsService<IActiveUserContext>,
  ) {
    this.logger.log('ConsultationEventHandler initialized — auto-pipeline enabled');
  }

  /**
   * Handle TranscriptionCreated event.
   *
   * When a transcript is stored (from WebSocket streaming or batch STT),
   * check the pipeline config and, if auto-summary is enabled, enqueue
   * a summary generation job.
   */
  @OnEvent(ConsultationPipelineEvent.TranscriptionCreated, { async: true })
  async handleTranscriptionCreated(payload: TranscriptionCreatedPayload): Promise<void> {
    const { consultationId, tenantId, contextItemId, jobId, correlationId } = payload;

    // TASK-305 D.9 follow-up — fail-closed when tenantId is missing.
    // Log + early return (not throw): @OnEvent async handlers swallow throws
    // and a throw here would surface as an unhandled rejection. All emitters
    // of this event are services we control with payload schemas requiring
    // tenantId, so this is genuinely defensive.
    if (!tenantId) {
      this.logger.error({
        message: 'TranscriptionCreated handler received payload with missing tenantId — aborting',
        consultationId,
        contextItemId,
        correlationId,
      });
      return;
    }

    // TASK-305 D.9 follow-up — EventEmitter2 async handlers run in their own
    // microtask context that does NOT inherit the caller's AsyncLocalStorage
    // scope. Re-establish CLS from the payload so the Phase B tenantScope
    // Prisma extension sees the correct context for `consultationRepository.findById`
    // and any downstream reads. Empty roles array — workers never have
    // SUPER_ADMIN bypass.
    return this.cls.run(async () => {
      this.cls.set('tenantId', tenantId);
      this.cls.set('user', createWorkerSession({ userId: payload.userId, tenantId, kind: 'transcription-created-event' }));

      this.logger.log({
        message: 'TranscriptionCreated event received',
        consultationId,
        contextItemId,
        jobId,
        correlationId,
      });

      try {
        const config = await this.resolvePipelineConfig(consultationId);

        if (!config.autoSummaryEnabled) {
          this.logger.log({
            message: 'Auto-summary disabled — skipping pipeline',
            consultationId,
            correlationId,
          });
          return;
        }

        // Resolve prompt config via the Department → Default chain (GAP-3).
        // DNA style is per-doctor and resolved separately — not part of prompt resolution (TASK-025).
        const consultation = await this.consultationRepository.findById(consultationId);
        const resolvedPrompt = await this.promptResolutionService.resolve({
          departmentId: consultation?.departmentId ?? undefined,
          explicitTemplate: config.summaryTemplate,
        });

        this.logger.log({
          message: 'Prompt config resolved for auto-summary',
          consultationId,
          resolvedFrom: resolvedPrompt.resolvedFrom,
          template: resolvedPrompt.template,
        });

        const summaryRequest = {
          dnaStyleId: config.dnaStyleId,
          template: resolvedPrompt.template,
          contextItemIds: [contextItemId],
          options: {
            autoGenerated: true,
            correlationId: correlationId ?? payload.jobId,
            promptResolution: resolvedPrompt.resolutionTrace,
          },
        };

        const summaryJob = await this.consultationJobService.createSummaryJob(consultationId, tenantId, payload.userId ?? 'system', summaryRequest);

        this.logger.log({
          message: 'Auto-summary job created',
          consultationId,
          summaryJobId: summaryJob.jobId,
          contextItemId,
          correlationId,
        });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        this.logger.error({
          message: 'Failed to trigger auto-summary',
          consultationId,
          contextItemId,
          error: errorMessage,
          correlationId,
        });

        this.emitPipelineStepFailed({
          consultationId,
          tenantId,
          userId: payload.userId,
          correlationId,
          failedStep: 'summary',
          contextItemId,
          error: errorMessage,
          willContinue: false,
        });
      }
    });
  }

  /**
   * Handle SummaryGenerated event.
   *
   * When a summary is generated (auto or manual), check the pipeline config
   * and, if auto-NER is enabled and the summary was auto-generated, enqueue
   * a NER extraction job on the summary context item.
   */
  @OnEvent(ConsultationPipelineEvent.SummaryGenerated, { async: true })
  async handleSummaryGenerated(payload: SummaryGeneratedPayload): Promise<void> {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { consultationId, tenantId, contextItemId, jobId, isAutoGenerated, correlationId } = payload;

    // TASK-305 D.9 follow-up — fail-closed (log + early return).
    if (!tenantId) {
      this.logger.error({
        message: 'SummaryGenerated handler received payload with missing tenantId — aborting',
        consultationId,
        contextItemId,
        correlationId,
      });
      return;
    }

    // TASK-305 D.9 follow-up — re-establish CLS for the @OnEvent microtask.
    return this.cls.run(async () => {
      this.cls.set('tenantId', tenantId);
      this.cls.set('user', createWorkerSession({ userId: payload.userId, tenantId, kind: 'summary-generated-event' }));

      this.logger.log({
        message: 'SummaryGenerated event received',
        consultationId,
        contextItemId,
        isAutoGenerated,
        correlationId,
      });

      if (!isAutoGenerated) {
        this.logger.debug({
          message: 'Summary was manually triggered — skipping auto-NER',
          consultationId,
          correlationId,
        });
        return;
      }

      try {
        const config = await this.resolvePipelineConfig(consultationId);

        if (!config.autoNerEnabled) {
          this.logger.log({
            message: 'Auto-NER disabled — pipeline stopping after summary',
            consultationId,
            correlationId,
          });

          this.emitPipelineCompleted(payload, ['transcription', 'summary']);
          return;
        }

        const nerJob = await this.consultationJobService.createNerJob(contextItemId, consultationId, tenantId, payload.userId ?? 'system');

        this.logger.log({
          message: 'Auto-NER job created',
          consultationId,
          nerJobId: nerJob.jobId,
          summaryContextItemId: contextItemId,
          correlationId,
        });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        this.logger.error({
          message: 'Failed to trigger auto-NER',
          consultationId,
          contextItemId,
          error: errorMessage,
          correlationId,
        });

        const config = await this.resolvePipelineConfig(consultationId).catch(() => DEFAULT_PIPELINE_CONFIG);

        this.emitPipelineStepFailed({
          consultationId,
          tenantId,
          userId: payload.userId,
          correlationId,
          failedStep: 'ner',
          contextItemId,
          error: errorMessage,
          willContinue: !(config.haltOnFailure ?? false),
        });

        if (!(config.haltOnFailure ?? false)) {
          this.emitPipelineCompleted(payload, ['transcription', 'summary']);
        }
      }
    });
  }

  /**
   * Handle NerExtracted event.
   *
   * Final step of the auto-pipeline. Emit PipelineCompleted to signal
   * that the full transcription → summary → NER cycle has finished.
   */
  @OnEvent(ConsultationPipelineEvent.NerExtracted, { async: true })
  async handleNerExtracted(payload: NerExtractedPayload): Promise<void> {
    const { consultationId, contextItemId, entityCount, isAutoGenerated, correlationId } = payload;
    const tenantId = payload.tenantId;

    // TASK-305 D.9 follow-up — fail-closed (log + early return).
    if (!tenantId) {
      this.logger.error({
        message: 'NerExtracted handler received payload with missing tenantId — aborting',
        consultationId,
        contextItemId,
        correlationId,
      });
      return;
    }

    // TASK-305 D.9 follow-up — re-establish CLS for the @OnEvent microtask.
    return this.cls.run(async () => {
      this.cls.set('tenantId', tenantId);
      this.cls.set('user', createWorkerSession({ userId: payload.userId, tenantId, kind: 'ner-extracted-event' }));

      this.logger.log({
        message: 'NerExtracted event received',
        consultationId,
        contextItemId,
        entityCount,
        isAutoGenerated,
        correlationId,
      });

      if (!isAutoGenerated) {
        this.logger.debug({
          message: 'NER was manually triggered — no pipeline completion',
          consultationId,
          correlationId,
        });
        return;
      }

      this.eventEmitter.emit(ConsultationPipelineEvent.PipelineCompleted, {
        consultationId,
        tenantId,
        userId: payload.userId,
        timestamp: new Date().toISOString(),
        correlationId,
        transcriptContextItemId: contextItemId,
        summaryContextItemId: contextItemId,
        totalEntityCount: entityCount,
        pipelineDurationMs: 0, // Computed by caller if needed
        stepsExecuted: ['transcription', 'summary', 'ner'] as PipelineStep[],
      } satisfies PipelineCompletedPayload);

      this.logger.log({
        message: 'Full pipeline completed',
        consultationId,
        entityCount,
        correlationId,
      });
    });
  }

  // =========================================================================
  // Pipeline Configuration Resolution
  // =========================================================================

  /**
   * Resolve pipeline configuration for a consultation.
   *
   * Resolution order (first non-null wins):
   *   1. Consultation `metadata.pipelineConfig`
   *   2. System defaults (DEFAULT_PIPELINE_CONFIG)
   *
   * Note: dnaStyleId/summaryTemplate from pipelineConfig are passed as explicit
   * overrides to PromptResolutionService, which handles the full
   * Doctor → Department → Default fallback chain (GAP-3).
   */
  async resolvePipelineConfig(consultationId: string): Promise<ConsultationPipelineConfig> {
    try {
      const consultation = await this.consultationRepository.findById(consultationId);
      if (!consultation) {
        this.logger.warn({
          message: 'Consultation not found — using default pipeline config',
          consultationId,
        });
        return { ...DEFAULT_PIPELINE_CONFIG };
      }

      const metadata = consultation.metadata as Record<string, unknown> | null;
      if (metadata?.pipelineConfig) {
        const config = metadata.pipelineConfig as Partial<ConsultationPipelineConfig>;
        return {
          autoSummaryEnabled: config.autoSummaryEnabled ?? DEFAULT_PIPELINE_CONFIG.autoSummaryEnabled,
          autoNerEnabled: config.autoNerEnabled ?? DEFAULT_PIPELINE_CONFIG.autoNerEnabled,
          dnaStyleId: config.dnaStyleId ?? DEFAULT_PIPELINE_CONFIG.dnaStyleId,
          summaryTemplate: config.summaryTemplate ?? DEFAULT_PIPELINE_CONFIG.summaryTemplate,
          includeSharedContext: config.includeSharedContext ?? DEFAULT_PIPELINE_CONFIG.includeSharedContext,
          haltOnFailure: config.haltOnFailure ?? DEFAULT_PIPELINE_CONFIG.haltOnFailure,
        };
      }

      return { ...DEFAULT_PIPELINE_CONFIG };
    } catch (error) {
      this.logger.error({
        message: 'Error resolving pipeline config — using defaults',
        consultationId,
        error: error instanceof Error ? error.message : String(error),
      });
      return { ...DEFAULT_PIPELINE_CONFIG };
    }
  }

  // =========================================================================
  // Private Helpers
  // =========================================================================

  private emitPipelineStepFailed(params: {
    consultationId: string;
    tenantId: string;
    userId?: string;
    correlationId?: string;
    failedStep: PipelineStep;
    contextItemId?: string;
    jobId?: string;
    error: string;
    willContinue: boolean;
  }): void {
    this.eventEmitter.emit(ConsultationPipelineEvent.PipelineStepFailed, {
      consultationId: params.consultationId,
      tenantId: params.tenantId,
      userId: params.userId,
      timestamp: new Date().toISOString(),
      correlationId: params.correlationId,
      failedStep: params.failedStep,
      contextItemId: params.contextItemId,
      jobId: params.jobId,
      error: params.error,
      willContinue: params.willContinue,
    } satisfies PipelineStepFailedPayload);
  }

  private emitPipelineCompleted(payload: SummaryGeneratedPayload, stepsExecuted: PipelineStep[]): void {
    this.eventEmitter.emit(ConsultationPipelineEvent.PipelineCompleted, {
      consultationId: payload.consultationId,
      tenantId: payload.tenantId,
      userId: payload.userId,
      timestamp: new Date().toISOString(),
      correlationId: payload.correlationId,
      transcriptContextItemId: payload.contextItemId,
      summaryContextItemId: payload.contextItemId,
      pipelineDurationMs: 0,
      stepsExecuted,
    } satisfies PipelineCompletedPayload);
  }
}
