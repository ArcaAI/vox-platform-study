import { Inject, Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { OnEvent } from '@nestjs/event-emitter';
import { ClsService } from 'nestjs-cls';
import { CronJob } from 'cron';
import { ConsultationRepository } from '@arcaai/domains';
import { createWorkerSession } from '../../../common';
import { IActiveUserContext } from '../../../interfaces';
import { IAppSettingsService } from '../../baseServices/_meta/appSettings/IAppSettingsService';
import { EffectiveSettingsService } from '../../settings-registry/effective-settings.service';
import { IConsultationLifecycleService, IConsultationLifecycleServiceToken } from '../lifecycle/IConsultationLifecycleService';
import { CONSULTATION_GATE_DEFAULTS, CONSULTATION_RECORDING_STALE_MINUTES_KEY, CONSULTATION_SESSION_TIMEOUT_SWEEP_CRON_KEY } from '../consultation-gates.constants';
import { CONSULTATION_APPOINTMENT_DAY_TIME_ZONE_DEFAULT, CONSULTATION_APPOINTMENT_DAY_TIME_ZONE_KEY, isValidTimeZone } from '../../settings-registry/descriptors/consultation-appointment-day.descriptors';
import {
  CONSULTATION_AUTO_CLOSE_KEY,
  CONSULTATION_AUTO_CLOSE_MIN_IDLE_MINUTES,
  ConsultationAutoClosePolicy,
  resolveAutoClosePolicy,
} from '../../settings-registry/descriptors/consultation-lifecycle.descriptors';

const JOB_NAME = 'consultation-timeout-sweep';
const MS_PER_MINUTE = 60_000;
/** Rows one run closes (or pauses) at most; the rest wait for the next tick. */
export const CONSULTATION_SWEEP_BATCH_LIMIT = 200;

/**
 * The live-summary lock key format `LiveDocumentationService` writes. Kept for the one-off dev
 * cleanup script, which still reports whether a lock protects a row.
 */
export function liveSummaryLockKey(consultationId: string): string {
  return `consultation:live-summary:${consultationId}:lock`;
}

export interface ConsultationTimeoutSweepConfig {
  cron: string;
  /** Minutes without activity before a RECORDING consultation is auto-paused. */
  recordingStaleMinutes: number;
}

export interface ConsultationAutoCloseResult {
  eligible: number;
  closed: number;
  failed: number;
}

export interface ConsultationStaleRecordingResult {
  eligible: number;
  paused: number;
  failed: number;
}

/**
 * The offset of `timeZone` from UTC at `instant`, in milliseconds (positive east of Greenwich).
 */
function zoneOffsetMs(instant: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(instant));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return asUtc - Math.floor(instant / 1000) * 1000;
}

/**
 * The UTC instant at which the wall clock of `timeZone` reads `HH:mm` on the calendar day that
 * `now` falls on in that zone.
 */
export function todayAtInZone(now: Date, hhmm: string, timeZone: string): Date {
  const [hour, minute] = hhmm.split(':').map(Number);
  const day = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  const [year, month, date] = day.split('-').map(Number);
  const wallAsUtc = Date.UTC(year, month - 1, date, hour, minute);
  // The offset depends on the instant being resolved, so converge once across a DST change.
  let instant = wallAsUtc - zoneOffsetMs(wallAsUtc, timeZone);
  instant = wallAsUtc - zoneOffsetMs(instant, timeZone);
  return new Date(instant);
}

/**
 * The consultation sweep, run on the `consultation.state.sessionTimeoutSweep.cron` cadence. Two legs:
 *
 * 1. {@link sweepStaleRecordings} - a RECORDING consultation with no activity for
 *    `consultation.state.recordingStaleMinutes` is auto-paused (never stopped or closed).
 * 2. {@link sweepAutoClose} - every non-closed consultation past its tenant's
 *    `consultation.autoClose` policy is closed through the lifecycle service's auto close, which
 *    decides the outcome itself (approved -> complete, anything else -> incomplete).
 *
 * Self-scheduling like the other retention workers: the cron job re-syncs whenever the settings
 * cache refreshes, so the cadence is tunable live. Deliberately without an `enabled` switch: it
 * performs the same transitions a clinician can trigger by hand.
 *
 * Both queries run cross-tenant with no CLS scope (a platform-wide tick); each row's write binds
 * its own tenant first, so the lifecycle service attributes it correctly.
 */
@Injectable()
export class ConsultationTimeoutSweepService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ConsultationTimeoutSweepService.name);
  private activeCron: string | null = null;

  constructor(
    private readonly consultationRepository: ConsultationRepository,
    private readonly clsService: ClsService<IActiveUserContext>,
    @Inject(IAppSettingsService) private readonly appSettingsService: IAppSettingsService,
    private readonly schedulerRegistry: SchedulerRegistry,
    @Inject(IConsultationLifecycleServiceToken) private readonly lifecycle: IConsultationLifecycleService,
    @Inject(EffectiveSettingsService) private readonly effectiveSettings: EffectiveSettingsService,
  ) {}

  onModuleInit(): void {
    this.syncSchedulerFromConfig();
  }

  onModuleDestroy(): void {
    this.stopJob();
  }

  /** Reacts to `AppSettingsService` cache refreshes (every ~45s). */
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
      recordingStaleMinutes: this.appSettingsService.getValueWithDefault<number>(
        CONSULTATION_RECORDING_STALE_MINUTES_KEY,
        CONSULTATION_GATE_DEFAULTS[CONSULTATION_RECORDING_STALE_MINUTES_KEY],
      ),
    };
  }

  /** Ensures the running cron job matches the live config. */
  syncSchedulerFromConfig(): void {
    const { cron } = this.getConfig();
    if (cron === this.activeCron) return;
    this.replaceJob(cron);
  }

  /**
   * One tick. The pause leg runs first and each leg has its own try/catch, so one failing never
   * blocks the other.
   */
  async handleScheduledSweep(): Promise<void> {
    this.logger.log('Starting scheduled consultation sweep');

    try {
      const paused = await this.sweepStaleRecordings();
      this.logger.log({ message: 'Stale-recording sweep completed', ...paused });
    } catch (error) {
      this.logger.error(`Stale-recording sweep failed: ${error}`);
    }

    try {
      const closed = await this.sweepAutoClose();
      this.logger.log({ message: 'Auto-close sweep completed', ...closed });
    } catch (error) {
      this.logger.error(`Auto-close sweep failed: ${error}`);
    }
  }

  /**
   * Auto-pauses RECORDING consultations with no activity for the stale window. A single row's
   * failure (an illegal-transition race) is logged and skipped. `overrides.recordingStaleMinutes`
   * applies to this call only (the dev cleanup script uses it); a window below one minute is refused.
   */
  async sweepStaleRecordings(overrides?: { recordingStaleMinutes?: number }): Promise<ConsultationStaleRecordingResult> {
    const staleMinutes = overrides?.recordingStaleMinutes ?? this.getConfig().recordingStaleMinutes;
    if (staleMinutes < 1) {
      this.logger.warn({ message: 'Recording stale window is non-positive - refusing to sweep', staleMinutes });
      return { eligible: 0, paused: 0, failed: 0 };
    }

    const stale = (await this.consultationRepository.findStaleRecording(new Date(Date.now() - staleMinutes * MS_PER_MINUTE))).slice(
      0,
      CONSULTATION_SWEEP_BATCH_LIMIT,
    );

    let paused = 0;
    let failed = 0;
    for (const consultation of stale) {
      try {
        await this.inTenant(consultation.tenantId, () => this.lifecycle.pause(consultation.id, { reason: 'stale_recording' }));
        paused++;
      } catch (error) {
        failed++;
        this.logSkipped('auto-pause', consultation.id, consultation.tenantId, error);
      }
    }
    return { eligible: stale.length, paused, failed };
  }

  /**
   * Closes every non-closed consultation that is past its tenant's auto-close policy, at most
   * {@link CONSULTATION_SWEEP_BATCH_LIMIT} per run (oldest first).
   *
   * The repository is asked for rows idle past the loosest window any policy can have; each
   * tenant's own policy then decides in memory. `overrides.idleMinutes` replaces every tenant's
   * policy with an idle window for this call only (the dev cleanup script uses it).
   */
  async sweepAutoClose(overrides?: { idleMinutes?: number }): Promise<ConsultationAutoCloseResult> {
    if (overrides?.idleMinutes !== undefined && overrides.idleMinutes < 1) {
      this.logger.warn({ message: 'Auto-close idle override is non-positive - refusing to sweep', idleMinutes: overrides.idleMinutes });
      return { eligible: 0, closed: 0, failed: 0 };
    }

    const now = new Date();
    const floorMinutes = Math.min(overrides?.idleMinutes ?? CONSULTATION_AUTO_CLOSE_MIN_IDLE_MINUTES, CONSULTATION_AUTO_CLOSE_MIN_IDLE_MINUTES);
    const candidates = await this.consultationRepository.findAutoCloseEligible(new Date(now.getTime() - floorMinutes * MS_PER_MINUTE), {
      limit: CONSULTATION_SWEEP_BATCH_LIMIT,
    });

    const cutoffByTenant = new Map<string, Date | null>();
    const eligible = [];
    for (const consultation of candidates.slice(0, CONSULTATION_SWEEP_BATCH_LIMIT)) {
      let cutoff = cutoffByTenant.get(consultation.tenantId);
      if (cutoff === undefined) {
        cutoff = overrides?.idleMinutes !== undefined ? new Date(now.getTime() - overrides.idleMinutes * MS_PER_MINUTE) : await this.resolveCutoff(consultation.tenantId, now);
        cutoffByTenant.set(consultation.tenantId, cutoff);
      }
      if (cutoff !== null && consultation.lastActivityAt < cutoff) eligible.push(consultation);
    }

    let closed = 0;
    let failed = 0;
    for (const consultation of eligible) {
      try {
        await this.inTenant(consultation.tenantId, () => this.lifecycle.close(consultation.id, { auto: true }));
        closed++;
      } catch (error) {
        failed++;
        this.logSkipped('auto-close', consultation.id, consultation.tenantId, error);
      }
    }
    return { eligible: eligible.length, closed, failed };
  }

  /**
   * The `lastActivityAt` before which a tenant's consultations are closed now, or `null` when
   * nothing is due yet (daily mode before today's `dailyAt`). A settings outage serves the
   * platform default policy (`open-to-default`).
   */
  private async resolveCutoff(tenantId: string, now: Date): Promise<Date | null> {
    const policy = await this.resolvePolicy(tenantId);
    if (policy.mode === 'idle') return new Date(now.getTime() - policy.idleMinutes * MS_PER_MINUTE);

    const zone = await this.resolveTimeZone(tenantId);
    const dueAt = todayAtInZone(now, policy.dailyAt as string, zone);
    return dueAt.getTime() <= now.getTime() ? dueAt : null;
  }

  private async resolvePolicy(tenantId: string): Promise<ConsultationAutoClosePolicy> {
    try {
      const { value } = await this.effectiveSettings.resolveEffective(CONSULTATION_AUTO_CLOSE_KEY, { tenantId });
      return resolveAutoClosePolicy(value);
    } catch (error) {
      this.logger.warn({ message: 'consultation.autoClose lookup failed - using the platform default', tenantId, error: error instanceof Error ? error.message : String(error) });
      return resolveAutoClosePolicy(undefined);
    }
  }

  private async resolveTimeZone(tenantId: string): Promise<string> {
    try {
      const { value } = await this.effectiveSettings.resolveEffective(CONSULTATION_APPOINTMENT_DAY_TIME_ZONE_KEY, { tenantId });
      return isValidTimeZone(value) ? value : CONSULTATION_APPOINTMENT_DAY_TIME_ZONE_DEFAULT;
    } catch {
      return CONSULTATION_APPOINTMENT_DAY_TIME_ZONE_DEFAULT;
    }
  }

  /** Runs `work` with the row's own tenant bound, as the lifecycle service reads tenancy from CLS. */
  private async inTenant(tenantId: string, work: () => Promise<unknown>): Promise<void> {
    await this.clsService.run(async () => {
      this.clsService.set('tenantId', tenantId);
      this.clsService.set('user', createWorkerSession({ tenantId, kind: 'session-timeout-sweep' }));
      await work();
    });
  }

  private logSkipped(action: string, consultationId: string, tenantId: string, error: unknown): void {
    this.logger.warn({
      message: `Consultation sweep: ${action} failed (non-fatal - the sweep continues with the next row)`,
      consultationId,
      tenantId,
      error: error instanceof Error ? error.message : String(error),
    });
  }

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

      this.logger.log({ message: 'Consultation sweep cron job scheduled', cron });
    } catch (error) {
      this.activeCron = null;
      this.logger.error({
        message: 'Failed to schedule consultation sweep cron job',
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
      // Job doesn't exist - nothing to stop
    }
    this.activeCron = null;
  }
}
