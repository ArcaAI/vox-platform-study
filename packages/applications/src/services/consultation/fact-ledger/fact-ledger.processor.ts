import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { Job, Queue } from 'bullmq';
import { ClsService } from 'nestjs-cls';
import { JobQueue } from '@arcaai/domains';
import { createWorkerSession } from '../../../common';
import { postponeIfTenantLocked } from '../../../common/worker-session-lock';
import { IActiveUserContext } from '../../../interfaces';
import { QUEUE_CONCURRENCY } from '../../baseServices/redis/queue-concurrency';
import { runJobInContext } from '../../baseServices/observability/job-context';
import { ITenantLockService } from '../../tenant-checkpoint/contracts';
import { FactLedgerService } from './fact-ledger.service';

export interface FactLedgerJob {
  tenantId: string;
  consultationId: string;
  encounterSeq: number;
  /** The digest the job was enqueued for; the worker recomputes and skips when unchanged. */
  inputDigest: string;
}

/**
 * The enqueue half. One job per `(consultation, encounter, input digest)`: a repeated event for the
 * same input collapses onto the same job id, and a changed input (segment edit, late audio
 * transcript) is a new job.
 */
@Injectable()
export class FactLedgerQueue {
  constructor(@InjectQueue(JobQueue.ExtractFactLedger) private readonly queue: Queue) {}

  async enqueue(job: FactLedgerJob): Promise<void> {
    await this.queue.add(JobQueue.ExtractFactLedger, job, {
      // BullMQ rejects ':' in a custom id (it delimits its own Redis keys), so the
      // `ledger:{cid}:{seq}:{digest}` key is spelled with '__' and the digest without its prefix.
      jobId: factLedgerJobId(job),
      attempts: 3,
      backoff: { type: 'exponential', delay: 10_000 },
      removeOnComplete: 100,
      removeOnFail: 100,
    });
  }
}

export function factLedgerJobId(job: Pick<FactLedgerJob, 'consultationId' | 'encounterSeq' | 'inputDigest'>): string {
  return `ledger__${job.consultationId}__${job.encounterSeq}__${job.inputDigest.replace(/^sha256:/, '')}`;
}

/** The worker: binds the tenant, then builds (or skips) the encounter's ledger and recap. */
@Processor(JobQueue.ExtractFactLedger, { concurrency: QUEUE_CONCURRENCY[JobQueue.ExtractFactLedger] ?? 1 })
export class FactLedgerProcessor extends WorkerHost {
  private readonly logger = new Logger(FactLedgerProcessor.name);

  constructor(
    private readonly factLedger: FactLedgerService,
    private readonly cls: ClsService<IActiveUserContext>,
    @Optional() @Inject(ITenantLockService) private readonly tenantLock?: ITenantLockService,
  ) {
    super();
  }

  async process(job: Job<FactLedgerJob>, token?: string): Promise<void> {
    const { tenantId, consultationId, encounterSeq } = job.data;
    if (!tenantId) throw new Error(`Fact-ledger job ${job.id} is missing required tenantId`);

    await postponeIfTenantLocked(this.tenantLock, job, token, tenantId, ['CLINICAL']);
    return runJobInContext(this.cls, job, async () => {
      this.cls.set('tenantId', tenantId);
      this.cls.set('user', createWorkerSession({ tenantId, kind: 'fact-ledger' }));
      const result = await this.factLedger.buildForEncounter({ tenantId, consultationId, encounterSeq });
      this.logger.log({
        message: 'Fact ledger processed',
        consultationId,
        encounterSeq,
        status: result.status,
        ...(result.status === 'built' ? { factCount: result.factCount, ledgerVersion: result.ledgerVersion } : { reason: result.reason }),
      });
    });
  }
}
