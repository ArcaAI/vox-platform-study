import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue, Job } from 'bullmq';
import { ClsService } from 'nestjs-cls';
import { ContextItemRepository, ContextItemVersionRepository, ConsultationRepository, JobQueue } from '@arcaai/domains';
import { createWorkerSession } from '../../common';
import { IActiveUserContext } from '../../interfaces';
import { GateEditMiningService } from './gate-edit-mining.service';
import { GateEditMiningJob, IGateEditMiningQueue } from './IGateEditMiningQueue';
import { DEFAULT_VISIT_TYPE_SERVICE, VisitTypeService } from '../consultation/visit-type/visit-type.service';

/**
 * The enqueue half of the gate-edit learning loop.
 *
 * Implements {@link IGateEditMiningQueue} so the sign-off path can hand off the
 * signal without importing queue infrastructure.
 */
@Injectable()
export class GateEditMiningQueue implements IGateEditMiningQueue {
  private readonly logger = new Logger(GateEditMiningQueue.name);

  constructor(@InjectQueue(JobQueue.MineGateEditExemplar) private readonly queue: Queue) {}

  async enqueue(job: GateEditMiningJob): Promise<void> {
    await this.queue.add(JobQueue.MineGateEditExemplar, job, {
      // Deduped on the encounter: a repeat sign-off event collapses to one job.
      // The miner is idempotent anyway (unique on tenant+consultation), so this
      // is a cost optimisation, not a correctness requirement.
      //
      // TASK-789 day-1: the separator MUST NOT be ':' — BullMQ rejects a custom id
      // containing one ("Custom Id cannot contain :", because ':' delimits its own
      // Redis key namespace). Every sign-off therefore threw here, and since the
      // enqueue is best-effort the throw was caught and the exemplar simply never
      // appeared: R7's capture worked, its mining never ran. Verified live before
      // and after this change.
      jobId: `${job.tenantId}__${job.consultationId}`,
      attempts: 3,
      backoff: { type: 'exponential', delay: 5_000 },
      removeOnComplete: true,
      removeOnFail: 100,
    });
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
@Processor(JobQueue.MineGateEditExemplar)
export class GateEditMiningProcessor extends WorkerHost {
  private readonly logger = new Logger(GateEditMiningProcessor.name);

  constructor(
    private readonly miningService: GateEditMiningService,
    private readonly contextItemRepository: ContextItemRepository,
    private readonly contextItemVersionRepository: ContextItemVersionRepository,
    private readonly consultationRepository: ConsultationRepository,
    private readonly cls: ClsService<IActiveUserContext>,
    // TASK-815 §11 row 3 — the tenant's VISIT-TYPE catalogue, which replaces the
    // `parentConsultationId ? 'revisit' : 'new-patient'` literal below. Optional
    // + trailing so existing positional fixtures keep their arity; an unwired
    // resolver serves the two shipped visit types, whose keys and follow-up rule
    // are byte-identical to the ternary it replaces.
    @Optional() @Inject(VisitTypeService) private readonly visitTypes?: VisitTypeService,
  ) {
    super();
  }

  async process(job: Job<GateEditMiningJob>): Promise<void> {
    const { tenantId, consultationId, contextItemId, gateDecision, signedAt } = job.data;
    if (!tenantId) {
      throw new Error(`Gate-edit mining job ${job.id} is missing required tenantId`);
    }

    // Rebind CLS so the tenant-scope Prisma extension sees the right context —
    // the queue worker has no request context of its own.
    return this.cls.run(async () => {
      this.cls.set('tenantId', tenantId);
      this.cls.set('user', createWorkerSession({ tenantId, kind: 'gate-edit-mining' }));

      const consultation = await this.consultationRepository.findById(consultationId).catch(() => null);

      // The delivered AI draft is version 1 (`ai_draft_v1`); the signed note is
      // the latest. Both are read TRANSIENTLY — only their redacted forms are
      // ever persisted by the mining service.
      const versions = contextItemId
        ? await this.contextItemVersionRepository.getVersionsByChangeReason(contextItemId, 'approved').catch(() => [])
        : [];
      const delivered = contextItemId ? await this.loadDeliveredDraft(contextItemId) : null;
      const signed = versions.length > 0 ? (versions[versions.length - 1].content ?? null) : null;

      await this.miningService.mineFromGateDecision({
        tenantId,
        consultationId,
        departmentId: consultation?.departmentId ?? null,
        // The mined retrieval facet carries the TENANT's visit-type key
        // (TASK-815 §11 row 3), so a tenant that defines its own vocabulary
        // mines and retrieves exemplars under it rather than under a platform
        // literal. `parentConsultationId` remains the follow-up signal.
        visitType: (this.visitTypes ?? DEFAULT_VISIT_TYPE_SERVICE).forConsultation(tenantId, {
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
