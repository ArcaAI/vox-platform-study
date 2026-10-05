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
 *   SummaryGenerated → auto-extract NER (if enabled)
 *   NerExtracted → emit PipelineCompleted
 *
 * Pipeline configuration is resolved from the consultation's metadata
 * JSON field (`metadata.pipelineConfig`), falling back to system defaults.
 */

import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ClsService } from 'nestjs-cls';
import {
  ConsultationProcessing,
  ConsultationRepository,
  ConsultationStatus,
  ContextItemRepository,
  ContextItemType,
  ContextItemVersionRepository,
  DnaWritingStyleReportRepository,
} from '@arcaai/domains';
import { ConfigResolver } from '../../config-resolver';
import { SecretsService } from '../../baseServices/_meta/secrets';
import { validateRedactionRuleSet } from '../../dna-writing-style/redaction-rules';
import { createWorkerSession, isSttAggregateTranscript } from '../../../common';
import { HARNESS_DRAFT_SUBTYPE } from '../harness/harness-draft.constants';
import { IActiveUserContext } from '../../../interfaces';
import { INoteGenerationService, GenerationTrigger } from '../note-generation';
import { tenantWorkflowGoverns } from '../governing-engine';
import { IConsultationWorkflowDispatchService } from '../workflow-dispatch/IConsultationWorkflowDispatchService';
import { contextItemDecryptor } from '../context/client-clinical-context';
import { IConsultationLifecycleGate, IConsultationLifecycleGateToken } from '../lifecycle/IConsultationLifecycleService';
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
    private readonly consultationRepository: ConsultationRepository,
    private readonly eventEmitter: EventEmitter2,
    private readonly cls: ClsService<IActiveUserContext>,
    // the single seam every note-generation entry point routes
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
    // repository reads + the SecretsService decrypts. Both optional + trailing
    // so legacy positional fixtures/DI keep compiling — when either is absent
    // the harness starts with NO redaction rules (safe no-op).
    @Optional() @Inject(DnaWritingStyleReportRepository) private readonly dnaReportRepository?: DnaWritingStyleReportRepository,
    @Optional() @Inject(SecretsService) private readonly secretsService?: SecretsService,
    // TASK-1001 wave 4 (OD-14, D-4) — reads whether the harness draft carries a clinician sign-off.
    // Optional + trailing like every dependency above; absent ⇒ only the consultation status speaks.
    @Optional() @Inject(ContextItemVersionRepository) private readonly contextItemVersionRepository?: ContextItemVersionRepository,
    // TASK-1022 L-RESUME — re-finalises a GOVERNED consultation's resumed recording through its
    // governing graph (supersede the parked run). Optional + trailing like every dependency above;
    // absent ⇒ a governed resume is REPORTED as not re-finalised, never handed to the default engine.
    @Optional() @Inject(IConsultationWorkflowDispatchService) private readonly workflowDispatch?: IConsultationWorkflowDispatchService,
    // Marks the consultation processing FAILED when the resumed-recording check cannot read what
    // it needs. Optional + trailing like every dependency above; absent ⇒ the failure is still
    // reported as `PipelineStepFailed`.
    @Optional() @Inject(IConsultationLifecycleGateToken) private readonly lifecycleGate?: IConsultationLifecycleGate,
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
        // TASK-1001 wave 4 (OD-14; owner decisions D-3/D-4) — a RESUMED recording. Its session's
        // aggregate transcript lands on a consultation whose first draft's document run is parked at
        // the clinician gate, so a plain start is a no-op and the final note would never see what was
        // said after the resume. Decided BEFORE the auto-summary gate on purpose: this path continues
        // a note the harness has already written, it does not start a new one.
        const resumed = await this.resumedSessionPlan(consultationId, contextItemId);
        if (resumed?.kind === 'read_failed') {
          await this.failResumeRead(consultationId, tenantId, payload.userId, contextItemId, correlationId, resumed.error);
          return;
        }
        if (resumed?.kind === 'signed') {
          this.logger.log({
            message: 'Resumed recording transcript on a SIGNED note — not re-finalised (a signed note is never replaced)',
            consultationId,
            contextItemId,
            correlationId,
          });
          return;
        }
        if (resumed?.kind === 'stale') {
          this.logger.log({
            message: 'Resumed recording transcript is not the newest recording of this governed consultation — the newest one re-finalises',
            consultationId,
            contextItemId,
            correlationId,
          });
          return;
        }
        if (resumed?.kind === 'governed') {
          await this.refinaliseGovernedResume(consultationId, tenantId, payload.userId, contextItemId, correlationId);
          return;
        }
        if (resumed?.kind === 'supersede') {
          const redactionRules = await this.resolveRedactionRulesForHarness(consultationId, tenantId);
          const decision = await this.noteGenerationService.generate(GenerationTrigger.TRANSCRIPTION_CREATED, {
            consultationId,
            tenantId,
            userId: payload.userId,
            correlationId: correlationId ?? payload.jobId,
            contextItemId,
            transcriptText: resumed.transcriptText,
            redactionRules,
            supersede: true,
          });
          this.logger.log({
            message: 'Resumed recording — re-finalising the note over the whole visit (supersedes the open draft run)',
            consultationId,
            contextItemId,
            sessions: resumed.sessions,
            generator: decision.generator,
            correlationId,
          });
          return;
        }

        const config = await this.noteGenerationService.resolveConfig(consultationId);

        if (!config.autoSummaryEnabled) {
          this.logger.log({
            message: 'Auto-summary disabled — skipping pipeline',
            consultationId,
            correlationId,
          });
          return;
        }

        // trigger-specific request assembly (transcript-loading +
        // DNA-redaction resolution) stays here; it is passed to the seam as
        // params rather than decided here. Prepared unconditionally so it is
        // ready regardless of which generator the seam picks — the seam owns
        // the generator decision, this handler no longer reads it.
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

        // The single seam every note-generation entry point routes through.
        // When routing to harness it starts the workflow itself; a missing
        // HarnessGatewayService on a harness-supported trigger THROWS (surfaces
        // below as PipelineStepFailed) rather than silently no-op'ing.
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

        // the legacy `SUMMARY_REGENERATE` async generator
        // (`summary.processor.ts` / `createSummaryJob`) that used to run here
        // on `decision.generator === 'legacy'` was deleted along with the
        // rest of the signable generator path. `TRANSCRIPTION_CREATED` is a
        // harness-supported trigger (`HARNESS_SUPPORTED_TRIGGERS`), and since
        // TASK-882 there is no `harnessEnabled` toggle that could route it
        // elsewhere — so this branch is unreachable on the seam's own contract
        // and kept only as the VISIBLE queued failure the type still permits:
        // never a silent no-op, and never a resurrection of the legacy generator.
        this.logger.error({
          message: 'Seam resolved to the legacy generator, which no longer exists — no note will be generated for this trigger',
          consultationId,
          contextItemId,
          correlationId,
          reason: decision.reason,
        });
        this.emitPipelineStepFailed({
          consultationId,
          tenantId,
          userId: payload.userId,
          correlationId,
          failedStep: 'summary',
          contextItemId,
          error: `Legacy generator unavailable (seam reason: ${decision.reason}) — every consultation note is generated by the harness`,
          willContinue: false,
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
        // The harness workflow persists its own NamedEntity rows for the same
        // content (server-side NER inside the durable workflow — the `agent.ner`
        // node's own `enabled`), and the legacy BullMQ NER generator was deleted.
        // TASK-882 removed the `pipeline.autoNerEnabled` read that used to sit
        // here: both of its branches ended in exactly this completion event.
        this.logger.log({
          message: 'Skipping legacy auto-NER job — the legacy NER generator was deleted; harness workflows persist their own NamedEntity rows',
          consultationId,
          contextItemId,
          correlationId,
        });

        this.emitPipelineCompleted(payload, ['transcription', 'summary']);
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
   * TASK-1001 wave 4 (OD-14) — is `contextItemId` a RESUMED session's aggregate transcript on a
   * consultation that already holds a harness draft, and may that draft be replaced?
   *
   *  - `null` — not a resume (the first session), or no draft yet (the first finalize is still
   *    running and its assemble reloads every transcript): today's path, unchanged.
   *  - `signed` — the draft carries a clinician sign-off, or the consultation is signed (D-4).
   *  - `supersede` — re-finalise over EVERY session's aggregate, oldest first.
   *
   * TASK-1022 L-RESUME (owner decision 2026-09-30) — a consultation GOVERNED by a tenant workflow is
   * re-finalised by its governing graph, never by the default engine:
   *
   *  - `governed` — supersede the governing run. Needs no draft: the governing run owns the note, and
   *    a run that has not finalised yet is superseded just the same (its replacement reads the
   *    whole-visit handoff).
   *  - `stale` — `contextItemId` is not the NEWEST recording's aggregate: a newer stop re-finalises,
   *    and superseding here would only start a run that is replaced a moment later.
   *
   *  - `read_failed` — the check could not read what it needs. NOT `null`: falling back to the
   *    first-session path would start a note over a partial view of the visit (or replace a signed
   *    one), so the caller reports the failure and marks processing FAILED instead.
   */
  private async resumedSessionPlan(
    consultationId: string,
    contextItemId: string,
  ): Promise<
    | { kind: 'signed' }
    | { kind: 'supersede'; transcriptText: string; sessions: number }
    | { kind: 'governed' }
    | { kind: 'stale' }
    | { kind: 'read_failed'; error: string }
    | null
  > {
    if (!this.contextItemRepository) return null;
    try {
      const transcripts = await this.contextItemRepository.findTranscripts(consultationId);
      const aggregates = transcripts
        .filter((item) => isSttAggregateTranscript(item))
        .sort((a, b) => new Date(a.createdAt ?? 0).getTime() - new Date(b.createdAt ?? 0).getTime());
      if (!aggregates.some((item) => item.id !== contextItemId)) return null;

      const drafts = (await this.contextItemRepository.findByType(consultationId, ContextItemType.RAW_SUMMARY)).filter(
        (row) => (row.metaData as Record<string, unknown> | undefined)?.subType === HARNESS_DRAFT_SUBTYPE,
      );
      const draft =
        drafts.length === 0 ? null : drafts.reduce((a, b) => (new Date(a.createdAt ?? 0).getTime() >= new Date(b.createdAt ?? 0).getTime() ? a : b));

      const consultation = await this.consultationRepository.findById(consultationId);
      const governed = tenantWorkflowGoverns(consultation?.metadata);
      if (!draft && !governed) return null;

      const signedStatuses: readonly string[] = [ConsultationStatus.APPROVED, ConsultationStatus.CLOSED_COMPLETE];
      const approvals = draft ? ((await this.contextItemVersionRepository?.getVersionsByChangeReason(draft.id, 'approved')) ?? []) : [];
      if (signedStatuses.includes(String(consultation?.status)) || approvals.length > 0) return { kind: 'signed' };

      if (governed) return aggregates[aggregates.length - 1]?.id === contextItemId ? { kind: 'governed' } : { kind: 'stale' };

      const transcriptText = aggregates
        .map((item) => item.content?.trim())
        .filter((text): text is string => !!text)
        .join('\n\n');
      return { kind: 'supersede', transcriptText, sessions: aggregates.length };
    } catch (error) {
      return { kind: 'read_failed', error: error instanceof Error ? error.message : String(error) };
    }
  }

  /**
   * The resumed-recording check could not read the consultation's transcripts, drafts or status.
   * Nothing is generated: the failure is REPORTED (`PipelineStepFailed`) and the consultation's
   * processing becomes FAILED `RESUME_READ_FAILED`, so the clinician sees why no note arrived.
   * The processing write is best-effort — the event is the record.
   */
  private async failResumeRead(
    consultationId: string,
    tenantId: string,
    userId: string | undefined,
    contextItemId: string,
    correlationId: string | undefined,
    error: string,
  ): Promise<void> {
    this.logger.error({
      message: 'Resumed-recording check failed — note generation not started',
      consultationId,
      contextItemId,
      correlationId,
      error,
    });
    this.emitPipelineStepFailed({
      consultationId,
      tenantId,
      userId,
      correlationId,
      failedStep: 'summary',
      contextItemId,
      error: `Resumed-recording check failed: ${error}`,
      willContinue: false,
    });
    try {
      await this.lifecycleGate?.setProcessing(consultationId, ConsultationProcessing.FAILED, 'RESUME_READ_FAILED');
    } catch (gateError) {
      this.logger.warn({
        message: 'Could not mark the consultation processing FAILED after a resumed-recording read failure (best-effort)',
        consultationId,
        error: gateError instanceof Error ? gateError.message : String(gateError),
      });
    }
  }

  /**
   * TASK-1022 L-RESUME — re-finalise a GOVERNED consultation after a resumed recording, through its
   * governing graph (`IConsultationWorkflowDispatchService.supersedeGoverningRun`).
   *
   * Never the default engine, whatever happens: handing a governed consultation to `harness-doc`
   * replaces the tenant's note shape with the default one (TASK-1022 replay run3). A supersede that
   * did not happen is therefore REPORTED (`PipelineStepFailed`) and the note stays what the governing
   * run last wrote. `duplicate` is not a failure — the same stop was already handled.
   */
  private async refinaliseGovernedResume(
    consultationId: string,
    tenantId: string,
    userId: string | undefined,
    contextItemId: string,
    correlationId: string | undefined,
  ): Promise<void> {
    const reportFailure = (error: string): void => {
      this.logger.error({
        message: 'Governed resume NOT re-finalised — the note still covers only the earlier recordings',
        consultationId,
        contextItemId,
        correlationId,
        error,
      });
      this.emitPipelineStepFailed({
        consultationId,
        tenantId,
        userId,
        correlationId,
        failedStep: 'summary',
        contextItemId,
        error,
        willContinue: false,
      });
    };

    if (!this.workflowDispatch?.supersedeGoverningRun) {
      reportFailure('The governing-workflow dispatcher is not wired — a governed consultation is never re-finalised by the default engine');
      return;
    }

    const result = await this.workflowDispatch.supersedeGoverningRun({
      consultationId,
      tenantId,
      userId,
      triggerId: contextItemId,
      authoredContext: await this.authoredContextOf(consultationId),
    });
    if (!result.superseded && result.skippedReason !== 'duplicate') {
      reportFailure(`Governing run not superseded (${result.skippedReason ?? 'unknown'}${result.reason ? `: ${result.reason}` : ''})`);
      return;
    }
    this.logger.log({
      message: result.superseded
        ? 'Resumed recording — the governing graph re-finalises the note over the whole visit (governing run superseded)'
        : 'Resumed recording — already re-finalised by the governing graph for this recording',
      consultationId,
      contextItemId,
      runId: result.runId,
      supersededRunId: result.supersededRunId,
      correlationId,
    });
  }

  /**
   * The client's authored context as the `{ [kindKey]: payload }` envelope the governing trigger
   * validates, rebuilt from the consultation's persisted STRUCTURED kinds — newest item per kind.
   *
   * The open-time payload is not kept anywhere else: `open` persists every validated kind as a
   * STRUCTURED item carrying its `kindKey` (TASK-951 §D-5) and hands the same values to the first run
   * (§D-6). A kind added later through the context plane was validated against the same schema, and
   * the newest statement is the one the note should reflect. Best-effort: an unreadable item is
   * skipped, and nothing readable means `null` — the run starts without a payload.
   */
  private async authoredContextOf(consultationId: string): Promise<Record<string, unknown> | null> {
    if (!this.contextItemRepository) return null;
    try {
      const items = await this.contextItemRepository.findByType(consultationId, ContextItemType.STRUCTURED);
      const newest = new Map<string, (typeof items)[number]>();
      for (const item of items) {
        if (!item.kindKey) continue;
        const current = newest.get(item.kindKey);
        if (!current || new Date(item.createdAt ?? 0).getTime() >= new Date(current.createdAt ?? 0).getTime()) newest.set(item.kindKey, item);
      }
      const decrypt = contextItemDecryptor(this.contextItemRepository, this.secretsService as never);
      const authored: Record<string, unknown> = {};
      for (const [kindKey, item] of newest) {
        try {
          const raw = await decrypt(item);
          const parsed: unknown = raw ? JSON.parse(raw) : null;
          if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) authored[kindKey] = parsed;
        } catch {
          // swallow-ok: an unreadable or non-JSON kind is simply not carried (PHI-free: nothing of
          // the body is logged); the trigger validates what remains, exactly as an open without it.
        }
      }
      return Object.keys(authored).length > 0 ? authored : null;
    } catch (error) {
      this.logger.warn({
        message: 'Authored context could not be rebuilt for the governed resume — the superseding run starts without it',
        consultationId,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * Resolve the doctor's DNA redaction/rewrite rules for a harness start.
   *
   * Double-gated: the TENANT gate is now the presence of an ACTIVE
   * `agent.dna_redaction` node in the tenant's governing consultation graph
   * (lane A item 2 — the owner's rider on the delta), and the
   * DOCTOR gate is the clinician's own DNA opt-in. The department default-agent
   * `dnaStylePolicy=DISABLED` veto that used to sit alongside them is gone and
   * stays gone. When effective, the rules are read from the doctor's latest DNA
   * report and decrypted via the SecretsService, then validated to the persisted
   * `{ rules: [...] }` shape.
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

      // A THIRD gate used to sit here: the department's default
      // `DepartmentAgent.dnaStylePolicy = DISABLED` forced redaction OFF for the
      // whole department. It retired with `DepartmentAgent` and stays
      // retired by owner ruling. What DID get a successor is the tenant gate: it
      // is no longer a `dnaRedactionEnabled` boolean but the presence of an ACTIVE
      // `agent.dna_redaction` node in this tenant's governing consultation graph.
      // See `ConfigResolver.resolveEffectiveDnaRedactionEnabled`.
      const { effective } = await this.configResolver.resolveEffectiveDnaRedactionEnabled({
        tenantId,
        departmentId,
        doctorId,
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
