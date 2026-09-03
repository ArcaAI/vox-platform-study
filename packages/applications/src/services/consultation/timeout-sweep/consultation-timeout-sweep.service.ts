import { Inject, Injectable, Logger, Optional, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { OnEvent } from '@nestjs/event-emitter';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ClsService } from 'nestjs-cls';
import { CronJob } from 'cron';
import { ConsultationEntity, ConsultationRepository, ConsultationStatus, HarnessAuditAction, ResourceType, SysEventType } from '@arcaai/domains';
import { BaseService, createWorkerSession } from '../../../common';
import { IActiveUserContext } from '../../../interfaces';
import { HarnessAuditService } from '../../harness-audit';
import { IAppSettingsService } from '../../baseServices/_meta/appSettings/IAppSettingsService';
import {
  CONSULTATION_GATE_DEFAULTS,
  CONSULTATION_SESSION_TIMEOUT_MINUTES_KEY,
  CONSULTATION_SESSION_TIMEOUT_SWEEP_CRON_KEY,
} from '../consultation-gates.constants';

const JOB_NAME = 'consultation-timeout-sweep';
const MS_PER_MINUTE = 60_000;

export interface ConsultationTimeoutSweepConfig {
  cron: string;
  timeoutMinutes: number;
}

export interface ConsultationTimeoutSweepResult {
  eligible: number;
  transitioned: number;
  failed: number;
}

/**
 *  — the session-timeout sweep.
 *
 * Transitions consultations that have sat in a sweep-eligible state
 * (`PRIMED`, `DRAINING`, `DRAFT_PENDING_SENSORS`, `TIMED_OUT`, `REOPENED`)
 * with no clinician activity past `consultation.state.sessionTimeoutMinutes`
 * to `CLOSED_INCOMPLETE` — the record closed with no human sign-off ever
 * recorded. `OPEN`, `RECORDING`, and `PENDING_REVIEW` are deliberately never
 * swept here (; `PENDING_REVIEW` has its own narrower
 * gate-SLA path, `HarnessInternalService.recordEscalation` →
 * `PENDING_REVIEW → TIMED_OUT`, which this sweep leaves untouched).
 *
 * Self-scheduling, mirroring {@link AuditRetentionService} /
 * {@link AgentTrajectoryRetentionService} / {@link DnaRegenerationScheduler}:
 * a `SchedulerRegistry` cron job that re-syncs whenever the `GlobalSetting`
 * cache refreshes (`@OnEvent('app-settings.cache-refreshed')`), so both the
 * sweep cadence (`consultation.state.sessionTimeoutSweep.cron`) and the
 * staleness window (`consultation.state.sessionTimeoutMinutes`) are tunable
 * live, with no redeploy. Deliberately WITHOUT an `enabled` kill-switch,
 * unlike those three siblings: each of them gates a HARD DELETE or an
 * expensive regeneration job behind an explicit opt-in; this worker performs
 * the same reversible-in-intent clinical status transition an authenticated
 * clinician can already trigger manually (`ConsultationService.closeConsultation`),
 * just on the platform's behalf when nobody is left to do it — so it ships
 * on by default (project posture: pre-production, no prod data, ship
 * complete rather than flag-gated).
 *
 * Per eligible row: `ConsultationEntity.transitionTo(CLOSED_INCOMPLETE,
 * 'system', 'session-timeout-sweep')` → `ConsultationRepository.updateWithVersion`
 * → `ResourceUpdated` sys-event → WORM `SESSION_CLOSED_INCOMPLETE` append —
 * exactly the persistence chain `ConsultationService.closeConsultation`
 * already uses for a manual close ( matrix rows).
 *
 * The eligibility QUERY (`ConsultationRepository.findTimeoutSweepEligible`)
 * runs cross-tenant with no CLS context active (a platform-wide maintenance
 * tick, not a per-tenant request — the tenant-scope Prisma extension passes
 * through when no CLS tenant is set). Each row's WRITE, however, needs the
 * correct tenant attributed on its sys-event and WORM row, so it is wrapped
 * in its own `clsService.run()` with the row's own `tenantId` bound — the
 * exact pattern `HarnessInternalService.recordEscalation` already uses for a
 * system/workflow-initiated transition, and the one `BaseService.broadcastSysEvent`'s
 * own doc comment calls out for "background/system processes... e.g. cron jobs".
 */
@Injectable()
export class ConsultationTimeoutSweepService extends BaseService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ConsultationTimeoutSweepService.name);
  private activeCron: string | null = null;

  constructor(
    private readonly consultationRepository: ConsultationRepository,
    protected override readonly eventEmitter: EventEmitter2,
    protected override readonly clsService: ClsService<IActiveUserContext>,
    @Inject(IAppSettingsService) private readonly appSettingsService: IAppSettingsService,
    private readonly schedulerRegistry: SchedulerRegistry,
    // Optional, mirroring `ConsultationService`: absent ⇒ the WORM append
    // no-ops (best-effort — a failed WORM write never rolls back the
    // already-persisted status transition).
    @Optional() @Inject(HarnessAuditService) private readonly harnessAuditService?: HarnessAuditService,
  ) {
    super(eventEmitter, clsService, ResourceType.Consultation);
  }

  onModuleInit(): void {
    this.syncSchedulerFromConfig();
  }

  onModuleDestroy(): void {
    this.stopJob();
  }

  /**
   * Reacts to `AppSettingsService` cache refreshes (every ~45s).
   * Compares the live config against the running cron and adjusts.
   */
  @OnEvent('app-settings.cache-refreshed')
  onSettingsRefreshed(): void {
    this.syncSchedulerFromConfig();
  }

  getConfig(): ConsultationTimeoutSweepConfig {
    return {
      cron: this.appSettingsService.getValueWithDefault<string>(
        CONSULTATION_SESSION_TIMEOUT_SWEEP_CRON_KEY,
        CONSULTATION_GATE_DEFAULTS[CONSULTATION_SESSION_TIMEOUT_SWEEP_CRON_KEY],
      ),
      timeoutMinutes: this.appSettingsService.getValueWithDefault<number>(
        CONSULTATION_SESSION_TIMEOUT_MINUTES_KEY,
        CONSULTATION_GATE_DEFAULTS[CONSULTATION_SESSION_TIMEOUT_MINUTES_KEY],
      ),
    };
  }

  /**
   * Reads config from `AppSettingsService` and ensures the running cron job
   * matches. Creates or replaces the job as needed. No `enabled` gate — see
   * the class doc comment for why this sweep ships on by default.
   */
  syncSchedulerFromConfig(): void {
    const { cron } = this.getConfig();

    if (cron === this.activeCron) {
      return;
    }

    this.replaceJob(cron);
  }

  /**
   * The callback executed by the cron job on each tick.
   */
  async handleScheduledSweep(): Promise<void> {
    this.logger.log('Starting scheduled session-timeout sweep');

    try {
      const result = await this.sweepOnce();
      this.logger.log({ message: 'Session-timeout sweep completed', ...result });
    } catch (error) {
      this.logger.error(`Session-timeout sweep failed: ${error}`);
    }
  }

  /**
   * One sweep pass: find every sweep-eligible consultation past the
   * configured staleness window and transition each to `CLOSED_INCOMPLETE`.
   * A single row's failure (an illegal-transition race, a concurrent
   * `OptimisticConcurrencyException`) is logged and skipped — it never
   * aborts the rest of the batch.
   */
  async sweepOnce(): Promise<ConsultationTimeoutSweepResult> {
    const { timeoutMinutes } = this.getConfig();

    // Safety guard, mirroring `AuditRetentionService.purgeExpired`: a
    // non-positive window would set the cutoff at (or after) "now" and sweep
    // every eligible row in the platform in one tick.
    if (timeoutMinutes < 1) {
      this.logger.warn({
        message: 'Session-timeout sweep window is non-positive — refusing to sweep',
        timeoutMinutes,
      });
      return { eligible: 0, transitioned: 0, failed: 0 };
    }

    const cutoff = new Date(Date.now() - timeoutMinutes * MS_PER_MINUTE);
    const eligible = await this.consultationRepository.findTimeoutSweepEligible(cutoff);

    let transitioned = 0;
    let failed = 0;

    for (const consultation of eligible) {
      try {
        await this.transitionOneConsultation(consultation);
        transitioned++;
      } catch (error) {
        failed++;
        this.logger.warn({
          message: 'Session-timeout sweep: failed to transition a consultation (non-fatal — the sweep continues with the next row)',
          consultationId: consultation.id,
          tenantId: consultation.tenantId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return { eligible: eligible.length, transitioned, failed };
  }

  /**
   * Transitions one row, with the write correctly attributed to ITS OWN
   * tenant. `broadcastSysEvent`'s `tenantId` is sourced exclusively from CLS
   * (never the payload — see its doc comment), so the sweep — which runs
   * with no CLS context of its own — must bind one per row rather than once
   * for the whole tick. Mirrors `HarnessInternalService.recordEscalation`'s
   * `cls.run(...)` + `createWorkerSession(...)` pattern for a
   * system-initiated transition.
   */
  private async transitionOneConsultation(consultation: ConsultationEntity): Promise<void> {
    await this.clsService.run(async () => {
      this.clsService.set('tenantId', consultation.tenantId);
      this.clsService.set('user', createWorkerSession({ tenantId: consultation.tenantId, kind: 'session-timeout-sweep' }));

      const expectedVersion = consultation.version;
      const applied = consultation.transitionTo(ConsultationStatus.CLOSED_INCOMPLETE, 'system', 'session-timeout-sweep');
      // Defensive only: `findTimeoutSweepEligible` returns just the five
      // legal predecessor states, so `applied` is always true in practice.
      if (!applied) {
        return;
      }

      await this.consultationRepository.updateWithVersion(consultation.id, consultation, expectedVersion);

      this.broadcastSysEvent(SysEventType.ResourceUpdated, {
        resourceId: consultation.id,
        data: { action: 'session-timeout-sweep', status: ConsultationStatus.CLOSED_INCOMPLETE },
      });

      if (!this.harnessAuditService) {
        return;
      }

      try {
        await this.harnessAuditService.append({
          tenantId: consultation.tenantId,
          consultationId: consultation.id,
          action: HarnessAuditAction.SESSION_CLOSED_INCOMPLETE,
          modelName: 'session-lifecycle',
          modelVersion: 'v1',
          sensorScores: {},
          citations: [],
          createdBy: null,
        });
      } catch (error) {
        // Best-effort, mirroring `ConsultationService.appendTransitionAudit`:
        // a WORM-append failure is logged but never rolls back the
        // already-persisted status write.
        this.logger.warn({
          message: 'WORM append failed for a session-timeout-sweep transition (non-fatal, status write not rolled back)',
          consultationId: consultation.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    });
  }

  // ── Private helpers ──────────────────────────────────────────

  private replaceJob(cron: string): void {
    this.stopJob();

    try {
      const job = new CronJob(cron, async () => {
        await this.handleScheduledSweep();
      });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- SchedulerRegistry's CronJob generic doesn't line up with the `cron` package's own CronJob type; mirrors the identical cast in the sibling retention schedulers
      this.schedulerRegistry.addCronJob(JOB_NAME, job as any);
      job.start();
      this.activeCron = cron;

      this.logger.log({ message: 'Session-timeout sweep cron job scheduled', cron });
    } catch (error) {
      this.activeCron = null;
      this.logger.error({
        message: 'Failed to schedule session-timeout sweep cron job',
        cron,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private stopJob(): void {
    try {
      const existing = this.schedulerRegistry.getCronJob(JOB_NAME);
      if (existing) {
        existing.stop();
        this.schedulerRegistry.deleteCronJob(JOB_NAME);
      }
    } catch {
      // Job doesn't exist — nothing to stop
    }
    this.activeCron = null;
  }
}
