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

import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ClsService } from 'nestjs-cls';
import { randomUUID } from 'node:crypto';
import { ConsultationRepository, ContextItemRepository } from '@arcaai/domains';
import { IConsultationJobService } from '../jobs/consultation-job.service';
import { PromptResolutionService } from '../prompt/prompt-resolution.service';
import { HarnessGatewayService } from '../harness/harness-gateway.service';
import { ConfigResolver } from '../../config-resolver';
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
    // TASK-330 Phase 1 (Lane G) — optional so existing unit fixtures (and any
    // deployment without the harness wired) keep the legacy path. Only invoked
    // when pipelineConfig.harnessEnabled is true.
    @Optional() @Inject(HarnessGatewayService) private readonly harnessGatewayService?: HarnessGatewayService,
    // TASK-330 Phase 1 — used only on the harness path to forward the triggering
    // transcript's text to the durable workflow. Optional + trailing so the
    // legacy fixtures/DI keep compiling.
    @Optional() @Inject(ContextItemRepository) private readonly contextItemRepository?: ContextItemRepository,
    // TASK-356 Phase 5 (Pillar B) — resolves the realtime toggles through the
    // tenant→department→doctor→SYSTEM cascade and the doctor-preferred prompt id.
    // Optional + trailing so existing positional fixtures keep compiling; when
    // absent the resolver falls back to DEFAULT_PIPELINE_CONFIG (legacy behaviour).
    @Optional() @Inject(ConfigResolver) private readonly configResolver?: ConfigResolver,
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
    // GLOBAL_ADMIN bypass.
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

        // TASK-330 Phase 1 (Lane G) — when the harness flag is set, route
        // auto-generation to the durable harness workflow instead of the legacy
        // BullMQ summary job. A jobId is minted so the harness can publish SSE
        // progress on the existing `consultation_job_updates:{jobId}` channel.
        if (config.harnessEnabled) {
          const harnessJobId = `harness-doc-${randomUUID()}`;
          // Best-effort: forward the triggering transcript's text so the workflow
          // can run NER + sensors on it. A read miss must not block the start —
          // the assemble callback re-loads the transcript on the apps/api side
          // (the prompt's source of truth), so we degrade gracefully.
          let transcriptText: string | undefined;
          try {
            const transcript = await this.contextItemRepository?.findById(contextItemId);
            transcriptText = transcript?.content ?? undefined;
          } catch (loadError) {
            this.logger.warn({
              message: 'Failed to load transcript text for harness start (best-effort)',
              consultationId,
              contextItemId,
              error: loadError instanceof Error ? loadError.message : String(loadError),
            });
          }

          await this.harnessGatewayService?.start(consultationId, {
            tenantId,
            userId: payload.userId,
            jobId: harnessJobId,
            correlationId: correlationId ?? payload.jobId,
            contextItemId,
            transcriptText,
          });

          this.logger.log({
            message: 'Harness document workflow start requested',
            consultationId,
            harnessJobId,
            contextItemId,
            correlationId,
          });
          return;
        }

        // Resolve prompt config via the doctor-preferred → Department → Default
        // chain (GAP-3 + TASK-356 Phase 5 §2.5). DNA style is per-doctor and
        // resolved separately — not part of prompt resolution (TASK-025).
        const consultation = await this.consultationRepository.findById(consultationId);
        // TASK-356 Phase 5 — thread the doctor's preferred prompt id on the
        // legacy auto path (was previously dropped here); the resolver reads
        // UserProfile.preferredPromptTemplateId and is null-safe.
        const preferredPromptTemplateId = this.configResolver
          ? await this.configResolver.resolvePreferredPromptTemplateId(consultation?.doctorId ?? null)
          : undefined;
        const resolvedPrompt = await this.promptResolutionService.resolve({
          departmentId: consultation?.departmentId ?? undefined,
          explicitTemplate: config.summaryTemplate,
          preferredPromptTemplateId: preferredPromptTemplateId ?? undefined,
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
   *   1. Consultation `metadata.pipelineConfig` (per-consultation override, kept
   *      as the top overlay for back-compat).
   *   2. The `PipelinePolicy` cascade via `ConfigResolver` — doctor → department
   *      → tenant → SYSTEM-tenant default (TASK-356 Phase 5, Pillar B). Resolves
   *      `autoSummaryEnabled` / `autoNerEnabled` / `harnessEnabled`.
   *   3. System code defaults (`DEFAULT_PIPELINE_CONFIG`) — also the fallback when
   *      the resolver is not wired (legacy DI/fixtures).
   *
   * Note: dnaStyleId/summaryTemplate stay per-consultation (metadata) and are
   * passed as explicit overrides to PromptResolutionService, which handles the
   * full Doctor → Department → Default fallback chain (GAP-3). Fail-closed: any
   * error degrades to the safe code defaults (never throws on the realtime path).
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
      const override = (metadata?.pipelineConfig ?? {}) as Partial<ConsultationPipelineConfig>;

      // Cascade-resolved toggles (doctor → department → tenant → SYSTEM default).
      // When the resolver isn't wired, fall back to the code defaults so the
      // legacy behaviour is preserved exactly.
      const cascade = this.configResolver
        ? await this.configResolver.resolvePipelineToggles({
            tenantId: consultation.tenantId,
            departmentId: consultation.departmentId ?? null,
            doctorId: consultation.doctorId ?? null,
          })
        : null;

      const resolved: ConsultationPipelineConfig = {
        // The cascade owns the realtime toggles; the per-consultation metadata
        // override wins on top (back-compat).
        autoSummaryEnabled: override.autoSummaryEnabled ?? cascade?.autoSummaryEnabled ?? DEFAULT_PIPELINE_CONFIG.autoSummaryEnabled,
        autoNerEnabled: override.autoNerEnabled ?? cascade?.autoNerEnabled ?? DEFAULT_PIPELINE_CONFIG.autoNerEnabled,
        // dnaStyleId / summaryTemplate / includeSharedContext stay per-consultation.
        dnaStyleId: override.dnaStyleId ?? DEFAULT_PIPELINE_CONFIG.dnaStyleId,
        summaryTemplate: override.summaryTemplate ?? DEFAULT_PIPELINE_CONFIG.summaryTemplate,
        includeSharedContext: override.includeSharedContext ?? DEFAULT_PIPELINE_CONFIG.includeSharedContext,
        haltOnFailure: override.haltOnFailure ?? DEFAULT_PIPELINE_CONFIG.haltOnFailure,
      };

      // harnessEnabled: per-consultation override wins over the cascade. Only
      // surfaced when defined so callers reading a fully-specified legacy config
      // (no resolver) don't see a synthesized default (preserves back-compat).
      const harnessEnabled = override.harnessEnabled ?? cascade?.harnessEnabled;
      if (harnessEnabled !== undefined) {
        resolved.harnessEnabled = harnessEnabled;
      }

      return resolved;
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
