import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { uuidv7 } from 'uuidv7';
import { JobQueue, TenantIdentityProviderRepository } from '@arcaai/domains';
import type { SyncTenantDirectoryUsersJobPayload } from './directory-sync.processor';

export interface EnqueueSyncResult {
  jobId: string;
}

/**
 * TASK-498 P3 — admin-triggered directory pre-provisioning. Validates the
 * provider row (tenant-owned, has a `directoryProvider` + sealed
 * `directoryCredentialsRef`) and enqueues a `SyncTenantDirectoryUsers` BullMQ
 * job; `DirectorySyncProcessor` does the actual paged pull + idempotent
 * upsert. Progress/result are polled via the existing `/admin/queues/:queueName/jobs/:jobId`
 * surface (`queue-admin` module) — no dedicated status endpoint needed.
 */
@Injectable()
export class DirectorySyncService {
  constructor(
    private readonly providerRepository: TenantIdentityProviderRepository,
    @InjectQueue(JobQueue.SyncTenantDirectoryUsers) private readonly syncQueue: Queue,
  ) {}

  async enqueueSync(tenantId: string, providerId: string): Promise<EnqueueSyncResult> {
    const provider = await this.providerRepository.findById(providerId);
    if (!provider || provider.tenantId !== tenantId) {
      throw new NotFoundException('Identity provider not found');
    }

    const config = provider.config as unknown as { directoryProvider?: string };
    if (!config.directoryProvider) {
      throw new BadRequestException('This provider has no directoryProvider configured — set config.directoryProvider first');
    }
    if (!provider.directoryCredentialsRef) {
      throw new BadRequestException('This provider has no directory API credentials configured');
    }

    const jobId = uuidv7();
    const payload: SyncTenantDirectoryUsersJobPayload = { jobId, tenantId, providerId };
    // Idempotent upsert (keyed on providerId+subject) makes a full-job retry
    // safe — a transient Graph/Directory API blip mid-page just re-processes
    // already-synced users as no-ops, same `attempts: 3` policy as the other queues.
    await this.syncQueue.add(JobQueue.SyncTenantDirectoryUsers, payload, { jobId, attempts: 3 });

    return { jobId };
  }
}
