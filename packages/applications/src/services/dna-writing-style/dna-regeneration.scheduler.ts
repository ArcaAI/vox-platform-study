import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { CronJob, CronTime } from 'cron';
import {
  DnaWritingSampleRepository,
  DnaWritingStyleReportRepository,
  JobQueue,
  ResourceStatusType,
  SYSTEM_TENANT_ID,
  TenantRepository,
} from '@arcaai/domains';
import { IAppSettingsService } from '../baseServices/_meta/appSettings/IAppSettingsService';
import { IRedisCacheService } from '../baseServices/redis/redis-cache.service';
import { IEntitlementsService } from '../entitlements/IEntitlementsService';
import { IBillingService } from '../billing/IBillingService';
import { ConfigResolver } from '../config-resolver';
import { TenantSettingsService } from '../settings-registry/tenant-settings.service';
import { DNA_REGEN_DEFAULTS, DNA_REGEN_KEYS, isValidCron } from '../settings-registry/descriptors/dna-regeneration.descriptors';
import {
  CONSULTATION_APPOINTMENT_DAY_TIME_ZONE_DEFAULT,
  CONSULTATION_APPOINTMENT_DAY_TIME_ZONE_KEY,
  isValidTimeZone,
} from '../settings-registry/descriptors/consultation-appointment-day.descriptors';
import type { GenerateDnaReportJobPayload } from './dna-writing-style.service';

/** The registered ticker. Kept as `dna-regeneration` so the scheduler admin can pause/resume it. */
const JOB_NAME = 'dna-regeneration';
/** Every minute: each tenant's own cron is evaluated, in its own zone, on each tick. */
const TICK_CRON = '* * * * *';
const DAY_MS = 86_400_000;
/** Feedback window for a clinician who has never had a report (§4b). */
const NO_REPORT_WINDOW_MS = 7 * DAY_MS;
const LAST_RUN_TTL_SECONDS = 90 * 24 * 3600;
const TENANT_LIST_TTL_MS = 10 * 60_000;

export interface DnaRegenerationConfig {
  enabled: boolean;
  cron: string;
  minNewSamples: number;
  jobDelayMs: number;
  timeZone: string;
}

export interface DnaRegenerationSkipCounts {
  noFeedback: number;
  optedOut: number;
  quota: number;
  belowFloor: number;
}

export interface DnaRegenerationRunResult {
  tenantId: string;
  /** ISO time the run evaluated at. */
  at: string;
  queued: number;
  skipped: DnaRegenerationSkipCounts;
  jobs: Array<{ doctorId: string; jobId: string }>;
  errors: string[];
}

/** The persisted last-run record (no doctor ids — a summary for the schedule screen). */
export interface DnaRegenerationLastRun {
  at: string;
  queued: number;
  skipped: DnaRegenerationSkipCounts;
}

/**
 * ISO-8601 week of `at` as read in `timeZone`, e.g. `2026-W41`. The tenant's week, so a Monday
 * 02:00 IST run and the 01:00 UTC restart of the same Monday are the same week.
 */
export function isoWeekKey(at: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(at);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const date = new Date(Date.UTC(get('year'), get('month') - 1, get('day')));
  const dayOfWeek = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dayOfWeek); // the Thursday of this ISO week
  const weekYear = date.getUTCFullYear();
  const week = Math.ceil(((date.getTime() - Date.UTC(weekYear, 0, 1)) / DAY_MS + 1) / 7);
  return `${weekYear}-W${String(week).padStart(2, '0')}`;
}

/**
 * TASK-1034 R1 — weekly, FEEDBACK-GATED DNA writing-style regeneration.
 *
 * ## What changed from the monthly sweep
 *
 * The old sweep queued EVERY doctor with a report, once a month, behind a platform-wide flag that
 * was off. Now:
 *  · each tenant's own `dna-regen.enabled` / `dna-regen.cron` (tenant → SYSTEM → code default),
 *    evaluated in that tenant's `consultation.appointmentDay.timeZone`, decides WHEN;
 *  · FEEDBACK decides WHO — unconsumed DNA memory samples (edits, sign-offs, ingested history)
 *    created since the clinician's latest report, or in the last 7 days when they have none
 *    (which is how a never-reported clinician is picked up at all); at least
 *    `dna-regen.min-new-samples` of them;
 *  · every skip is decided BEFORE anything is queued and counted by reason
 *    (noFeedback / belowFloor / optedOut / quota);
 *  · one job per clinician per ISO week: the logical key is `dna-regen:<tenant>:<doctor>:<isoWeek>`
 *    (stamped on the payload); BullMQ refuses a custom job id with more than two `:`, so the queue
 *    id is the same key with `_` separators. A restarted scheduler — or a second replica —
 *    finds the job and queues nothing.
 *
 * ## Where the last run is kept
 *
 * Redis, `dna-regen:last-run:<tenantId>` (JSON, 90-day TTL). It is an operational read-out for the
 * schedule screen, not configuration and not an audit record, so it does not belong in
 * `GlobalSetting`; absent Redis ⇒ `null`.
 */
@Injectable()
export class DnaRegenerationScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DnaRegenerationScheduler.name);
  private lastTickAt: Date = new Date();
  private tenantCache: { ids: string[]; at: number } | null = null;

  constructor(
    @Inject(IAppSettingsService) private readonly appSettingsService: IAppSettingsService,
    private readonly schedulerRegistry: SchedulerRegistry,
    private readonly dnaReportRepository: DnaWritingStyleReportRepository,
    @InjectQueue(JobQueue.GenerateDnaReport) private readonly dnaQueue: Queue,
    // TASK-974 §9.2 — a rebuild nobody asked for must not spend an allowance a tenant needs.
    @Optional() @Inject(IEntitlementsService) private readonly entitlements?: IEntitlementsService,
    @Optional() @Inject(IBillingService) private readonly billing?: IBillingService,
    // TASK-1034 — the feedback signal, the opt-out gate, the tenant cascade, the tenant list and
    // the last-run store. Optional + trailing; an unwired sample repository means "no feedback".
    @Optional() @Inject(DnaWritingSampleRepository) private readonly sampleRepository?: DnaWritingSampleRepository,
    @Optional() @Inject(ConfigResolver) private readonly configResolver?: ConfigResolver,
    @Optional() @Inject(TenantSettingsService) private readonly tenantSettings?: TenantSettingsService,
    @Optional() @Inject(TenantRepository) private readonly tenantRepository?: TenantRepository,
    @Optional() @Inject(IRedisCacheService) private readonly redis?: IRedisCacheService,
  ) {}

  onModuleInit(): void {
    this.lastTickAt = new Date();
    this.startTicker();
  }

  onModuleDestroy(): void {
    this.stopTicker();
  }

  // ── Configuration ──────────────────────────────────────────────

  /** The effective schedule for `tenantId` (tenant → SYSTEM → code default). */
  getConfig(tenantId: string | null = null): DnaRegenerationConfig {
    const read = <T>(key: string, fallback: T): T => {
      if (this.tenantSettings) {
        const value = this.tenantSettings.resolve<T>(key, tenantId).value;
        return value === undefined || value === null ? fallback : value;
      }
      return this.appSettingsService.getValueWithDefault<T>(key, fallback);
    };
    const cron = read<string>(DNA_REGEN_KEYS.cron, DNA_REGEN_DEFAULTS.cron);
    const minNewSamples = Number(read<number>(DNA_REGEN_KEYS.minNewSamples, DNA_REGEN_DEFAULTS.minNewSamples));
    const timeZone = read<string>(CONSULTATION_APPOINTMENT_DAY_TIME_ZONE_KEY, CONSULTATION_APPOINTMENT_DAY_TIME_ZONE_DEFAULT);
    return {
      enabled: read<boolean>(DNA_REGEN_KEYS.enabled, DNA_REGEN_DEFAULTS.enabled) === true,
      cron: isValidCron(cron) ? cron : DNA_REGEN_DEFAULTS.cron,
      minNewSamples: Number.isInteger(minNewSamples) && minNewSamples >= 1 ? minNewSamples : DNA_REGEN_DEFAULTS.minNewSamples,
      jobDelayMs: Math.max(0, Number(read<number>(DNA_REGEN_KEYS.jobDelayMs, DNA_REGEN_DEFAULTS.jobDelayMs)) || 0),
      timeZone: isValidTimeZone(timeZone) ? timeZone : CONSULTATION_APPOINTMENT_DAY_TIME_ZONE_DEFAULT,
    };
  }

  /** Next fire time of the tenant's schedule, or `null` when it is disabled. */
  nextRunAt(tenantId: string, now: Date = new Date()): Date | null {
    const config = this.getConfig(tenantId);
    if (!config.enabled) return null;
    return new CronTime(config.cron, config.timeZone).getNextDateFrom(now, config.timeZone).toJSDate();
  }

  // ── Ticking ────────────────────────────────────────────────────

  /**
   * Evaluate every tenant whose schedule fired in `(from, now]`. A tenant's failure is logged and
   * never stops another tenant's run.
   */
  async tick(now: Date = new Date(), from: Date = this.lastTickAt): Promise<void> {
    this.lastTickAt = now;
    let tenantIds: string[];
    try {
      tenantIds = await this.listTenantIds();
    } catch (error) {
      this.logger.error(`DNA regeneration tick could not list tenants: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    for (const tenantId of tenantIds) {
      try {
        const config = this.getConfig(tenantId);
        if (!config.enabled) continue;
        const next = new CronTime(config.cron, config.timeZone).getNextDateFrom(from, config.timeZone).toJSDate();
        if (next.getTime() > now.getTime()) continue;
        const result = await this.runForTenant(tenantId, now);
        this.logger.log({
          message: 'DNA regeneration run completed',
          tenantId,
          queued: result.queued,
          skipped: result.skipped,
          errors: result.errors.length,
        });
      } catch (error) {
        this.logger.error(`DNA regeneration failed for tenant ${tenantId}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  // ── One tenant's run ───────────────────────────────────────────

  /** Evaluate and queue one tenant now (the weekly tick, or the admin "Run now"). */
  async runForTenant(tenantId: string, now: Date = new Date()): Promise<DnaRegenerationRunResult> {
    const config = this.getConfig(tenantId);
    const result: DnaRegenerationRunResult = {
      tenantId,
      at: now.toISOString(),
      queued: 0,
      skipped: { noFeedback: 0, optedOut: 0, quota: 0, belowFloor: 0 },
      jobs: [],
      errors: [],
    };

    // Latest report per doctor in THIS tenant (explicit tenant: the tick has no request CLS).
    const reports = await this.dnaReportRepository.findAll({
      filters: { tenantId, isLatest: true, resourceStatus: ResourceStatusType.ENABLED },
    } as never);
    const latestAt = new Map<string, Date>();
    for (const report of reports ?? []) {
      if (!report?.doctorId) continue;
      const at = report.createdAt ? new Date(report.createdAt) : new Date(0);
      const seen = latestAt.get(report.doctorId);
      if (!seen || at > seen) latestAt.set(report.doctorId, at);
    }
    const withSamples = this.sampleRepository ? await this.sampleRepository.findDoctorIdsWithUnconsumedSince(tenantId, new Date(0)) : [];
    const doctorIds = [...new Set([...latestAt.keys(), ...withSamples])].sort();

    const isoWeek = isoWeekKey(now, config.timeZone);
    let spendable: boolean | null = null;
    let index = 0;

    for (const doctorId of doctorIds) {
      try {
        const since = latestAt.get(doctorId) ?? new Date(now.getTime() - NO_REPORT_WINDOW_MS);
        const fresh = this.sampleRepository ? await this.sampleRepository.countUnconsumedSince(tenantId, doctorId, since) : 0;
        if (fresh === 0) {
          result.skipped.noFeedback++;
          continue;
        }
        if (fresh < config.minNewSamples) {
          result.skipped.belowFloor++;
          continue;
        }
        // DNA fails closed: no resolver ⇒ the opt-in cannot be read ⇒ do not learn.
        const gate = this.configResolver ? await this.configResolver.resolveEffectiveDnaStyleEnabled({ tenantId, doctorId }) : null;
        if (!gate?.effective) {
          result.skipped.optedOut++;
          continue;
        }
        if (spendable === null) spendable = await this.tenantMaySpend(tenantId, result);
        if (!spendable) {
          result.skipped.quota++;
          continue;
        }

        const idempotencyKey = `dna-regen:${tenantId}:${doctorId}:${isoWeek}`;
        const jobId = idempotencyKey.replace(/:/g, '_');
        if (await this.dnaQueue.getJob(jobId)) continue; // already queued this week

        const payload: GenerateDnaReportJobPayload & { isRegeneration: boolean } = {
          jobId,
          doctorId,
          tenantId,
          userId: 'system-scheduler',
          isRegeneration: true,
          origin: 'scheduler',
          idempotencyKey,
        };
        await this.dnaQueue.add(JobQueue.GenerateDnaReport, payload, { jobId, delay: index * config.jobDelayMs });
        result.jobs.push({ doctorId, jobId });
        result.queued++;
        index++;
      } catch (error) {
        const msg = `Failed to evaluate DNA regeneration for doctor ${doctorId}: ${error instanceof Error ? error.message : String(error)}`;
        this.logger.warn(msg);
        result.errors.push(msg);
      }
    }

    await this.recordLastRun(result);
    return result;
  }

  async getLastRun(tenantId: string): Promise<DnaRegenerationLastRun | null> {
    if (!this.redis) return null;
    try {
      const raw = await this.redis.get(DnaRegenerationScheduler.lastRunKey(tenantId));
      return raw ? (JSON.parse(raw) as DnaRegenerationLastRun) : null;
    } catch (error) {
      this.logger.warn(`Could not read the DNA regeneration last run for ${tenantId}: ${error}`);
      return null;
    }
  }

  // ── Private helpers ────────────────────────────────────────────

  private static lastRunKey(tenantId: string): string {
    return `dna-regen:last-run:${tenantId}`;
  }

  private async recordLastRun(result: DnaRegenerationRunResult): Promise<void> {
    if (!this.redis) return;
    const record: DnaRegenerationLastRun = { at: result.at, queued: result.queued, skipped: result.skipped };
    try {
      await this.redis.set(DnaRegenerationScheduler.lastRunKey(result.tenantId), JSON.stringify(record), LAST_RUN_TTL_SECONDS);
    } catch (error) {
      this.logger.warn(`Could not record the DNA regeneration last run for ${result.tenantId}: ${error}`);
    }
  }

  /**
   * May this tenant afford its scheduled rebuilds? Asked once per run, and only when a doctor
   * actually qualifies. A refusal skips the tenant's queued work (counted as `quota`) and never
   * another tenant's.
   */
  private async tenantMaySpend(tenantId: string, result: DnaRegenerationRunResult): Promise<boolean> {
    try {
      await this.entitlements?.assertMeterQuota(tenantId, 'monthlyLlmTokens');
      await this.billing?.assertSpendLimit(tenantId);
      return true;
    } catch (error) {
      const msg = `Skipping DNA re-generation for tenant ${tenantId}: ${error instanceof Error ? error.message : String(error)}`;
      this.logger.warn(msg);
      result.errors.push(msg);
      return false;
    }
  }

  private async listTenantIds(): Promise<string[]> {
    if (!this.tenantRepository) return [];
    if (this.tenantCache && Date.now() - this.tenantCache.at < TENANT_LIST_TTL_MS) return this.tenantCache.ids;
    const tenants = await this.tenantRepository.findAll({ filters: { resourceStatus: ResourceStatusType.ENABLED } } as never);
    const ids = (tenants ?? []).map((t) => t.id).filter((id) => id && id !== SYSTEM_TENANT_ID);
    this.tenantCache = { ids, at: Date.now() };
    return ids;
  }

  private startTicker(): void {
    this.stopTicker();
    try {
      const job = new CronJob(TICK_CRON, async () => {
        await this.tick();
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- @nestjs/schedule and cron ship different CronJob typings
      this.schedulerRegistry.addCronJob(JOB_NAME, job as any);
      job.start();
    } catch (error) {
      this.logger.error(`Failed to start the DNA regeneration ticker: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private stopTicker(): void {
    try {
      const existing = this.schedulerRegistry.getCronJob(JOB_NAME);
      if (existing) {
        existing.stop();
        this.schedulerRegistry.deleteCronJob(JOB_NAME);
      }
    } catch {
      // swallow-ok: getCronJob throws when the ticker was never registered — nothing to stop.
    }
  }
}
