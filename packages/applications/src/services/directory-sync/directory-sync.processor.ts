import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, Logger, Optional } from '@nestjs/common';
import { Job } from 'bullmq';
import { ClsService } from 'nestjs-cls';
import { CoreDatabaseService, FederatedIdentityRepository, JobQueue, ResourceStatusType, TenantIdentityProviderRepository } from '@arcaai/domains';
import { assertEqualTenants, createWorkerSession } from '../../common';
import { IActiveUserContext } from '../../interfaces';
import { SecretsService } from '../baseServices/_meta/secrets';
import { IEntitlementsService } from '../entitlements/IEntitlementsService';
import { FederatedAuthService } from '../federated-auth/federated-auth.service';
import { GoogleDirectoryProvider } from './google-directory.provider';
import { IDirectoryProvider } from './IDirectoryProvider';
import { MsGraphDirectoryProvider } from './ms-graph-directory.provider';
import { EffectiveSettingsService } from '../settings-registry/effective-settings.service';
import { directoryAvailabilityKey, isDirectorySyncEnabled } from './directory-availability';

export interface SyncTenantDirectoryUsersJobPayload {
  jobId?: string;
  tenantId: string;
  providerId: string;
}

export interface SyncTenantDirectoryUsersResult {
  tenantId: string;
  providerId: string;
  processed: number;
  created: number;
  skipped: number;
  skippedReasons: Array<{ externalId: string; email?: string; reason: string }>;
}

/**
 * DirectorySyncProcessor — admin-triggered directory
 * pre-provisioning worker. Mirrors `IngestKnowledgeDocumentProcessor`: a
 * fail-closed `tenantId` guard, CLS rebind via `createWorkerSession` (workers
 * run outside the API's ClsModule middleware), and `assertEqualTenants`
 * defense-in-depth against a stale payload.
 *
 * Per-user provisioning reuses `FederatedAuthService.resolveOrProvisionUser`
 * verbatim (same JIT transaction, group→role mapping, SUPER_ADMIN guard as
 * login-time JIT) so directory-pull and OIDC login can never diverge on "how
 * a HOPE user gets created". A per-user failure (seat quota, provisioning
 * error) is caught and recorded — the batch continues rather than aborting.
 */
@Processor(JobQueue.SyncTenantDirectoryUsers)
export class DirectorySyncProcessor extends WorkerHost {
  private readonly logger = new Logger(DirectorySyncProcessor.name);

  constructor(
    private readonly providerRepository: TenantIdentityProviderRepository,
    private readonly federatedIdentityRepository: FederatedIdentityRepository,
    private readonly msGraphProvider: MsGraphDirectoryProvider,
    private readonly googleProvider: GoogleDirectoryProvider,
    private readonly federatedAuthService: FederatedAuthService,
    private readonly cls: ClsService<IActiveUserContext>,
    @Inject(SecretsService) private readonly secretsService: SecretsService,
    @Inject('CORE_DATABASE_SERVICE') private readonly databaseService: CoreDatabaseService,
    // Optional + kill-switch-gated, same posture as UserService.create().
    @Optional() @Inject(IEntitlementsService) private readonly entitlements?: IEntitlementsService,
    // TASK-870 item 12 — the per-tenant availability gate. @Optional like the
    // entitlements service; absent DENIES, because a capability never grants itself.
    @Optional() @Inject(EffectiveSettingsService) private readonly effectiveSettings?: EffectiveSettingsService,
  ) {
    super();
  }

  async process(job: Job<SyncTenantDirectoryUsersJobPayload>): Promise<SyncTenantDirectoryUsersResult> {
    const { jobId, tenantId, providerId } = job.data;
    if (!tenantId) {
      throw new Error(`Job ${jobId ?? job.id} is missing required tenantId`);
    }

    return this.cls.run(async () => {
      this.cls.set('tenantId', tenantId);
      this.cls.set('user', createWorkerSession({ tenantId, kind: 'directory-sync' }));

      const provider = await this.providerRepository.findById(providerId);
      if (!provider) {
        throw new Error(`TenantIdentityProvider ${providerId} not found`);
      }
      assertEqualTenants(provider, { tenantId });

      if (!provider.directoryCredentialsRef) {
        throw new Error('Identity provider has no directory API credentials configured');
      }
      const config = provider.config as unknown as { directoryProvider?: string };
      // TASK-870 item 12 — re-check availability HERE, not only at enqueue. The
      // enqueue check gives a caller a fast 400; this one is the work boundary, so
      // a capability a platform admin disables stops syncing even for a job that
      // was already queued (BullMQ retries and a drained worker can both widen
      // that window well past "seconds").
      if (!(await isDirectorySyncEnabled(this.effectiveSettings, tenantId, config.directoryProvider))) {
        throw new Error(
          `Directory sync is not enabled for this tenant (${String(directoryAvailabilityKey(config.directoryProvider) ?? config.directoryProvider)})`,
        );
      }
      const directoryProvider = this.pickProvider(config.directoryProvider);
      const credentials = JSON.parse((await this.secretsService.decrypt(provider.directoryCredentialsRef)).toString('utf8'));

      let pageToken: string | undefined;
      let pageIndex = 0;
      let processed = 0;
      let created = 0;
      let skipped = 0;
      const skippedReasons: SyncTenantDirectoryUsersResult['skippedReasons'] = [];

      do {
        const page = await directoryProvider.fetchUsers(credentials, pageToken);

        for (const user of page.users) {
          processed++;
          try {
            const existingLink = await this.federatedIdentityRepository.findByProviderAndSubject(provider.id, user.externalId);

            if (!existingLink && this.entitlements?.isEnforcementEnabled()) {
              const seats = await this.countTenantSeats(tenantId);
              await this.entitlements.assertQuantityQuota(tenantId, 'maxUsers', seats);
            }

            await this.federatedAuthService.resolveOrProvisionUser(user.externalId, provider, {
              sub: user.externalId,
              email: user.email,
              groups: user.groups,
            });

            if (!existingLink) created++;
          } catch (error) {
            skipped++;
            skippedReasons.push({
              externalId: user.externalId,
              email: user.email,
              reason: error instanceof Error ? error.message : String(error),
            });
          }
        }

        pageToken = page.nextPageToken;
        pageIndex++;
        await job.updateProgress(Math.min(95, pageIndex * 20));
      } while (pageToken);

      await job.updateProgress(100);

      this.logger.log({
        message: 'Tenant directory sync completed',
        jobId,
        tenantId,
        providerId,
        processed,
        created,
        skipped,
      });

      return { tenantId, providerId, processed, created, skipped, skippedReasons };
    });
  }

  private pickProvider(key: string | undefined): IDirectoryProvider {
    if (key === 'ms-graph') return this.msGraphProvider;
    if (key === 'google-directory') return this.googleProvider;
    throw new Error(`Unknown or unset directoryProvider '${key}'`);
  }

  /** Mirrors `UserService.countTenantSeats` — distinct users with at least one ENABLED role assignment. */
  private async countTenantSeats(tenantId: string): Promise<number> {
    const rows = await this.databaseService.baseClient.userRoleAssignment.findMany({
      where: { tenantId, resourceStatus: ResourceStatusType.ENABLED },
      select: { userId: true },
      distinct: ['userId'],
    });
    return rows.length;
  }
}
