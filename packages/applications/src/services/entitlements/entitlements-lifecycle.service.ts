import { ForbiddenException, Inject, Injectable, Logger, NotFoundException, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';
import { ClsService } from 'nestjs-cls';
import { CoreDatabaseService, EntityId, ResourceStatusType, ResourceType, SysEventType, TenantPlan } from '@arcaai/domains';
import { BaseService } from '../../common';
import { createWorkerSession } from '../../common/worker-session';
import { IActiveUserContext } from '../../interfaces';
import { IAppSettingsService } from '../baseServices/_meta/appSettings/IAppSettingsService';
import { GLOBAL_TENANT_KEY } from '../tenant/constants';
import { IEntitlementsService } from './IEntitlementsService';
import {
  DowngradeDisabledGroup,
  DowngradeReport,
  IEntitlementsLifecycleService,
  TrialExpiryReport,
} from './IEntitlementsLifecycleService';
import { EntitlementLimitKey, isTrialExpired, selectResourcesToDisable } from './enforcement';
import {
  ENTITLEMENTS_DOWNGRADE_APPLIED_EVENT,
  ENTITLEMENTS_TRIAL_EXPIRED_EVENT,
  TRIAL_EXPIRY_CRON_KEY,
  TRIAL_EXPIRY_DEFAULTS,
  TRIAL_EXPIRY_ENABLED_KEY,
  TRIAL_EXPIRY_JOB_NAME,
} from './entitlements-lifecycle.constants';

const SYSTEM_TENANT_ID = '00000000-0000-0000-0000-000000000000';

/** Minimal structural view of a status-bearing model delegate (Q10 targets). */
interface SoftDisableDelegate {
  findMany(args: {
    where: { tenantId: string; resourceStatus: ResourceStatusType };
    select: { id: true; createdAt: true };
    orderBy?: { createdAt: 'asc' };
  }): Promise<Array<{ id: string; createdAt: Date }>>;
  updateMany(args: {
    where: { id: { in: string[] } };
    data: { resourceStatus: ResourceStatusType; resourceStatusUpdatedAt: Date; resourceStatusUpdatedBy: string | null };
  }): Promise<{ count: number }>;
}

/**
 * (Q4 trial-expiry + Q10 downgrade) — cross-tenant lifecycle jobs.
 *
 * Deliberately separate from the request-scoped {@link EntitlementsService}:
 * both actions run OUTSIDE a normal request (a scheduled sweep, or a
 * super-admin acting on ANOTHER tenant), so every mutation goes through the
 * UNSCOPED `baseClient` with an explicit `tenantId` and is wrapped in a fresh
 * per-tenant CLS scope — the same rebind the BullMQ processors use — so the
 * `SysEvent`/audit is attributed to the TARGET tenant, not the (absent/foreign)
 * ambient one.
 *
 * The trial-expiry sweep is self-scheduling and OFF by default (mirrors the
 * metering reconcile / audit-retention purge). The downgrade action is an
 * explicit trigger; its soft-disable is gated behind the enforcement
 * kill-switch (Q9) and is a reversible `resourceStatus = DISABLED` flip that
 * NEVER deletes (Q10).
 */
@Injectable()
export class EntitlementsLifecycleService
  extends BaseService
  implements IEntitlementsLifecycleService, OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(EntitlementsLifecycleService.name);
  private activeCron: string | null = null;

  constructor(
    @Inject('CORE_DATABASE_SERVICE') private readonly databaseService: CoreDatabaseService,
    @Inject(IEntitlementsService) private readonly entitlements: IEntitlementsService,
    @Inject(IAppSettingsService) private readonly appSettings: IAppSettingsService,
    private readonly schedulerRegistry: SchedulerRegistry,
    protected override readonly eventEmitter: EventEmitter2,
    protected override readonly clsService: ClsService<IActiveUserContext>,
  ) {
    super(eventEmitter, clsService, ResourceType.Tenant);
  }

  onModuleInit(): void {
    this.syncSchedulerFromConfig();
  }

  onModuleDestroy(): void {
    this.stopJob();
  }

  @OnEvent('app-settings.cache-refreshed')
  onSettingsRefreshed(): void {
    this.syncSchedulerFromConfig();
  }

  // ── Trial-expiry (Q4) — plan-only, resourceStatus untouched ──────────────

  async expireTrials(now: Date = new Date()): Promise<TrialExpiryReport> {
    // Unscoped read — the sweep has no CLS tenant context. Filter to TRIAL up
    // front so a tenant already off-trial is never re-examined (idempotent).
    const trials = await this.databaseService.baseClient.tenant.findMany({
      where: { plan: TenantPlan.TRIAL },
      select: { id: true, key: true, plan: true, trialEndsAt: true },
    });

    const tenantIds: EntityId[] = [];
    for (const tenant of trials) {
      if (this.isSystemTenant(tenant)) continue; // never trial-manage the platform tenant
      if (!isTrialExpired(tenant.trialEndsAt, now)) continue;

      try {
        await this.runForTenant(tenant.id, null, async () => {
          // PLAN-ONLY change (proposal §4): flip TRIAL → STARTER, leave
          // `resourceStatus` exactly as-is (plan and lifecycle are orthogonal).
          await this.databaseService.baseClient.tenant.update({
            where: { id: tenant.id },
            data: { plan: TenantPlan.STARTER },
          });

          this.broadcastSysEvent(SysEventType.ResourceUpdated, {
            resourceId: tenant.id,
            data: { plan: TenantPlan.STARTER, previousPlan: TenantPlan.TRIAL, reason: 'trial-expired' },
          });
          this.eventEmitter.emit(ENTITLEMENTS_TRIAL_EXPIRED_EVENT, {
            tenantId: tenant.id,
            previousPlan: TenantPlan.TRIAL,
            plan: TenantPlan.STARTER,
            trialEndsAt: tenant.trialEndsAt,
            at: now,
          });
        });
        tenantIds.push(tenant.id);
      } catch (error) {
        this.logger.error(`Trial expiry failed for tenant ${tenant.id}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    return { examined: trials.length, downgraded: tenantIds.length, tenantIds };
  }

  // ── Downgrade (Q10) — block-new + newest-first soft-disable ──────────────

  async triggerDowngrade(tenantId: EntityId, newPlan: TenantPlan): Promise<DowngradeReport> {
    if (tenantId === SYSTEM_TENANT_ID) {
      throw new ForbiddenException('The system tenant cannot be downgraded.');
    }

    const tenant = await this.databaseService.baseClient.tenant.findUnique({
      where: { id: tenantId },
      select: { id: true, key: true, plan: true },
    });
    if (!tenant) {
      throw new NotFoundException(`Tenant '${tenantId}' not found.`);
    }
    if (this.isSystemTenant(tenant)) {
      throw new ForbiddenException('The system tenant cannot be downgraded.');
    }

    const fromPlan = (tenant.plan as TenantPlan | null | undefined) ?? null;
    const enforcementEnabled = this.entitlements.isEnforcementEnabled();
    // Preserve the acting super-admin (from the outer request CLS) as the
    // responsible actor, even though we rebind CLS to the TARGET tenant below.
    const actingUserId = this.requestUserId;

    const disabled: DowngradeDisabledGroup[] = [];

    await this.runForTenant(tenantId, actingUserId, async () => {
      // The plan change ALWAYS applies (it is the admin's explicit intent).
      await this.databaseService.baseClient.tenant.update({
        where: { id: tenantId },
        data: { plan: newPlan },
      });
      this.broadcastSysEvent(SysEventType.ResourceUpdated, {
        resourceId: tenantId,
        data: { plan: newPlan, previousPlan: fromPlan, reason: 'downgrade' },
      });

      // Q10 soft-disable is gated behind the kill-switch (Q9): with enforcement
      // OFF the downgrade is a pure relabel — block-new begins only once
      // enforcement is later enabled, grandfathering everything in between.
      if (enforcementEnabled) {
        const resolved = await this.entitlements.resolveForTenant(tenantId);
        for (const target of this.softDisableTargets()) {
          const limit = resolved.limits[target.capability];
          const group = await this.softDisableOverflow(tenantId, target, limit, actingUserId);
          disabled.push(group);
        }
      }

      const totalDisabled = disabled.reduce((sum, g) => sum + g.disabledCount, 0);
      if (totalDisabled > 0) {
        this.eventEmitter.emit(ENTITLEMENTS_DOWNGRADE_APPLIED_EVENT, {
          tenantId,
          fromPlan,
          toPlan: newPlan,
          totalDisabled,
          disabled,
          at: new Date(),
        });
      }
    });

    return {
      tenantId,
      fromPlan,
      toPlan: newPlan,
      enforcementEnabled,
      disabled,
      totalDisabled: disabled.reduce((sum, g) => sum + g.disabledCount, 0),
    };
  }

  getConfig(): { enabled: boolean; cron: string } {
    return {
      enabled: this.appSettings.getValueWithDefault<boolean>(TRIAL_EXPIRY_ENABLED_KEY, TRIAL_EXPIRY_DEFAULTS.enabled),
      cron: this.appSettings.getValueWithDefault<string>(TRIAL_EXPIRY_CRON_KEY, TRIAL_EXPIRY_DEFAULTS.cron),
    };
  }

  async handleScheduledTrialExpiry(): Promise<void> {
    if (!this.getConfig().enabled) {
      this.logger.debug('Trial-expiry sweep disabled — skipping tick');
      return;
    }
    try {
      const report = await this.expireTrials();
      this.logger.log({ message: 'Trial-expiry sweep completed', examined: report.examined, downgraded: report.downgraded });
    } catch (error) {
      this.logger.error(`Trial-expiry tick failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // ── Internals ────────────────────────────────────────────────────────────

  private isSystemTenant(tenant: { id: string; key?: string | null }): boolean {
    const isGlobalKey = (tenant.key ?? '').toUpperCase() === GLOBAL_TENANT_KEY.toUpperCase();
    return isGlobalKey || tenant.id === SYSTEM_TENANT_ID;
  }

  /**
   * Re-establish a fresh per-tenant CLS scope so `broadcastSysEvent` attributes
   * the audit row to the TARGET tenant (not the absent/foreign ambient one),
   * exactly like the BullMQ processors' rebind. `actingUserId` keeps the real
   * super-admin as the responsible actor for an admin-triggered downgrade; it
   * is `null` for the system-driven trial sweep.
   */
  private runForTenant<T>(tenantId: EntityId, actingUserId: string | null, fn: () => Promise<T>): Promise<T> {
    return this.clsService.run(async () => {
      this.clsService.set('tenantId', tenantId);
      this.clsService.set('user', createWorkerSession({ userId: actingUserId, tenantId, kind: 'entitlements-lifecycle' }));
      return fn();
    });
  }

  /** The status-bearing quantity resources eligible for Q10 soft-disable. */
  private softDisableTargets(): Array<{ capability: EntitlementLimitKey; resourceType: ResourceType; delegate: SoftDisableDelegate }> {
    const db = this.databaseService.baseClient;
    return [
      { capability: 'maxDepartments', resourceType: ResourceType.Department, delegate: db.department as unknown as SoftDisableDelegate },
      { capability: 'maxPromptTemplates', resourceType: ResourceType.PromptTemplate, delegate: db.promptTemplate as unknown as SoftDisableDelegate },
      { capability: 'maxAsrPipelines', resourceType: ResourceType.AsrPipeline, delegate: db.asrPipeline as unknown as SoftDisableDelegate },
      { capability: 'maxApiKeys', resourceType: ResourceType.ApiKey, delegate: db.apiKey as unknown as SoftDisableDelegate },
    ];
  }

  private async softDisableOverflow(
    tenantId: EntityId,
    target: { capability: EntitlementLimitKey; resourceType: ResourceType; delegate: SoftDisableDelegate },
    limit: number | null,
    actingUserId: string | null,
  ): Promise<DowngradeDisabledGroup> {
    const empty: DowngradeDisabledGroup = {
      capability: target.capability,
      resourceType: target.resourceType,
      limit,
      disabledCount: 0,
      ids: [],
    };
    if (limit === null) return empty; // unlimited for this capability under the new plan

    const rows = await target.delegate.findMany({
      where: { tenantId, resourceStatus: ResourceStatusType.ENABLED },
      select: { id: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
    });

    const ids = selectResourcesToDisable(rows, limit);
    if (ids.length === 0) return empty;

    // Reversible status flip — NEVER a delete (Q10 guardrail).
    await target.delegate.updateMany({
      where: { id: { in: ids } },
      data: { resourceStatus: ResourceStatusType.DISABLED, resourceStatusUpdatedAt: new Date(), resourceStatusUpdatedBy: actingUserId },
    });

    return { capability: target.capability, resourceType: target.resourceType, limit, disabledCount: ids.length, ids };
  }

  // ── Scheduling (mirror MeteringService) ──────────────────────────────────

  private syncSchedulerFromConfig(): void {
    const { enabled, cron } = this.getConfig();
    if (!enabled) {
      if (this.activeCron) {
        this.logger.log('Trial-expiry sweep disabled via settings — stopping scheduler');
        this.stopJob();
      }
      return;
    }
    if (cron === this.activeCron) return;
    this.replaceJob(cron);
  }

  private replaceJob(cron: string): void {
    this.stopJob();
    try {
      const job = new CronJob(cron, async () => {
        await this.handleScheduledTrialExpiry();
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      this.schedulerRegistry.addCronJob(TRIAL_EXPIRY_JOB_NAME, job as any);
      job.start();
      this.activeCron = cron;
      this.logger.log({ message: 'Trial-expiry cron job scheduled', cron });
    } catch (error) {
      this.activeCron = null;
      this.logger.error({ message: 'Failed to schedule trial-expiry cron job', cron, error: error instanceof Error ? error.message : String(error) });
    }
  }

  private stopJob(): void {
    try {
      const existing = this.schedulerRegistry.getCronJob(TRIAL_EXPIRY_JOB_NAME);
      if (existing) {
        existing.stop();
        this.schedulerRegistry.deleteCronJob(TRIAL_EXPIRY_JOB_NAME);
      }
    } catch {
      // Job doesn't exist — nothing to stop.
    }
    this.activeCron = null;
  }
}
