import { randomUUID } from 'node:crypto';
import { HttpException, Inject, Injectable, Logger, Optional, ServiceUnavailableException } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import { ClsService } from 'nestjs-cls';
import { ConsultationProcessing, ConsultationRepository, ConsultationStatus, ResourceType } from '@arcaai/domains';
import { BaseService } from '../../../common';
import { IActiveUserContext } from '../../../interfaces';
import { IRedisCacheService } from '../../baseServices/redis';
import { ConfigResolver } from '../../config-resolver';
import { HarnessGatewayService } from '../harness/harness-gateway.service';
import { HarnessInternalService } from '../harness/harness-internal.service';
import { IConsultationLifecycleGate, IConsultationLifecycleGateToken } from '../lifecycle/IConsultationLifecycleService';
import { NOTE_INPUT_EXCEEDS_CONTEXT, type NotePlanRef } from '../note-composition/note-plan.types';
import {
  ConsultationPipelineConfig,
  ConsultationPipelineEvent,
  DEFAULT_PIPELINE_CONFIG,
  type LifecycleChangedPayload,
} from '../events/consultation.events';
import { IConsultationJobService } from '../jobs/consultation-job.service';
import { NOTE_READY_REASON } from '../lifecycle/legacy-status-projection';
import { NOTE_REFINALIZE_CLAIM_TTL_SECONDS } from '../workflow-dispatch/encounter-refinalize';
import { EncounterRefinalizeService } from '../workflow-dispatch/encounter-refinalize.service';
import { INoteGenerationService } from './INoteGenerationService';
import { GenerateParams, GenerationDecision, GenerationDecisionHarness, GenerationTrigger, HARNESS_SUPPORTED_TRIGGERS } from './types';
import { tenantWorkflowGoverns } from '../governing-engine';

/** The note jobs no run carries (see `watchNoteJob`), per consultation. */
export function noteJobWatchKey(consultationId: string): string {
  return `consultation:note-job-watch:${consultationId}`;
}

const WATCH_ADD_SCRIPT = "redis.call('SADD', KEYS[1], ARGV[1]); return redis.call('EXPIRE', KEYS[1], ARGV[2])";
const WATCH_TAKE_SCRIPT = "local m = redis.call('SMEMBERS', KEYS[1]); redis.call('DEL', KEYS[1]); return m";

/**
 * What a lifecycle change means for a waiting note job: the note is written (STOPPED and IDLE +
 * NOTE_READY, or AWAITING_REVIEW), the note path failed (FAILED), or nothing yet.
 */
export function noteJobOutcomeOf(event: { status: string; processing: string; processingReason?: string | null }): 'completed' | 'failed' | null {
  if (event.processing === ConsultationProcessing.FAILED) return 'failed';
  if (event.status !== ConsultationStatus.STOPPED) return null;
  if (event.processing === ConsultationProcessing.AWAITING_REVIEW) return 'completed';
  return event.processing === ConsultationProcessing.IDLE && event.processingReason === NOTE_READY_REASON ? 'completed' : null;
}

/**
 * Generator Entry-Point Seam.
 *
 * The single seam every consultation note-generation entry point routes
 * through (for the full seven-entry-point map).
 * TASK-882: `pipeline.harnessEnabled` is gone — `false` routed to a legacy generator that no
 * longer existed, so every harness-supported trigger routes to the harness, and `generate()`
 * makes the one remaining decision (does this TRIGGER have a harness equivalent).
 *
 * `NoteGenerationService` is deliberately named to become the interpreter
 * dispatcher once the workflow substrate exists (Wave 2+, D4/ 1 in
 * design.md). Nothing about that future is built here — this is entry-point
 * consolidation only.
 */
@Injectable()
export class NoteGenerationService extends BaseService implements INoteGenerationService {
  private readonly logger = new Logger(NoteGenerationService.name);

  constructor(
    private readonly consultationRepository: ConsultationRepository,
    // REQUIRED, NOT @Optional() — this is the throw-loud fix for the
    // silent-drop defect. Nest DI fails fast at boot if
    // HarnessGatewayServiceModule isn't imported into whatever module
    // provides NoteGenerationService, which is the desired failure mode
    // (a missing gateway on a harness-enabled trigger must be loud, never a
    // success-shaped log with zero notes produced).
    private readonly harnessGatewayService: HarnessGatewayService,
    protected override readonly eventEmitter: EventEmitter2,
    protected override readonly clsService: ClsService<IActiveUserContext>,
    // The graph-node resolver (auto-summary is the assigned workflow's generation node,
    // TASK-882) — optional + trailing so legacy positional fixtures keep compiling; when absent,
    // resolveConfig falls back to DEFAULT_PIPELINE_CONFIG.
    @Optional() @Inject(ConfigResolver) private readonly configResolver?: ConfigResolver,
    // The note plan is composed by `HarnessInternalService`, reached at call time: its module
    // imports ConsultationJobServiceModule, which imports this one, so a static import would close
    // a module cycle. Optional + trailing so positional fixtures keep compiling.
    @Optional() private readonly moduleRef?: ModuleRef,
    @Optional() @Inject(IConsultationLifecycleGateToken) private readonly lifecycleGate?: IConsultationLifecycleGate,
    // Holds the note jobs no run carries (`watchNoteJob`). Unwired ⇒ such a job is not watched.
    @Optional() @Inject(IRedisCacheService) private readonly redis?: Pick<IRedisCacheService, 'eval'>,
  ) {
    // NoteGenerationService wraps existing generation calls and never
    // broadcasts its own sys-events (the wrapped services already do — see
    // so `resourceType` here is never actually used to emit an
    // event; ResourceType.Consultation is the closest fit for the
    // BaseService contract.
    super(eventEmitter, clsService, ResourceType.Consultation);
  }

  async generate(trigger: GenerationTrigger, params: GenerateParams): Promise<GenerationDecision> {
    if (!HARNESS_SUPPORTED_TRIGGERS.has(trigger)) {
      this.logger.log({
        message: 'Generation trigger has no harness equivalent — falling back to legacy',
        trigger,
        consultationId: params.consultationId,
      });
      return { generator: 'legacy', reason: 'harness-not-supported-for-trigger' };
    }

    const harnessJobId = `harness-doc-${randomUUID()}`;

    if (trigger === GenerationTrigger.SUMMARY_REGENERATE) {
      const refinalized = await this.refinalizeOnRequest(params, harnessJobId);
      if (refinalized) return refinalized;
    }

    // (consent-abac Phase 4): thread the consultation's external
    // patient id so the harness's call_mcp_tool/retrieve_context activities
    // can key a consent-gate lookup. Best-effort, non-fatal — a lookup
    // failure here must never block note generation itself; it only means
    // those two activities degrade to `consent_unavailable` (fail-closed,
    // distinguishable from a genuine denial — R4) instead of being gated.
    let externalPatientId: string | undefined;
    try {
      const consultation = await this.consultationRepository.findById(params.consultationId);
      externalPatientId = consultation.patientId;
    } catch (error) {
      this.logger.warn({
        message:
          'NoteGenerationService: could not resolve patientId for the consent-gate — harness tool/RAG calls will report consent as unavailable',
        consultationId: params.consultationId,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    const notePlanRef = await this.composeNotePlan(params);

    // NOT optional-chained (`.start(` not `?.start(`) — a missing gateway
    // throws here rather than silently no-op'ing. See the constructor note.
    await this.harnessGatewayService.start(params.consultationId, {
      tenantId: params.tenantId,
      userId: params.userId,
      jobId: harnessJobId,
      correlationId: params.correlationId ?? harnessJobId,
      contextItemId: params.contextItemId,
      transcriptText: params.transcriptText,
      redactionRules: params.redactionRules,
      externalPatientId,
      ...(params.supersede ? { supersede: true } : {}),
      ...(notePlanRef ? { notePlanRef } : {}),
    });

    this.logger.log({
      message: 'Harness document workflow start requested',
      trigger,
      consultationId: params.consultationId,
      harnessJobId,
      contextItemId: params.contextItemId,
    });

    return { generator: 'harness', harnessJobId };
  }

  /**
   * An explicit note request (`summary/async`) on a consultation whose note covers an earlier
   * transcript state: `EncounterRefinalizeService` re-finalises it once per transcript state
   * (governed supersede or harness-doc), joining a generation the stop already claimed. `null` ⇒
   * not a re-finalisation; the usual harness-doc start applies. Resolved at call time: the
   * coordinator's module imports this one.
   *
   * The job id handed back must reach a terminal state. A harness-doc run carries its job id and
   * completes it itself (`persistDraft` / the failed progress stage), so that id is returned. A
   * governing run carries none (its finalize is jobId-less), so the caller's own job id is returned
   * and watched: the lifecycle change that writes the note completes it, a FAILED one fails it.
   */
  private async refinalizeOnRequest(params: GenerateParams, harnessJobId: string): Promise<GenerationDecisionHarness | null> {
    let coordinator: Pick<EncounterRefinalizeService, 'onExplicitRequest'> | undefined;
    try {
      coordinator = this.moduleRef?.get(EncounterRefinalizeService, { strict: false });
    } catch {
      coordinator = undefined; // swallow-ok: not wired in this composition — the usual start applies
    }
    if (!coordinator) return null;

    const outcome = await coordinator.onExplicitRequest({
      consultationId: params.consultationId,
      tenantId: params.tenantId,
      userId: params.userId,
      jobId: harnessJobId,
    });
    if (outcome.kind === 'not-refinalize') return null;
    if (outcome.kind === 'failed') {
      throw new ServiceUnavailableException({ code: outcome.reason, message: 'The note could not be re-generated.' });
    }
    if (outcome.lane === 'harness-doc' && outcome.jobId) {
      return { generator: 'harness', harnessJobId: outcome.jobId };
    }
    await this.watchNoteJob(params.consultationId, harnessJobId);
    return { generator: 'harness', harnessJobId };
  }

  /** Remember a note job no run carries, until the consultation's note lands or fails. Best-effort. */
  private async watchNoteJob(consultationId: string, jobId: string): Promise<void> {
    if (!this.redis) return;
    try {
      await this.redis.eval(WATCH_ADD_SCRIPT, 1, noteJobWatchKey(consultationId), jobId, NOTE_REFINALIZE_CLAIM_TTL_SECONDS);
    } catch (error) {
      this.logger.warn({
        message: 'Note job could not be watched — it completes only through the job TTL',
        consultationId,
        jobId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Settle the watched note jobs of a consultation when its note is written (COMPLETED) or its
   * note path fails (FAILED). Each watched job settles once: the watch is taken atomically.
   * Best-effort — the lifecycle change has already happened.
   */
  @OnEvent(ConsultationPipelineEvent.LifecycleChanged, { async: true })
  async onLifecycleChanged(payload: LifecycleChangedPayload): Promise<void> {
    const event = payload?.event;
    if (!event || !this.redis) return;
    const outcome = noteJobOutcomeOf(event);
    if (!outcome) return;
    try {
      const taken = await this.redis.eval(WATCH_TAKE_SCRIPT, 1, noteJobWatchKey(payload.consultationId));
      const jobIds = Array.isArray(taken) ? taken.map(String) : [];
      if (jobIds.length === 0) return;
      const jobs = this.moduleRef?.get<IConsultationJobService>(IConsultationJobService, { strict: false });
      if (!jobs) return;
      for (const jobId of jobIds) {
        if (outcome === 'completed') {
          await jobs.notifyComplete(jobId, {
            consultationId: payload.consultationId,
            processing: event.processing,
            processingReason: event.processingReason ?? null,
          });
        } else {
          await jobs.notifyFailed(jobId, event.processingReason || 'NOTE_GENERATION_FAILED');
        }
      }
    } catch (error) {
      this.logger.warn({
        message: 'Watched note jobs could not be settled (best-effort)',
        consultationId: payload.consultationId,
        outcome,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Compose the note plan the harness run executes, before it starts. A plan that cannot fit the
   * model's window, or a model with no declared window, fails the consultation's processing with
   * that reason and the start is refused (rethrown) — never a run over truncated input. Any other
   * composition failure starts the run without a plan (its `assemble` composes or refuses itself).
   */
  private async composeNotePlan(params: GenerateParams): Promise<NotePlanRef | undefined> {
    let composer: HarnessInternalService | undefined;
    try {
      composer = this.moduleRef?.get(HarnessInternalService, { strict: false });
    } catch {
      composer = undefined; // swallow-ok: not wired in this composition — start without a plan
    }
    if (!composer) return undefined;
    try {
      const summary = await composer.composeNotePlan(params.consultationId, { tenantId: params.tenantId, userId: params.userId, mode: 'final' });
      return summary.notePlanRef;
    } catch (error) {
      const body = error instanceof HttpException ? error.getResponse() : null;
      const code = typeof body === 'object' && body !== null ? (body as Record<string, unknown>).code : undefined;
      if (code === NOTE_INPUT_EXCEEDS_CONTEXT || code === 'NOTE_MODEL_CONTEXT_UNDECLARED') {
        await this.lifecycleGate?.setProcessing(params.consultationId, ConsultationProcessing.FAILED, code);
        throw error;
      }
      this.logger.warn({
        message: 'Note plan could not be composed before the harness start — starting without a plan',
        consultationId: params.consultationId,
        code: typeof code === 'string' ? code : undefined,
        error: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
  }

  /**
   * Resolve pipeline configuration for a consultation.
   *
   * Moved verbatim from
   * `ConsultationEventHandler.resolvePipelineConfig` — same cascade-merge
   * behavior, same fail-closed-to-defaults `catch`. See that method's
   * original docstring (git history) for the full resolution-order writeup;
   * unchanged here:
   *
   * Resolution order (first non-null wins):
   *   1. Consultation `metadata.pipelineConfig` (per-consultation override, kept
   *      as the top overlay for back-compat).
   *   2. The assigned workflow's generation node `enabled`
   *      (`ConfigResolver.resolveAutoSummaryEnabled`, TASK-882).
   *   3. System code defaults (`DEFAULT_PIPELINE_CONFIG`) — also the fallback when
   *      the resolver is not wired (legacy DI/fixtures).
   */
  async resolveConfig(consultationId: string): Promise<ConsultationPipelineConfig> {
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

      // TASK-932 — substrate exclusivity, the same gate `LoopContextSignalService` applies: a
      // consultation the interpreter took at OPEN (governing-engine marker) is documented by its
      // graph's own finalize node, so the legacy `HarnessDocWorkflow` this config would start on
      // `TRANSCRIPTION_CREATED` stands down — no per-consultation opt-in resurrects a second
      // engine writing the same note. This branch became reachable only when the resolvers
      // started asking for the CORE palette; before that no graph was ever found and this path
      // answered OFF by accident, which is why the double write never showed.
      const governed = tenantWorkflowGoverns(metadata);
      if (governed) {
        this.logger.log({
          message: 'Legacy auto-summary stood down — a tenant-authored workflow governs this consultation (substrate exclusivity)',
          consultationId,
        });
      }

      // The assigned workflow's generation node owns auto-summary (TASK-882); the
      // per-consultation metadata override wins on top (back-compat). An unwired
      // resolver answers the code default.
      const autoSummaryFromGraph =
        !governed && this.configResolver
          ? await this.configResolver.resolveAutoSummaryEnabled({
              tenantId: consultation.tenantId,
              departmentId: consultation.departmentId ?? null,
              doctorId: consultation.doctorId ?? null,
            })
          : DEFAULT_PIPELINE_CONFIG.autoSummaryEnabled;

      return {
        autoSummaryEnabled: governed ? false : (override.autoSummaryEnabled ?? autoSummaryFromGraph),
        // dnaStyleId / summaryTemplate / includeSharedContext stay per-consultation.
        dnaStyleId: override.dnaStyleId ?? DEFAULT_PIPELINE_CONFIG.dnaStyleId,
        summaryTemplate: override.summaryTemplate ?? DEFAULT_PIPELINE_CONFIG.summaryTemplate,
        includeSharedContext: override.includeSharedContext ?? DEFAULT_PIPELINE_CONFIG.includeSharedContext,
        haltOnFailure: override.haltOnFailure ?? DEFAULT_PIPELINE_CONFIG.haltOnFailure,
      };
    } catch (error) {
      this.logger.error({
        message: 'Error resolving pipeline config — using defaults',
        consultationId,
        error: error instanceof Error ? error.message : String(error),
      });
      return { ...DEFAULT_PIPELINE_CONFIG };
    }
  }
}
