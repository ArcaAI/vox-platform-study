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
import { IConsultationService } from '../consultation/IConsultationService';
import { IRedisCacheService } from '../../baseServices/redis';
import {
  CONSULTATION_GATE_DEFAULTS,
  CONSULTATION_RECORDING_STALE_MINUTES_KEY,
  CONSULTATION_SESSION_TIMEOUT_MINUTES_KEY,
  CONSULTATION_SESSION_TIMEOUT_SWEEP_CRON_KEY,
} from '../consultation-gates.constants';

const JOB_NAME = 'consultation-timeout-sweep';
const MS_PER_MINUTE = 60_000;

/**
 * The live-summary lock key format `LiveDocumentationService` writes
 * (`CHANNEL_PREFIX + ':lock'`, `packages/applications/src/services/consultation/
 * live-documentation/live-documentation.service.ts`). MIRRORED here rather
 * than imported — that file belongs to a different TASK-932 lane — so keep
 * the two in sync by hand if the lock key format ever changes.
 */
export function liveSummaryLockKey(consultationId: string): string {
  return `consultation:live-summary:${consultationId}:lock`;
}

export interface ConsultationTimeoutSweepConfig {
  cron: string;
  timeoutMinutes: number;
  recordingStaleMinutes: number;
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
 * recorded. `OPEN` and `PENDING_REVIEW` are deliberately never swept here
 * (; `PENDING_REVIEW` has its own narrower gate-SLA path,
 * `HarnessInternalService.recordEscalation` → `PENDING_REVIEW → TIMED_OUT`,
 * which this sweep leaves untouched).
 *
 * TASK-932 OD-9 added a SECOND leg, {@link sweepStaleRecordings}: a
 * `RECORDING` row whose `updatedAt` is older than
 * `consultation.state.recordingStaleMinutes` (window N) AND holds no
 * `consultation:live-summary:{id}:lock` key is genuinely orphaned — the
 * capturing browser/tab is gone, not merely between chunks — and is stopped
 * through the REAL client path, `ConsultationService.stopRecording`, landing
 * it in `DRAINING`, where THIS leg (window M) eventually takes over. Both
 * signals — age AND an absent lock — are required, so an active capture
 * session is never force-terminated by a tick.
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
    // TASK-932 OD-9 — the RECORDING leg's real stop path (the SAME method a
    // client uses, `POST :id/recording/stop`) and the live-summary lock
    // check that decides whether a stale row is genuinely orphaned.
    @Inject(IConsultationService) private readonly consultationService: IConsultationService,
    @Inject(IRedisCacheService) private readonly cacheService: IRedisCacheService,
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
      recordingStaleMinutes: this.appSettingsService.getValueWithDefault<number>(
        CONSULTATION_RECORDING_STALE_MINUTES_KEY,
        CONSULTATION_GATE_DEFAULTS[CONSULTATION_RECORDING_STALE_MINUTES_KEY],
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
   * The callback executed by the cron job on each tick. Runs BOTH legs —
   * the RECORDING leg first (so a row it stops has a chance to age into the
   * DRAINING leg on a LATER tick, never the same one), then the existing
   * five-state sweep — each in its own try/catch so one leg's failure never
   * blocks the other.
   */
  async handleScheduledSweep(): Promise<void> {
    this.logger.log('Starting scheduled session-timeout sweep');

    try {
      const recordingResult = await this.sweepStaleRecordings();
      this.logger.log({ message: 'Stale-recording sweep completed', ...recordingResult });
    } catch (error) {
      this.logger.error(`Stale-recording sweep failed: ${error}`);
    }

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
   *
   * `overrides.timeoutMinutes`, when supplied, takes precedence over the
   * descriptor-resolved value for THIS call only (nothing is persisted) —
   * the one-off dev cleanup script (TASK-932 O-2) uses it to sweep today's
   * orphans without changing the platform's standing
   * `consultation.state.sessionTimeoutMinutes` default.
   */
  async sweepOnce(overrides?: { timeoutMinutes?: number }): Promise<ConsultationTimeoutSweepResult> {
    const timeoutMinutes = overrides?.timeoutMinutes ?? this.getConfig().timeoutMinutes;

    // Safety guard, mirroring `AuditRetentionService.purgeExpired`: a
    // non-positive window would set the cutoff at (or after) "now" and sweep
    // every eligible row in the platform in one tick. Applies to an explicit
    // override too — there is no sanctioned way to bypass it.
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

  /**
   * TASK-932 OD-9 — the RECORDING leg. A `RECORDING` row whose `updatedAt`
   * is older than `overrides.recordingStaleMinutes` (or the descriptor
   * default, window N) is a CANDIDATE; it is only genuinely orphaned if it
   * ALSO holds no `consultation:live-summary:{id}:lock` key — an active
   * capture session must never be force-terminated by this tick. Each
   * orphaned row is stopped through the SAME path a real client uses
   * (`ConsultationService.stopRecording`), landing it in `DRAINING` — where
   * {@link sweepOnce} (window M) eventually takes over. A single row's
   * failure (lock lookup or the stop itself) never aborts the batch.
   *
   * `overrides.recordingStaleMinutes`, when supplied, takes precedence over
   * the descriptor-resolved value for THIS call only — the one-off dev
   * cleanup script (TASK-932 O-2) uses it the same way {@link sweepOnce}'s
   * override is used.
   */
  async sweepStaleRecordings(overrides?: { recordingStaleMinutes?: number }): Promise<ConsultationTimeoutSweepResult> {
    const recordingStaleMinutes = overrides?.recordingStaleMinutes ?? this.getConfig().recordingStaleMinutes;

    // Same safety guard as `sweepOnce`, applied to the other window.
    if (recordingStaleMinutes < 1) {
      this.logger.warn({
        message: 'Stale-recording sweep window is non-positive — refusing to sweep',
        recordingStaleMinutes,
      });
      return { eligible: 0, transitioned: 0, failed: 0 };
    }

    const cutoff = new Date(Date.now() - recordingStaleMinutes * MS_PER_MINUTE);
    const staleRows = await this.consultationRepository.findStaleRecording(cutoff);

    let transitioned = 0;
    let failed = 0;

    for (const consultation of staleRows) {
      try {
        const held = await this.cacheService.get(liveSummaryLockKey(consultation.id));
        if (held) {
          // Still genuinely live (an active LiveDocumentationService
          // session owns the lock) — leave it alone.
          continue;
        }

        await this.stopOneRecording(consultation);
        transitioned++;
      } catch (error) {
        failed++;
        this.logger.warn({
          message: 'Stale-recording sweep: failed to stop a consultation (non-fatal — the sweep continues with the next row)',
          consultationId: consultation.id,
          tenantId: consultation.tenantId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return { eligible: staleRows.length, transitioned, failed };
  }

  /**
   * Calls the real stop path, `ConsultationService.stopRecording`, with the
   * row's OWN tenant bound on CLS first — `stopRecording` reads `tenantId`
   * from CLS via `BaseService` exactly like this service does, and the
   * sweep runs with no CLS context of its own. Mirrors
   * `transitionOneConsultation`'s per-row binding pattern.
   */
  private async stopOneRecording(consultation: ConsultationEntity): Promise<void> {
    await this.clsService.run(async () => {
      this.clsService.set('tenantId', consultation.tenantId);
      this.clsService.set('user', createWorkerSession({ tenantId: consultation.tenantId, kind: 'session-timeout-sweep' }));

      await this.consultationService.stopRecording(consultation.id);
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
