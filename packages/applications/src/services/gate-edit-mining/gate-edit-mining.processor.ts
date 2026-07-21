import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue, Job } from 'bullmq';
import { ClsService } from 'nestjs-cls';
import { ContextItemRepository, ContextItemVersionRepository, ConsultationRepository, JobQueue } from '@arcaai/domains';
import { createWorkerSession } from '../../common';
import { IActiveUserContext } from '../../interfaces';
import { GateEditMiningService } from './gate-edit-mining.service';
import { GateEditMiningJob, IGateEditMiningQueue } from './IGateEditMiningQueue';

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
      jobId: `${job.tenantId}:${job.consultationId}`,
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
        visitType: consultation?.parentConsultationId ? 'revisit' : 'new-patient',
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
