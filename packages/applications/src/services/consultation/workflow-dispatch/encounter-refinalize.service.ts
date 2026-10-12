import { randomUUID } from 'node:crypto';
import { HttpException, Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { ClsService } from 'nestjs-cls';
import { ConsultationProcessing, ConsultationRepository, ContextItemRepository, DnaWritingStyleReportRepository } from '@arcaai/domains';
import { createWorkerSession } from '../../../common';
import { IActiveUserContext } from '../../../interfaces';
import { SecretsService } from '../../baseServices/_meta/secrets';
import { IRedisCacheService } from '../../baseServices/redis';
import { ConfigResolver } from '../../config-resolver';
import { ConsultationPipelineEvent, type TranscriptionCreatedPayload } from '../events/consultation.events';
import { governingRunOf, tenantWorkflowGoverns } from '../governing-engine';
import { HarnessGatewayService } from '../harness/harness-gateway.service';
import { HarnessInternalService } from '../harness/harness-internal.service';
import { IConsultationLifecycleGate, IConsultationLifecycleGateToken } from '../lifecycle/IConsultationLifecycleService';
import { NOTE_INPUT_EXCEEDS_CONTEXT, type NotePlanRef } from '../note-composition/note-plan.types';
import {
  NOTE_REFINALIZE_CLAIM_TTL_SECONDS,
  NOTE_REFINALIZE_FAILED,
  classifySessionFinal,
  noteRefinalizeClaimKey,
  refinalizeStateKey,
  transcriptFinalPending,
  type SessionFinalKind,
} from './encounter-refinalize';
import { IConsultationWorkflowDispatchService } from './IConsultationWorkflowDispatchService';
import { rebuildAuthoredContext, resolveHarnessRedactionRules } from './refinalize-start-context';

export type RefinalizeLane = 'governed' | 'harness-doc';

/**
 * - `not-refinalize` — not a re-finalisation (see `classifySessionFinal`); the caller's usual path applies.
 * - `started` — this call started the note generation; `jobId` is the harness-doc job id, or the
 *   superseding governing run id.
 * - `coalesced` — a generation for the same transcript state is already claimed; nothing started.
 * - `failed` — nothing is running; processing is FAILED with `reason`.
 */
export type RefinalizeOutcome =
  | { kind: 'not-refinalize'; reason: Exclude<SessionFinalKind, 'refinalize'> | 'not-found' }
  | { kind: 'started' | 'coalesced'; lane: RefinalizeLane; jobId: string | null }
  | { kind: 'failed'; lane: RefinalizeLane; reason: string };

interface RefinalizeClaim {
  lane: RefinalizeLane;
  jobId: string | null;
}

interface RefinalizeInput {
  consultationId: string;
  tenantId: string;
  userId?: string;
  trigger: 'stop' | 'explicit';
  /** `stop`: the FULL_TRANSCRIPT item the session final rebuilt. */
  contextItemId?: string;
  /** `explicit`: the job id the caller already minted and will hand back. */
  jobId?: string;
}

/** Composer refusals that fail the note path closed (never a run over truncated input). */
const PLAN_FAIL_CLOSED_CODES: ReadonlySet<string> = new Set([NOTE_INPUT_EXCEEDS_CONTEXT, 'NOTE_MODEL_CONTEXT_UNDECLARED']);

/**
 * Re-finalises a consultation's note after every stop that adds speech to it (encounter 2 and
 * later, or the same encounter recorded again) — once, over the WHOLE consultation, on both lanes:
 *
 *  - **governed** — the governing run is SUPERSEDED (`supersedeGoverningRun`). The fresh
 *    run's finalizer reads the live handoff, whose note plan is composed for the current transcript.
 *    Never the default engine.
 *  - **harness-doc** — one start with `supersede: true` (the earlier run is parked at its review gate
 *    and would otherwise answer `already_running`), carrying the note plan composed here.
 *
 * ## Why exactly once
 *
 * The transcript state is the FULL_TRANSCRIPT item at its current version. A Redis `SET NX` claim on
 * (consultation, state) decides who generates: the session-final event (`stop`) or an explicit
 * `summary/async` arriving before it — the other coalesces onto the claimant's job. A stop retry
 * (a no-op on a STOPPED consultation) writes no new version, so it claims nothing new. The governed
 * supersede is additionally idempotent on its trigger id (the marker compare-and-set), so even a
 * Redis outage cannot start two governing runs for one state. An explicit request on a state whose note is already written (not
 * SUMMARIZING) is a real regenerate.
 *
 * Processing: SUMMARIZING when the generation starts, then the note writer moves it to
 * IDLE + NOTE_READY (or AWAITING_REVIEW); a start that fails is FAILED with a reason.
 */
@Injectable()
export class EncounterRefinalizeService {
  private readonly logger = new Logger(EncounterRefinalizeService.name);

  constructor(
    private readonly consultationRepository: ConsultationRepository,
    private readonly contextItemRepository: ContextItemRepository,
    private readonly harnessGateway: HarnessGatewayService,
    private readonly cls: ClsService<IActiveUserContext>,
    // Same module (`HarnessInternalServiceModule`); composes the plan the harness-doc run executes.
    @Optional() private readonly composer?: Pick<HarnessInternalService, 'composeNotePlan'>,
    @Optional()
    @Inject(IConsultationWorkflowDispatchService)
    private readonly dispatch?: Pick<IConsultationWorkflowDispatchService, 'supersedeGoverningRun'>,
    // The claim store. Unwired ⇒ every call claims (the governed marker still dedupes).
    @Optional() @Inject(IRedisCacheService) private readonly redis?: Pick<IRedisCacheService, 'eval' | 'get' | 'del'>,
    @Optional() @Inject(IConsultationLifecycleGateToken) private readonly lifecycleGate?: Pick<IConsultationLifecycleGate, 'setProcessing'>,
    @Optional() @Inject(ConfigResolver) private readonly configResolver?: ConfigResolver,
    @Optional() @Inject(DnaWritingStyleReportRepository) private readonly dnaReportRepository?: DnaWritingStyleReportRepository,
    @Optional() @Inject(SecretsService) private readonly secretsService?: SecretsService,
  ) {}

  /** The stop trigger: a session final folded new speech into the FULL_TRANSCRIPT. */
  @OnEvent(ConsultationPipelineEvent.TranscriptionCreated, { async: true })
  async onTranscriptionCreated(payload: TranscriptionCreatedPayload): Promise<RefinalizeOutcome> {
    if (!payload.tenantId) return { kind: 'not-refinalize', reason: 'not-found' };
    return this.cls.run(async () => {
      this.cls.set('tenantId', payload.tenantId);
      this.cls.set('user', createWorkerSession({ userId: payload.userId, tenantId: payload.tenantId, kind: 'transcription-created-event' }));
      try {
        return await this.refinalize({
          consultationId: payload.consultationId,
          tenantId: payload.tenantId,
          userId: payload.userId,
          trigger: 'stop',
          contextItemId: payload.contextItemId,
        });
      } catch (error) {
        this.logger.error({
          message: 'Encounter re-finalisation check failed — the note was not re-generated for this stop',
          consultationId: payload.consultationId,
          error: error instanceof Error ? error.message : String(error),
        });
        return { kind: 'not-refinalize', reason: 'not-found' };
      }
    });
  }

  /**
   * An explicit note request (`POST :id/summary/async`). `not-refinalize` ⇒ the caller's usual
   * path; otherwise this service started, joined or failed the generation and the caller hands
   * back `jobId` (its own `jobId` when `null`).
   */
  onExplicitRequest(input: { consultationId: string; tenantId: string; userId?: string; jobId: string }): Promise<RefinalizeOutcome> {
    return this.refinalize({ ...input, trigger: 'explicit' });
  }

  private async refinalize(input: RefinalizeInput): Promise<RefinalizeOutcome> {
    const consultation = await this.consultationRepository.findByIdOrNull(input.consultationId);
    if (!consultation || consultation.tenantId !== input.tenantId) return { kind: 'not-refinalize', reason: 'not-found' };

    const found =
      input.trigger === 'stop'
        ? input.contextItemId
          ? await this.contextItemRepository.findByIdOrNull(input.contextItemId)
          : null
        : await this.contextItemRepository.findFullTranscript(consultation.id);
    const item = found && found.consultationId === consultation.id ? found : null;
    const kind = classifySessionFinal({ status: String(consultation.status), currentEncounterSeq: consultation.currentEncounterSeq }, item);
    // An explicit request that arrives before the stop's session final folded the new speech in
    // would generate for a transcript state that is about to change (and the stop then generates
    // again). The stop path owns that generation; the request joins it.
    if (input.trigger === 'explicit' && String(consultation.status) === 'STOPPED' && transcriptFinalPending(consultation, item)) {
      const pendingLane: RefinalizeLane = tenantWorkflowGoverns(consultation.metadata) ? 'governed' : 'harness-doc';
      this.logger.log({
        message: 'Note request joins the stop — its session final has not folded the new speech into the transcript yet',
        consultationId: consultation.id,
        lane: pendingLane,
      });
      return { kind: 'coalesced', lane: pendingLane, jobId: null };
    }
    // An explicit request on encounter 1 of a governed consultation belongs to the governing run
    // too — the default engine would write a second, ungoverned note beside it.
    const governedFirst = input.trigger === 'explicit' && kind === 'first' && tenantWorkflowGoverns(consultation.metadata);
    // The stop of encounter 1 hands the transcript to the governing run, which writes the first note
    // now; processing reports it (the harness settles it like any other note generation). The stop
    // may still hold FINALIZING_TRANSCRIPT while it awaits this final; its restore keeps the
    // SUMMARIZING written here.
    if (
      input.trigger === 'stop' &&
      kind === 'first' &&
      item &&
      tenantWorkflowGoverns(consultation.metadata) &&
      governingRunOf(consultation.metadata)?.status === 'RUNNING' &&
      (consultation.processing === ConsultationProcessing.IDLE || consultation.processing === ConsultationProcessing.FINALIZING_TRANSCRIPT)
    ) {
      await this.setProcessing(consultation.id, ConsultationProcessing.SUMMARIZING);
    }
    if ((kind !== 'refinalize' && !governedFirst) || !item) {
      return { kind: 'not-refinalize', reason: kind === 'refinalize' ? 'not-full-transcript' : kind };
    }
    if (governedFirst) {
      const finalizing =
        consultation.processing === ConsultationProcessing.SUMMARIZING || consultation.processing === ConsultationProcessing.FINALIZING_TRANSCRIPT;
      // The open-time run is still writing the first note: join it rather than supersede it.
      if (finalizing || governingRunOf(consultation.metadata)?.status === 'RUNNING') {
        return { kind: 'coalesced', lane: 'governed', jobId: null };
      }
    }

    const stateKey = refinalizeStateKey(item);
    const claimKey = noteRefinalizeClaimKey(consultation.id, stateKey);
    const lane: RefinalizeLane = tenantWorkflowGoverns(consultation.metadata) ? 'governed' : 'harness-doc';
    const jobId = lane === 'harness-doc' ? (input.jobId ?? `harness-doc-${randomUUID()}`) : null;

    let regenerate = false;
    if (!(await this.claim(claimKey, { lane, jobId }, true))) {
      const existing = await this.readClaim(claimKey);
      const inFlight = consultation.processing === ConsultationProcessing.SUMMARIZING;
      if (input.trigger === 'stop' || inFlight) {
        this.logger.log({
          message: 'Note re-finalisation coalesced onto the generation already claimed for this transcript',
          consultationId: consultation.id,
          stateKey,
          trigger: input.trigger,
        });
        return { kind: 'coalesced', lane: existing?.lane ?? lane, jobId: existing?.jobId ?? null };
      }
      // The note for this state is written: an explicit request is a real regenerate.
      regenerate = true;
      await this.claim(claimKey, { lane, jobId }, false);
    }

    const ctx = { consultation, item, stateKey, claimKey, input, regenerate };
    if (lane === 'governed') return this.refinalizeGoverned(ctx);
    await this.markSummarizing(consultation);
    return this.refinalizeHarnessDoc({ ...ctx, jobId: jobId! });
  }

  /** SUMMARIZING for a generation this call starts; an attachment in progress keeps its marker. */
  private async markSummarizing(consultation: { id: string; processing?: ConsultationProcessing | string | null }): Promise<void> {
    if (consultation.processing !== ConsultationProcessing.PROCESSING_ATTACHMENT) {
      await this.setProcessing(consultation.id, ConsultationProcessing.SUMMARIZING);
    }
  }

  private async refinalizeGoverned(ctx: {
    consultation: { id: string; tenantId: string; processing?: ConsultationProcessing | string | null };
    stateKey: string;
    claimKey: string;
    input: RefinalizeInput;
    regenerate: boolean;
  }): Promise<RefinalizeOutcome> {
    const { consultation, stateKey, claimKey, input } = ctx;
    if (!this.dispatch?.supersedeGoverningRun) {
      return this.fail(consultation.id, claimKey, 'governed', NOTE_REFINALIZE_FAILED, 'the governing-workflow dispatcher is not wired');
    }
    // A regenerate on the same state needs a trigger id of its own — the marker would read the
    // state's id as "already re-finalised".
    const triggerId = ctx.regenerate ? `refinalize:${stateKey}:${input.jobId ?? randomUUID()}` : `refinalize:${stateKey}`;
    const result = await this.dispatch.supersedeGoverningRun({
      consultationId: consultation.id,
      tenantId: consultation.tenantId,
      userId: input.userId ?? null,
      triggerId,
      authoredContext: await rebuildAuthoredContext(this.contextItemRepository, this.secretsService, consultation.id),
    });
    // Only a superseding run reports SUMMARIZING: a duplicate starts nothing that would settle it.
    if (result.superseded) {
      await this.markSummarizing(consultation);
      await this.claim(claimKey, { lane: 'governed', jobId: result.runId }, false);
      this.logger.log({
        message: 'Stop re-finalises the governed note over the whole consultation (governing run superseded)',
        consultationId: consultation.id,
        stateKey,
        runId: result.runId,
        supersededRunId: result.supersededRunId,
      });
      return { kind: 'started', lane: 'governed', jobId: result.runId };
    }
    if (result.skippedReason === 'duplicate') return { kind: 'coalesced', lane: 'governed', jobId: result.runId };
    return this.fail(
      consultation.id,
      claimKey,
      'governed',
      NOTE_REFINALIZE_FAILED,
      `governing run not superseded (${result.skippedReason ?? 'unknown'})`,
    );
  }

  private async refinalizeHarnessDoc(ctx: {
    consultation: { id: string; tenantId: string; patientId?: string | null; doctorId?: string | null; departmentId?: string | null };
    item: { id: string; content?: string | null };
    stateKey: string;
    claimKey: string;
    input: RefinalizeInput;
    jobId: string;
  }): Promise<RefinalizeOutcome> {
    const { consultation, item, stateKey, claimKey, input, jobId } = ctx;

    let notePlanRef: NotePlanRef | undefined;
    if (this.composer) {
      try {
        notePlanRef = (await this.composer.composeNotePlan(consultation.id, { tenantId: consultation.tenantId, userId: input.userId, mode: 'final' }))
          .notePlanRef;
      } catch (error) {
        const code = refusalCode(error);
        if (code && PLAN_FAIL_CLOSED_CODES.has(code)) return this.fail(consultation.id, claimKey, 'harness-doc', code, 'note plan refused');
        // Same posture as the auto-pipeline: start without a plan; the run's assemble composes or refuses.
        this.logger.warn({
          message: 'Note plan could not be composed for the re-finalisation — starting without a plan',
          consultationId: consultation.id,
          code,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const redactionRules = await resolveHarnessRedactionRules(
      { configResolver: this.configResolver, dnaReportRepository: this.dnaReportRepository, secretsService: this.secretsService },
      consultation,
    );
    try {
      await this.harnessGateway.start(consultation.id, {
        tenantId: consultation.tenantId,
        userId: input.userId,
        jobId,
        correlationId: jobId,
        contextItemId: item.id,
        transcriptText: item.content ?? undefined,
        redactionRules,
        externalPatientId: consultation.patientId ?? undefined,
        supersede: true,
        ...(notePlanRef ? { notePlanRef } : {}),
      });
    } catch (error) {
      return this.fail(consultation.id, claimKey, 'harness-doc', NOTE_REFINALIZE_FAILED, error instanceof Error ? error.message : String(error));
    }
    this.logger.log({
      message: 'Stop re-finalises the note over the whole consultation (harness-doc run superseded)',
      consultationId: consultation.id,
      stateKey,
      jobId,
      trigger: input.trigger,
    });
    return { kind: 'started', lane: 'harness-doc', jobId };
  }

  /** Release the claim (a retry may try again) and make the failure visible on processing. */
  private async fail(consultationId: string, claimKey: string, lane: RefinalizeLane, reason: string, detail: string): Promise<RefinalizeOutcome> {
    // `detail` may carry a downstream message: logged here, never persisted on the row.
    this.logger.error({
      message: 'Note re-finalisation not started — the note still covers only the earlier recordings',
      consultationId,
      lane,
      reason,
      detail,
    });
    try {
      await this.redis?.del(claimKey);
    } catch {
      // swallow-ok: the claim expires on its own (TTL); only a same-state retry waits for it.
    }
    await this.setProcessing(consultationId, ConsultationProcessing.FAILED, reason);
    return { kind: 'failed', lane, reason };
  }

  private async setProcessing(consultationId: string, processing: ConsultationProcessing, reason?: string): Promise<void> {
    if (!this.lifecycleGate) return;
    try {
      if (reason === undefined) await this.lifecycleGate.setProcessing(consultationId, processing);
      else await this.lifecycleGate.setProcessing(consultationId, processing, reason);
    } catch (error) {
      this.logger.warn({
        message: 'Consultation processing could not be updated for the note re-finalisation (best-effort)',
        consultationId,
        processing,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** `SET NX` (`onlyIfAbsent`) or plain `SET`, with the claim TTL. `true` when written. Redis down ⇒ `true`. */
  private async claim(key: string, value: RefinalizeClaim, onlyIfAbsent: boolean): Promise<boolean> {
    if (!this.redis) return true;
    const script = onlyIfAbsent
      ? "return redis.call('SET', KEYS[1], ARGV[1], 'NX', 'EX', ARGV[2])"
      : "return redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[2])";
    try {
      return (await this.redis.eval(script, 1, key, JSON.stringify(value), NOTE_REFINALIZE_CLAIM_TTL_SECONDS)) === 'OK';
    } catch (error) {
      this.logger.warn({
        message: 'Note re-finalisation claim failed — proceeding unclaimed',
        error: error instanceof Error ? error.message : String(error),
      });
      return true;
    }
  }

  private async readClaim(key: string): Promise<RefinalizeClaim | null> {
    try {
      const raw = await this.redis?.get(key);
      return raw ? (JSON.parse(raw) as RefinalizeClaim) : null;
    } catch {
      return null;
    }
  }
}

function refusalCode(error: unknown): string | undefined {
  const body = error instanceof HttpException ? error.getResponse() : null;
  const code = typeof body === 'object' && body !== null ? (body as Record<string, unknown>).code : undefined;
  return typeof code === 'string' ? code : undefined;
}
