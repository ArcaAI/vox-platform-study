import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { ITenantLockService } from '../tenant-checkpoint/contracts';
import { postponeIfTenantLocked } from '../../common/worker-session-lock';
import { Queue, Job } from 'bullmq';
import { ClsService } from 'nestjs-cls';
import {
  ConsultationFeedbackRepository,
  ContextItemRepository,
  ContextItemVersionRepository,
  ConsultationRepository,
  JobQueue,
  NamedEntityRepository,
} from '@arcaai/domains';
import { createWorkerSession } from '../../common';
import { IActiveUserContext } from '../../interfaces';
import { GateEditMiningService } from './gate-edit-mining.service';
import { GateEditMiningJob, IGateEditMiningQueue } from './IGateEditMiningQueue';
import { ConfigResolver } from '../config-resolver/config-resolver.service';
import { DEFAULT_VISIT_TYPE_SERVICE, VisitTypeService } from '../consultation/visit-type/visit-type.service';
import { readRecordedVisitType } from '../consultation/consultation/open-markers';
import { QUEUE_CONCURRENCY } from '../baseServices/redis/queue-concurrency';
import { runJobInContext } from '../baseServices/observability/job-context';

/**
 * The enqueue half of the gate-edit learning loop.
 *
 * Implements {@link IGateEditMiningQueue} so the sign-off path can hand off the
 * signal without importing queue infrastructure.
 */
@Injectable()
export class GateEditMiningQueue implements IGateEditMiningQueue {
  private readonly logger = new Logger(GateEditMiningQueue.name);

  constructor(
    @InjectQueue(JobQueue.MineGateEditExemplar) private readonly queue: Queue,
    // TASK-972 Lane 2 (OD-4) — the training-capture gate (tenant AND doctor). Optional +
    // trailing so existing positional fixtures keep their arity; absent ⇒ no such gate in this
    // composition, which is byte-identical to the pre-ticket behaviour (mining was
    // unconditional). Wired in production by `GateEditMiningServiceModule`.
    @Optional() @Inject(ConfigResolver) private readonly configResolver?: ConfigResolver,
  ) {}

  /**
   * Hand one signed encounter to the miner — unless this clinician's tenant, or the clinician
   * themselves, has opted out of training capture (TASK-972 Lane 2).
   *
   * **The gate suppresses CAPTURE ONLY.** This method is called from a sign-off that has already
   * committed, so an opted-out encounter must return NORMALLY with nothing queued. Failing here
   * would fail a clinical action for a training-data reason, which is the one thing this gate
   * must never do.
   *
   * The check lives on this side of the port rather than in `approveSummary` deliberately: the
   * sign-off path's `@Optional() ConfigResolver` is not supplied by `SummaryServiceModule`, so a
   * check there would be dead in production, while the gate-edit module owns both halves of this
   * loop and can wire the resolver without changing what DNA style does at generation time.
   */
  async enqueue(job: GateEditMiningJob): Promise<void> {
    if (!(await this.captureAllowed(job))) return;
    await this.queue.add(JobQueue.MineGateEditExemplar, job, {
      // Deduped on the encounter: a repeat sign-off event collapses to one job.
      // The miner is idempotent anyway (unique on tenant+consultation), so this
      // is a cost optimisation, not a correctness requirement.
      //
      // day-1: the separator MUST NOT be ':' — BullMQ rejects a custom id
      // containing one ("Custom Id cannot contain :", because ':' delimits its own
      // Redis key namespace). Every sign-off therefore threw here, and since the
      // enqueue is best-effort the throw was caught and the exemplar simply never
      // appeared: R7's capture worked, its mining never ran. Verified live before
      // and after this change.
      // A feedback job carries its own id so it never collapses into the encounter's gate job.
      jobId: job.source === 'feedback' && job.feedbackId ? `${job.tenantId}__${job.consultationId}__fb_${job.feedbackId}` : `${job.tenantId}__${job.consultationId}`,
      attempts: 3,
      backoff: { type: 'exponential', delay: 5_000 },
      removeOnComplete: 100, // keep recent runs visible on the admin queue board
      removeOnFail: 100,
    });
  }

  /**
   * The effective training-capture decision for this encounter, degrading to ALLOWED on every
   * failure path — the descriptor's declared `open-to-default` direction, and the only one under
   * which an unconfigured deployment keeps mining exactly as it does today. An explicit opt-out
   * is never degraded away: it can only be observed as `false` because a human set it.
   */
  private async captureAllowed(job: GateEditMiningJob): Promise<boolean> {
    if (!this.configResolver) return true;
    try {
      const { effective } = await this.configResolver.resolveEffectiveTrainingCaptureEnabled({
        tenantId: job.tenantId,
        doctorId: job.doctorId ?? null,
      });
      if (!effective) {
        this.logger.log({
          message: 'Gate-edit mining skipped — training capture is disabled for this clinician or tenant (the sign-off is unaffected)',
          consultationId: job.consultationId,
        });
      }
      return effective;
    } catch (error) {
      this.logger.warn({
        message: 'Training-capture gate lookup failed — capture proceeds (open-to-default)',
        consultationId: job.consultationId,
        error: error instanceof Error ? error.message : String(error),
      });
      return true;
    }
  }
}

/**
 * The mining worker.
 *
 * Runs OFF the clinician's request: it re-reads the delivered draft and the
 * signed note from their versions, hands them to {@link GateEditMiningService}
 * (which redacts fail-closed before persisting anything), and exits.
 *
 * A missing tenant THROWS here — unlike the event-handler style, a BullMQ
 * processor should let the queue retry a job it cannot attribute, rather than
 * silently dropping it.
 */
// TASK-993 lane D — concurrency is DECLARED, not inherited. Every processor
// ran at bullmq's default of 1 because no `@Processor` passed options; the
// number, and the Prisma-pool budget it fits inside, live in one table.
@Processor(JobQueue.MineGateEditExemplar, { concurrency: QUEUE_CONCURRENCY[JobQueue.MineGateEditExemplar] })
export class GateEditMiningProcessor extends WorkerHost {
  private readonly logger = new Logger(GateEditMiningProcessor.name);

  constructor(
    private readonly miningService: GateEditMiningService,
    private readonly contextItemRepository: ContextItemRepository,
    private readonly contextItemVersionRepository: ContextItemVersionRepository,
    private readonly consultationRepository: ConsultationRepository,
    private readonly cls: ClsService<IActiveUserContext>,
    // the tenant's VISIT-TYPE catalogue, which replaces the
    // `parentConsultationId ? 'revisit': 'new-patient'` literal below. Optional
    // + trailing so existing positional fixtures keep their arity; an unwired
    // resolver serves the two shipped visit types, whose keys and follow-up rule
    // are byte-identical to the ternary it replaces.
    @Optional() @Inject(VisitTypeService) private readonly visitTypes?: VisitTypeService,
    // TASK-972 Lane 2 (OD-4) — the SECOND half of the double check. The enqueue side already
    // asked, but a toggle flipped between enqueue and drain must be honoured, and this read runs
    // immediately before anything is persisted. Optional + trailing like the resolver above it.
    @Optional() @Inject(ConfigResolver) private readonly configResolver?: ConfigResolver,
    // Postpones the job while a restore holds the tenant's lock. Optional + trailing so positional fixtures keep their arity.
    @Optional() @Inject(ITenantLockService) private readonly tenantLock?: ITenantLockService,
    // Feedback-sourced jobs read the feedback row and the text it points at; absent ⇒ such a job is dropped.
    @Optional() @Inject(ConsultationFeedbackRepository) private readonly feedbackRepository?: ConsultationFeedbackRepository,
    @Optional() @Inject(NamedEntityRepository) private readonly namedEntityRepository?: NamedEntityRepository,
  ) {
    super();
  }

  async process(job: Job<GateEditMiningJob>, token?: string): Promise<void> {
    const { tenantId, consultationId, contextItemId, gateDecision, signedAt } = job.data;
    if (!tenantId) {
      throw new Error(`Gate-edit mining job ${job.id} is missing required tenantId`);
    }

    await postponeIfTenantLocked(this.tenantLock, job, token, tenantId, ['CLINICAL']);
    // Rebind CLS so the tenant-scope Prisma extension sees the right context —
    // the queue worker has no request context of its own.
    return runJobInContext(this.cls, job, async () => {
      this.cls.set('tenantId', tenantId);
      this.cls.set('user', createWorkerSession({ tenantId, kind: 'gate-edit-mining' }));

      const consultation = await this.consultationRepository.findById(consultationId).catch(() => null);

      // TASK-972 Lane 2 — RE-CHECK the training-capture gate, before anything is read
      // transiently and long before anything is persisted. The clinician comes off the job when
      // the enqueue side put one there, and off the consultation otherwise (a job queued before
      // this field existed). Degrades to ALLOWED on a failed read, matching the enqueue side and
      // the descriptor's declared direction.
      if (!(await this.captureStillAllowed(tenantId, job.data.doctorId ?? consultation?.doctorId ?? null, consultationId))) {
        return;
      }

      // The delivered AI draft is version 1 (`ai_draft_v1`); the signed note is
      // the latest. Both are read TRANSIENTLY — only their redacted forms are
      // ever persisted by the mining service.
      const versions = contextItemId
        ? await this.contextItemVersionRepository.getVersionsByChangeReason(contextItemId, 'approved').catch(() => [])
        : [];
      const delivered = contextItemId ? await this.loadDeliveredDraft(contextItemId) : null;
      const signed = versions.length > 0 ? (versions[versions.length - 1].content ?? null) : null;

      if (job.data.source === 'feedback') {
        await this.processFeedbackJob(job.data, consultation);
        return;
      }

      await this.miningService.mineFromGateDecision({
        tenantId,
        consultationId,
        departmentId: consultation?.departmentId ?? null,
        // The mined retrieval facet carries the TENANT's visit-type key
        // , so a tenant that defines its own vocabulary
        // mines and retrieves exemplars under it rather than under a platform
        // literal. TASK-951 §D-3 — the visit type the caller STATED at open ranks above the
        // parent link, so an exemplar is mined under the facet the note was actually written
        // for; `parentConsultationId` remains the follow-up signal when nothing was stated.
        visitType: (this.visitTypes ?? DEFAULT_VISIT_TYPE_SERVICE).forConsultation(tenantId, {
          recorded: readRecordedVisitType(consultation?.metadata),
          isFollowUp: Boolean(consultation?.parentConsultationId),
        }).key,
        gateDecision,
        deliveredContent: delivered,
        signedContent: signed,
        signedAt: signedAt ?? null,
        contextItemId: contextItemId ?? null,
      });
    });
  }

  /**
   * Feedback-sourced job: only a thumbs-down or a correction is worth mining, so everything else
   * returns before any text is read. The versions are read TRANSIENTLY — the miner redacts before
   * it persists anything.
   */
  private async processFeedbackJob(
    data: GateEditMiningJob,
    consultation: { departmentId?: string | null; parentConsultationId?: string | null; metadata?: unknown } | null,
  ): Promise<void> {
    if (!data.feedbackId || !this.feedbackRepository) return;
    const feedback = await this.feedbackRepository.findById(data.feedbackId).catch(() => null);
    // Belt-and-braces on the tenant boundary: the job's tenant must own the row.
    if (!feedback || feedback.tenantId !== data.tenantId) return;

    const hasCorrection = !!feedback.correctionContextItemId && feedback.correctionVersionNumber != null;
    const isDown = feedback.rating === 'DOWN';
    if (!isDown && !hasCorrection) return;

    const versionContent = async (itemId: string, versionNumber: number): Promise<string | null> =>
      (await this.contextItemVersionRepository.getVersion(itemId, versionNumber).catch(() => null))?.content ?? null;

    let targetContent: string | null = null;
    if (feedback.targetContextItemId && feedback.targetKind !== 'ENTITY') {
      const number =
        feedback.targetVersionNumber ?? (await this.contextItemVersionRepository.getLatestVersionNumber(feedback.targetContextItemId).catch(() => 0));
      if (number) targetContent = await versionContent(feedback.targetContextItemId, number);
    }

    let beforeContent: string | null = null;
    let afterContent: string | null = null;
    if (hasCorrection) {
      const itemId = feedback.correctionContextItemId as string;
      const number = feedback.correctionVersionNumber as number;
      afterContent = await versionContent(itemId, number);
      beforeContent = number > 1 ? await versionContent(itemId, number - 1) : null;
    }

    let entityText: string | null = null;
    if (feedback.targetKind === 'ENTITY' && feedback.targetEntityRef && this.namedEntityRepository) {
      entityText = (await this.namedEntityRepository.findById(feedback.targetEntityRef).catch(() => null))?.text ?? null;
    }

    await this.miningService.mineFromFeedback({
      tenantId: data.tenantId,
      consultationId: data.consultationId,
      feedbackId: feedback.id,
      targetKind: feedback.targetKind ?? 'NOTE',
      rating: feedback.rating ?? null,
      reasonCodes: feedback.reasonCodes ?? [],
      departmentId: consultation?.departmentId ?? null,
      visitType: (this.visitTypes ?? DEFAULT_VISIT_TYPE_SERVICE).forConsultation(data.tenantId, {
        recorded: readRecordedVisitType(consultation?.metadata as never),
        isFollowUp: Boolean(consultation?.parentConsultationId),
      }).key,
      contextItemId: feedback.targetContextItemId ?? feedback.correctionContextItemId ?? null,
      modelName: feedback.provModelName ?? null,
      targetContent,
      beforeContent,
      afterContent,
      entityText,
      entityLabel: feedback.entityLabel ?? null,
    });
  }

  /** @see GateEditMiningQueue.captureAllowed — the same gate, read again at drain time. */
  private async captureStillAllowed(tenantId: string, doctorId: string | null, consultationId: string): Promise<boolean> {
    if (!this.configResolver) return true;
    try {
      const { effective } = await this.configResolver.resolveEffectiveTrainingCaptureEnabled({ tenantId, doctorId });
      if (!effective) {
        this.logger.log({ message: 'Gate-edit mining job dropped — training capture is disabled for this clinician or tenant', consultationId });
      }
      return effective;
    } catch (error) {
      this.logger.warn({
        message: 'Training-capture gate lookup failed at drain — mining proceeds (open-to-default)',
        consultationId,
        error: error instanceof Error ? error.message : String(error),
      });
      return true;
    }
  }

  /** The immutable `ai_draft_v1` snapshot, or null when it was never captured. */
  private async loadDeliveredDraft(contextItemId: string): Promise<string | null> {
    try {
      const drafts = await this.contextItemVersionRepository.getVersionsByChangeReason(contextItemId, 'ai_draft_v1');
      return drafts.length > 0 ? (drafts[0].content ?? null) : null;
    } catch {
      return null;
    }
  }
}
