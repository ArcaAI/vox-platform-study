/**
 * ConsultationEventHandler
 *
 * Drives the automatic consultation processing pipeline.
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
import {
  ConsultationRepository,
  ContextItemRepository,
  DnaWritingStyleReportRepository,
  DepartmentAgentRepository,
  DepartmentAgentDnaPolicy,
} from '@arcaai/domains';
import { IConsultationJobService } from '../jobs/consultation-job.service';
import { PromptResolutionService } from '../prompt/prompt-resolution.service';
import { ConfigResolver } from '../../config-resolver';
import { SecretsService } from '../../baseServices/_meta/secrets';
import { validateRedactionRuleSet } from '../../dna-writing-style/redaction-rules';
import { createWorkerSession } from '../../../common';
import { IActiveUserContext } from '../../../interfaces';
import { INoteGenerationService, GenerationTrigger } from '../note-generation';
import {
  ConsultationPipelineEvent,
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
    // TASK-704 — the single seam every note-generation entry point routes
    // through. Owns pipeline-config resolution (moved verbatim from this
    // handler's former `resolvePipelineConfig`) and the harnessEnabled read +
    // harness-vs-legacy decision (formerly inline here against
    // HarnessGatewayService directly). REQUIRED — the handler has no local
    // fallback for config resolution now that it lives on the seam; a
    // missing wiring is a boot-time DI error, not a silent legacy-only mode.
    @Inject(INoteGenerationService) private readonly noteGenerationService: INoteGenerationService,
    // Used only on the harness path to forward the triggering
    // transcript's text to the durable workflow. Optional + trailing so the
    // legacy fixtures/DI keep compiling.
    @Optional() @Inject(ContextItemRepository) private readonly contextItemRepository?: ContextItemRepository,
    // (Pillar B) — resolves the realtime toggles through the
    // tenant→department→doctor→SYSTEM cascade and the doctor-preferred prompt id.
    // Optional + trailing so existing positional fixtures keep compiling; when
    // absent, `resolveRedactionRulesForHarness` below preserves the legacy
    // no-redaction behaviour (the cascade toggles themselves are resolved by
    // NoteGenerationService.resolveConfig, which has its own ConfigResolver).
    @Optional() @Inject(ConfigResolver) private readonly configResolver?: ConfigResolver,
    // The last-mile DNA-redaction resolution deps (harness path only).
    // The rules live encrypted-at-rest on the doctor's latest DNA report; the
    // repository reads + the SecretsService decrypts. The DepartmentAgent repo
    // supplies the department default-agent DNA-policy gate. All optional +
    // trailing so legacy positional fixtures/DI keep compiling — when any is
    // absent the harness starts with NO redaction rules (safe no-op).
    @Optional() @Inject(DnaWritingStyleReportRepository) private readonly dnaReportRepository?: DnaWritingStyleReportRepository,
    @Optional() @Inject(SecretsService) private readonly secretsService?: SecretsService,
    @Optional() @Inject(DepartmentAgentRepository) private readonly departmentAgentRepository?: DepartmentAgentRepository,
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

    // Fail-closed when tenantId is missing.
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

    // EventEmitter2 async handlers run in their own
    // microtask context that does NOT inherit the caller's AsyncLocalStorage
    // scope. Re-establish CLS from the payload so the tenantScope
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
        const config = await this.noteGenerationService.resolveConfig(consultationId);

        if (!config.autoSummaryEnabled) {
          this.logger.log({
            message: 'Auto-summary disabled — skipping pipeline',
            consultationId,
            correlationId,
          });
          return;
        }

        // TASK-704 — trigger-specific request assembly (transcript-loading +
        // DNA-redaction resolution) stays here; it is passed to the seam as
        // params rather than decided here. Prepared unconditionally so it is
        // ready regardless of which generator the seam picks — the seam owns
        // the harnessEnabled decision, this handler no longer reads it.
        //
        // Best-effort: forward the triggering transcript's text so a harness
        // start can run NER + sensors on it. A read miss must not block
        // anything — the assemble callback re-loads the transcript on the
        // apps/api side (the prompt's source of truth) when routed to
        // harness, and the legacy path never reads this value at all.
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

        // Resolve + decrypt the doctor's DNA redaction rules when
        // the tenant + doctor double-gate (and the department default-agent DNA
        // policy) permit it. Fail-SAFE: any failure yields NO rules, which
        // makes the workflow's apply_redaction insertion a byte-identical no-op
        // — a harness start is NEVER blocked by redaction resolution.
        const redactionRules = await this.resolveRedactionRulesForHarness(consultationId, tenantId);

        // The single seam every note-generation entry point routes through
        // (TASK-704). It reads harnessEnabled, and — when routing to
        // harness — starts the workflow itself; a missing HarnessGatewayService
        // on a harness-enabled trigger THROWS (surfaces below as
        // PipelineStepFailed) rather than silently no-op'ing.
        const decision = await this.noteGenerationService.generate(GenerationTrigger.TRANSCRIPTION_CREATED, {
          consultationId,
          tenantId,
          userId: payload.userId,
          correlationId: correlationId ?? payload.jobId,
          contextItemId,
          transcriptText,
          redactionRules,
        });

        if (decision.generator === 'harness') {
          this.logger.log({
            message: 'Harness document workflow start requested',
            consultationId,
            harnessJobId: decision.harnessJobId,
            contextItemId,
            correlationId,
          });
          return;
        }

        // Resolve prompt config via the doctor-preferred → Department → Default
        // chain. DNA style is per-doctor and
        // resolved separately — not part of prompt resolution.
        const consultation = await this.consultationRepository.findById(consultationId);
        // Thread the doctor's preferred prompt id on the
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
    const { consultationId, tenantId, contextItemId, isAutoGenerated, correlationId } = payload;

    // Fail-closed (log + early return).
    if (!tenantId) {
      this.logger.error({
        message: 'SummaryGenerated handler received payload with missing tenantId — aborting',
        consultationId,
        contextItemId,
        correlationId,
      });
      return;
    }

    // Re-establish CLS for the @OnEvent microtask.
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
        const config = await this.noteGenerationService.resolveConfig(consultationId);

        if (!config.autoNerEnabled) {
          this.logger.log({
            message: 'Auto-NER disabled — pipeline stopping after summary',
            consultationId,
            correlationId,
          });

          this.emitPipelineCompleted(payload, ['transcription', 'summary']);
          return;
        }

        // (F-22, Lane G) — when the harness workflow owns this
        // consultation, it persists its own NamedEntity rows for the same
        // content (server-side NER inside the durable workflow), so the
        // legacy BullMQ NER job would be duplicate work. Skip it.
        //
        // TASK-704 grep-gate NOTE: this is a SECOND, deliberate runtime read
        // of `harnessEnabled` outside `NoteGenerationService`. It answers a
        // different question than the seam ("should the legacy NER job be
        // skipped as duplicate work?", not "which generator produces the
        // note?") and predates + is explicitly out of scope for TASK-704's
        // Current State Evaluation §2.1 (which enumerates NOTE-generation
        // entry points only — NER extraction is a separate pipeline step).
        // The grep-gate test allow-lists exactly this site by name; do not
        // add a second one without updating that allow-list + this comment.
        if (config.harnessEnabled) {
          this.logger.log({
            message: 'Skipping legacy auto-NER job — harness workflow persists its own NamedEntity rows',
            consultationId,
            contextItemId,
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

        const config = await this.noteGenerationService.resolveConfig(consultationId);

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

    // Fail-closed (log + early return).
    if (!tenantId) {
      this.logger.error({
        message: 'NerExtracted handler received payload with missing tenantId — aborting',
        consultationId,
        contextItemId,
        correlationId,
      });
      return;
    }

    // Re-establish CLS for the @OnEvent microtask.
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
  // DNA redaction rule resolution (harness path)
  // =========================================================================

  /**
   * Resolve the doctor's DNA redaction/rewrite rules for a harness start.
   *
   * Double-gated exactly like the DNA-style feature — tenant permission AND the
   * doctor's DNA opt-in — plus the department default-agent DNA policy
   * (`dnaStylePolicy=DISABLED` forces OFF). When effective, the rules are read
   * from the doctor's latest DNA report and decrypted via the SecretsService,
   * then validated to the persisted `{ rules: [...] }` shape.
   *
   * FAIL-SAFE (deliberate, per the ticket): any gate/lookup/decrypt/validation
   * failure — or missing DI (legacy fixtures) — yields an EMPTY rule set. Empty
   * rules make the workflow's `apply_redaction` insertion a no-op, so the harness
   * start is never blocked; the note still flows through the normal assurance
   * lane. (The fail-CLOSED-to-FLAG behaviour lives inside the workflow and only
   * engages when rules are actually present.) Returns the rules as the loose
   * `Record<string, unknown>[]` the transport carries.
   */
  private async resolveRedactionRulesForHarness(consultationId: string, tenantId: string): Promise<Record<string, unknown>[]> {
    // No resolver wired ⇒ preserve the exact legacy (no-redaction) behaviour.
    if (!this.configResolver) return [];

    try {
      const consultation = await this.consultationRepository.findById(consultationId);
      const doctorId = consultation?.doctorId ?? null;
      const departmentId = consultation?.departmentId ?? null;

      // Department default-agent gate: DISABLED forces redaction OFF for the
      // whole department. Best-effort — a lookup miss leaves the tenant/doctor
      // gates authoritative.
      let departmentAgentDnaDisabled = false;
      if (departmentId && this.departmentAgentRepository) {
        try {
          const defaultAgent = await this.departmentAgentRepository.findDefaultForDepartment(tenantId, departmentId);
          departmentAgentDnaDisabled = defaultAgent?.dnaStylePolicy === DepartmentAgentDnaPolicy.DISABLED;
        } catch (agentError) {
          this.logger.warn({
            message: 'Default department-agent lookup failed for DNA redaction gate (best-effort)',
            consultationId,
            departmentId,
            error: agentError instanceof Error ? agentError.message : String(agentError),
          });
        }
      }

      const { effective } = await this.configResolver.resolveEffectiveDnaRedactionEnabled({
        tenantId,
        departmentId,
        doctorId,
        departmentAgentDnaDisabled,
      });
      if (!effective || !doctorId) return [];

      // Rules are encrypted-at-rest on the doctor's latest DNA report.
      if (!this.dnaReportRepository || !this.secretsService) return [];
      const report = await this.dnaReportRepository.findLatestForDoctor(doctorId);
      if (!report) return [];

      const { redactionRules } = await this.dnaReportRepository.decryptFieldsFromEntity(report, this.secretsService);
      if (!redactionRules) return [];

      // Validate the persisted shape (throws on malformed ⇒ caught below).
      const ruleSet = validateRedactionRuleSet(redactionRules);
      return ruleSet.rules as unknown as Record<string, unknown>[];
    } catch (error) {
      this.logger.warn({
        message: 'DNA redaction rule resolution failed — starting harness without rules (fail-safe)',
        consultationId,
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
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
