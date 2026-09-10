import { BadRequestException, Inject, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { uuidv7 } from 'uuidv7';
import { JobQueue, TenantIdentityProviderRepository } from '@arcaai/domains';
import type { SyncTenantDirectoryUsersJobPayload } from './directory-sync.processor';
import { EffectiveSettingsService } from '../settings-registry/effective-settings.service';
import { directorySyncDisabledError, isDirectorySyncEnabled } from './directory-availability';

export interface EnqueueSyncResult {
  jobId: string;
}

/**
 * Admin-triggered directory pre-provisioning. Validates the
 * provider row (tenant-owned, has a `directoryProvider` + sealed
 * `directoryCredentialsRef`) and enqueues a `SyncTenantDirectoryUsers` BullMQ
 * job; `DirectorySyncProcessor` does the actual paged pull + idempotent
 * upsert. Availability is a per-tenant feature gate a PLATFORM admin owns
 * (TASK-870 item 12) — checked here so a refusal is a 400 rather than a job that
 * fails minutes later, and re-checked in the worker so disabling it stops work
 * already queued. Progress/result are polled via the existing `/admin/queues/:queueName/jobs/:jobId`
 * surface (`queue-admin` module) — no dedicated status endpoint needed.
 */
@Injectable()
export class DirectorySyncService {
  constructor(
    private readonly providerRepository: TenantIdentityProviderRepository,
    @InjectQueue(JobQueue.SyncTenantDirectoryUsers) private readonly syncQueue: Queue,
    // TASK-870 item 12 — resolves the per-tenant availability gate. @Optional so a
    // hand-constructed instance still builds; absent DENIES (a capability never
    // grants itself), which is also what the declared `false` default yields.
    @Optional() @Inject(EffectiveSettingsService) private readonly effectiveSettings?: EffectiveSettingsService,
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
    // TASK-870 item 12 — availability, resolved for THIS tenant. Last of the
    // validation chain on purpose: a caller whose row is misconfigured should hear
    // about the configuration first, and the gate is the one check that can change
    // under them without any edit to their row.
    if (!(await isDirectorySyncEnabled(this.effectiveSettings, tenantId, config.directoryProvider))) {
      throw directorySyncDisabledError(config.directoryProvider);
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
