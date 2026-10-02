/**
 * TASK-1034 R1 — the weekly, feedback-gated DNA regeneration.
 *
 * A clinician is regenerated when at least `dna-regen.min-new-samples` UNCONSUMED memory samples
 * arrived since their latest report (or in the last 7 days when they have none). Every skip is
 * decided BEFORE anything is queued and counted by reason; one job per clinician per ISO week.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { JobQueue } from '@arcaai/domains';
import { DnaRegenerationScheduler, isoWeekKey } from '../dna-regeneration.scheduler';

const TENANT = 'tenant-1';
const NOW = new Date('2026-10-05T02:00:00.000Z'); // Monday
const REPORT_AT = new Date('2026-09-28T02:00:00.000Z');

vi.mock('cron', async () => {
  const actual = await vi.importActual<typeof import('cron')>('cron');
  return {
    ...actual,
    CronJob: class {
      start = vi.fn();
      stop = vi.fn();
      constructor(public cronTime: string) {}
    },
  };
});

function setup(options: { settings?: Record<string, unknown>; spendable?: boolean } = {}) {
  const settings: Record<string, unknown> = {
    'dna-regen.enabled': true,
    'dna-regen.cron': '0 2 * * 1',
    'dna-regen.min-new-samples': 3,
    'dna-regen.job-delay-ms': 0,
    'consultation.appointmentDay.timeZone': 'UTC',
    ...options.settings,
  };
  const tenantSettings = { resolve: vi.fn((key: string) => ({ key, value: settings[key], source: 'tenant' })) };
  const appSettings = { getValueWithDefault: vi.fn(<T>(_k: string, d: T) => d) };
  const registry = {
    addCronJob: vi.fn(),
    getCronJob: vi.fn(() => {
      throw new Error('none');
    }),
    deleteCronJob: vi.fn(),
  };
  // doctor-noFeedback and doctor-below and doctor-ok and doctor-optout have reports; doctor-new has none.
  const reportRepo = {
    findAll: vi.fn().mockResolvedValue(
      ['doctor-nofeedback', 'doctor-below', 'doctor-ok', 'doctor-optout'].map((doctorId, i) => ({
        id: `r-${i}`,
        tenantId: TENANT,
        doctorId,
        createdAt: REPORT_AT,
      })),
    ),
  };
  const counts: Record<string, number> = { 'doctor-nofeedback': 0, 'doctor-below': 2, 'doctor-ok': 3, 'doctor-optout': 5, 'doctor-new': 4 };
  const sampleRepo = {
    findDoctorIdsWithUnconsumedSince: vi.fn().mockResolvedValue(['doctor-below', 'doctor-ok', 'doctor-optout', 'doctor-new']),
    countUnconsumedSince: vi.fn(async (_t: string, doctorId: string) => counts[doctorId] ?? 0),
  };
  const configResolver = {
    resolveEffectiveDnaStyleEnabled: vi.fn(async ({ doctorId }: { doctorId: string }) => ({ effective: doctorId !== 'doctor-optout' })),
  };
  const queued = new Map<string, unknown>();
  const queue = {
    add: vi.fn(async (_name: string, data: unknown, opts: { jobId: string }) => {
      queued.set(opts.jobId, data);
      return { id: opts.jobId };
    }),
    getJob: vi.fn(async (id: string) => (queued.has(id) ? { id } : null)),
  };
  const entitlements = {
    assertMeterQuota: vi.fn(async () => {
      if (options.spendable === false) throw new Error('quota exceeded');
    }),
  };
  const redisStore = new Map<string, string>();
  const redis = {
    get: vi.fn(async (k: string) => redisStore.get(k) ?? null),
    set: vi.fn(async (k: string, v: string) => void redisStore.set(k, v)),
  };
  const tenantRepo = { findAll: vi.fn().mockResolvedValue([{ id: TENANT }]) };

  const scheduler = new DnaRegenerationScheduler(
    appSettings as never,
    registry as never,
    reportRepo as never,
    queue as never,
    entitlements as never,
    undefined,
    sampleRepo as never,
    configResolver as never,
    tenantSettings as never,
    tenantRepo as never,
    redis as never,
  );
  return { scheduler, queue, sampleRepo, configResolver, redis, settings, reportRepo, tenantSettings };
}

beforeEach(() => vi.clearAllMocks());

describe('DnaRegenerationScheduler.runForTenant', () => {
  it('skips 0-feedback, below-floor and opted-out doctors; queues ≥ floor and never-reported doctors', async () => {
    const { scheduler, queue, sampleRepo, configResolver } = setup();

    const result = await scheduler.runForTenant(TENANT, NOW);

    expect(result.skipped).toEqual({ noFeedback: 1, belowFloor: 1, optedOut: 1, quota: 0 });
    expect(result.queued).toBe(2);
    expect(result.jobs.map((j) => j.doctorId).sort()).toEqual(['doctor-new', 'doctor-ok']);
    // Since their latest report — or the last 7 days for a never-reported clinician.
    expect(sampleRepo.countUnconsumedSince).toHaveBeenCalledWith(TENANT, 'doctor-ok', REPORT_AT);
    expect(sampleRepo.countUnconsumedSince).toHaveBeenCalledWith(TENANT, 'doctor-new', new Date(NOW.getTime() - 7 * 86_400_000));
    // The opt-out is checked BEFORE queuing, and never for a doctor already skipped on feedback.
    expect(configResolver.resolveEffectiveDnaStyleEnabled).not.toHaveBeenCalledWith(expect.objectContaining({ doctorId: 'doctor-nofeedback' }));
    expect(queue.add).toHaveBeenCalledTimes(2);
    const [name, payload, opts] = queue.add.mock.calls[0]!;
    expect(name).toBe(JobQueue.GenerateDnaReport);
    expect(payload).toMatchObject({ tenantId: TENANT, origin: 'scheduler', userId: 'system-scheduler' });
    expect((payload as { idempotencyKey: string }).idempotencyKey).toMatch(/^dna-regen:tenant-1:doctor-(ok|new):2026-W41$/);
    expect(opts.jobId).not.toContain(':');
  });

  it('a tenant over its allowance queues nothing and counts the quota skips', async () => {
    const { scheduler, queue } = setup({ spendable: false });
    const result = await scheduler.runForTenant(TENANT, NOW);
    expect(queue.add).not.toHaveBeenCalled();
    expect(result.skipped.quota).toBe(2);
    expect(result.queued).toBe(0);
  });

  it('one job per clinician per ISO week — a second run (a restart) queues nothing new', async () => {
    const { scheduler, queue } = setup();
    await scheduler.runForTenant(TENANT, NOW);
    const second = await scheduler.runForTenant(TENANT, new Date(NOW.getTime() + 3_600_000));
    expect(queue.add).toHaveBeenCalledTimes(2);
    expect(second.queued).toBe(0);
  });

  it('honours the tenant floor', async () => {
    const { scheduler } = setup({ settings: { 'dna-regen.min-new-samples': 5 } });
    const result = await scheduler.runForTenant(TENANT, NOW);
    expect(result.jobs.map((j) => j.doctorId)).toEqual([]);
    expect(result.skipped).toMatchObject({ belowFloor: 3, optedOut: 1 });
  });

  it('records the last run per tenant', async () => {
    const { scheduler } = setup();
    await scheduler.runForTenant(TENANT, NOW);
    const last = await scheduler.getLastRun(TENANT);
    expect(last).toMatchObject({ at: NOW.toISOString(), queued: 2, skipped: { noFeedback: 1, belowFloor: 1, optedOut: 1, quota: 0 } });
  });
});

describe('DnaRegenerationScheduler.tick — per-tenant cron in the tenant time zone', () => {
  it('runs a tenant only when its own cron fires in its own zone', async () => {
    const { scheduler } = setup({ settings: { 'consultation.appointmentDay.timeZone': 'Asia/Kolkata' } });
    const run = vi.spyOn(scheduler, 'runForTenant');
    // Monday 02:00 IST = Sunday 20:30 UTC.
    await scheduler.tick(new Date('2026-10-04T20:29:00Z'), new Date('2026-10-04T20:28:00Z'));
    expect(run).not.toHaveBeenCalled();
    await scheduler.tick(new Date('2026-10-04T20:30:00Z'), new Date('2026-10-04T20:29:00Z'));
    expect(run).toHaveBeenCalledWith(TENANT, new Date('2026-10-04T20:30:00Z'));
  });

  it('a tenant that disabled the job is never run', async () => {
    const { scheduler } = setup({ settings: { 'dna-regen.enabled': false } });
    const run = vi.spyOn(scheduler, 'runForTenant');
    await scheduler.tick(new Date('2026-10-05T02:00:00Z'), new Date('2026-10-05T01:59:00Z'));
    expect(run).not.toHaveBeenCalled();
  });
});

describe('isoWeekKey', () => {
  it('reads the week in the tenant zone', () => {
    expect(isoWeekKey(new Date('2026-10-04T20:30:00Z'), 'UTC')).toBe('2026-W40');
    expect(isoWeekKey(new Date('2026-10-04T20:30:00Z'), 'Asia/Kolkata')).toBe('2026-W41');
    expect(isoWeekKey(new Date('2027-01-01T00:00:00Z'), 'UTC')).toBe('2026-W53');
  });
});
