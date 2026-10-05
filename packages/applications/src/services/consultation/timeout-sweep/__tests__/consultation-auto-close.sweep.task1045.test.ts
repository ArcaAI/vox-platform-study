/**
 * The consultation auto-close sweep and the lifecycle settings it reads.
 *
 * Idle mode closes a non-closed consultation idle past the tenant's window; daily mode closes
 * one last touched before today's `dailyAt` in the tenant's appointment-day time zone once that
 * time has passed. The sweep never decides the outcome (APPROVED -> CLOSED_COMPLETE, anything else
 * -> CLOSED_INCOMPLETE) - it calls the lifecycle service's auto close. A RECORDING row with no
 * activity for `recordingStaleMinutes` is auto-paused.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConsultationTimeoutSweepService } from '../consultation-timeout-sweep.service';
import {
  CONSULTATION_AUTO_CLOSE_DEFAULT,
  CONSULTATION_AUTO_CLOSE_KEY,
  CONSULTATION_LIFECYCLE_SETTINGS,
  CONSULTATION_REOPEN_ALLOW_CLOSED_COMPLETE_KEY,
  CONSULTATION_STOP_FINAL_TRANSCRIPT_TIMEOUT_KEY,
  resolveAutoClosePolicy,
} from '../../../settings-registry/descriptors/consultation-lifecycle.descriptors';
import { CONSULTATION_APPOINTMENT_DAY_TIME_ZONE_KEY } from '../../../settings-registry/descriptors/consultation-appointment-day.descriptors';
import { HOPE_SETTINGS_REGISTRY } from '../../../settings-registry/registry';
import { STT_RUNTIME_SETTINGS } from '../../../settings-registry/descriptors/stt-runtime.descriptors';

vi.mock('cron', () => ({
  CronJob: class {
    start = vi.fn();
    stop = vi.fn();
  },
}));

const NOW = new Date('2026-10-05T21:00:00Z'); // 02:30 on 10-06 in Asia/Kolkata

interface Row {
  id: string;
  tenantId: string;
  status: string;
  lastActivityAt: Date;
}
const row = (id: string, tenantId: string, minutesAgo: number, status = 'RECORDING_PAUSED'): Row => ({
  id,
  tenantId,
  status,
  lastActivityAt: new Date(NOW.getTime() - minutesAgo * 60_000),
});

function build(opts: { policies?: Record<string, unknown>; zones?: Record<string, string>; eligible?: Row[]; stale?: Row[] } = {}) {
  const repo = {
    findAutoCloseEligible: vi.fn().mockResolvedValue(opts.eligible ?? []),
    findStaleRecording: vi.fn().mockResolvedValue(opts.stale ?? []),
  };
  const bound: string[] = [];
  const cls = {
    run: vi.fn(async (fn: () => Promise<void>) => fn()),
    set: vi.fn((k: string, v: unknown) => {
      if (k === 'tenantId') bound.push(v as string);
    }),
  };
  const appSettings = { getValueWithDefault: vi.fn((_k: string, d: unknown) => d) };
  const lifecycle = { close: vi.fn().mockResolvedValue({}), pause: vi.fn().mockResolvedValue({}) };
  const effective = {
    resolveEffective: vi.fn(async (key: string, ctx: { tenantId: string }) => {
      if (key === CONSULTATION_AUTO_CLOSE_KEY) return { value: opts.policies?.[ctx.tenantId] ?? CONSULTATION_AUTO_CLOSE_DEFAULT };
      if (key === CONSULTATION_APPOINTMENT_DAY_TIME_ZONE_KEY) return { value: opts.zones?.[ctx.tenantId] ?? 'UTC' };
      throw new Error(`unexpected key ${key}`);
    }),
  };
  const svc = new ConsultationTimeoutSweepService(repo as never, cls as never, appSettings as never, { getCronJob: vi.fn(), addCronJob: vi.fn(), deleteCronJob: vi.fn() } as never, lifecycle as never, effective as never);
  return { svc, repo, lifecycle, bound };
}

describe('ConsultationTimeoutSweepService auto close', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => vi.useRealTimers());

  it('idle mode closes only rows idle past the tenant window, each under its own tenant, as an auto close', async () => {
    const { svc, lifecycle, bound } = build({
      policies: { t1: { mode: 'idle', idleMinutes: 60, dailyAt: null } },
      eligible: [row('old', 't1', 61), row('fresh', 't1', 30), row('default-old', 't2', 721), row('default-fresh', 't2', 700)],
    });

    const result = await svc.sweepAutoClose();

    expect(lifecycle.close.mock.calls).toEqual([
      ['old', { auto: true }],
      ['default-old', { auto: true }],
    ]);
    expect(bound).toEqual(['t1', 't2']);
    expect(result).toMatchObject({ eligible: 2, closed: 2, failed: 0 });
  });

  it('asks the repository for non-closed rows idle past the loosest window, capped at 200', async () => {
    const { svc, repo } = build();
    await svc.sweepAutoClose();
    expect(repo.findAutoCloseEligible).toHaveBeenCalledWith(new Date(NOW.getTime() - 15 * 60_000), { limit: 200 });
  });

  it('daily mode closes rows last touched before today\'s dailyAt in the tenant time zone, once it has passed', async () => {
    // 02:00 IST today = 2026-10-05T20:30Z. In UTC the same HH:mm would be 02:00Z and wrongly cover the 20:45Z row.
    const policy = { mode: 'daily', idleMinutes: 720, dailyAt: '02:00' };
    const { svc, lifecycle } = build({
      policies: { t1: policy },
      zones: { t1: 'Asia/Kolkata' },
      eligible: [row('before', 't1', 60), row('after', 't1', 15)],
    });

    await svc.sweepAutoClose();

    expect(lifecycle.close.mock.calls).toEqual([['before', { auto: true }]]);
  });

  it('daily mode closes nothing before today\'s dailyAt has passed', async () => {
    vi.setSystemTime(new Date('2026-10-05T20:00:00Z')); // 01:30 IST
    const { svc, lifecycle } = build({
      policies: { t1: { mode: 'daily', idleMinutes: 720, dailyAt: '02:00' } },
      zones: { t1: 'Asia/Kolkata' },
      eligible: [{ ...row('x', 't1', 600), lastActivityAt: new Date('2026-10-04T10:00:00Z') }],
    });

    await svc.sweepAutoClose();

    expect(lifecycle.close).not.toHaveBeenCalled();
  });

  it('leaves the outcome to the lifecycle service: an APPROVED row is closed through the same auto close call', async () => {
    const { svc, lifecycle } = build({ eligible: [row('approved', 't1', 800, 'APPROVED')] });
    await svc.sweepAutoClose();
    expect(lifecycle.close).toHaveBeenCalledWith('approved', { auto: true });
  });

  it('closes at most 200 rows per run and keeps going when one close fails', async () => {
    const eligible = Array.from({ length: 250 }, (_, i) => row(`r${i}`, 't1', 900));
    const { svc, lifecycle } = build({ eligible });
    lifecycle.close.mockRejectedValueOnce(new Error('race'));

    const result = await svc.sweepAutoClose();

    expect(lifecycle.close).toHaveBeenCalledTimes(200);
    expect(result).toMatchObject({ closed: 199, failed: 1 });
  });

  it('an unusable stored policy serves the platform default', async () => {
    const { svc, lifecycle } = build({ policies: { t1: { mode: 'weekly' } }, eligible: [row('a', 't1', 721), row('b', 't1', 100)] });
    await svc.sweepAutoClose();
    expect(lifecycle.close.mock.calls).toEqual([['a', { auto: true }]]);
  });

  it('an explicit idle override replaces every tenant policy for that call and refuses a non-positive window', async () => {
    const { svc, lifecycle } = build({ eligible: [row('a', 't1', 40)] });
    expect(await svc.sweepAutoClose({ idleMinutes: 0 })).toMatchObject({ eligible: 0, closed: 0 });
    await svc.sweepAutoClose({ idleMinutes: 30 });
    expect(lifecycle.close).toHaveBeenCalledWith('a', { auto: true });
  });
});

describe('ConsultationTimeoutSweepService stale recording', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => vi.useRealTimers());

  it('auto-pauses a RECORDING row idle past recordingStaleMinutes, under its own tenant', async () => {
    const { svc, repo, lifecycle, bound } = build({ stale: [row('rec', 't9', 45, 'RECORDING')] });

    const result = await svc.sweepStaleRecordings();

    expect(repo.findStaleRecording).toHaveBeenCalledWith(new Date(NOW.getTime() - 30 * 60_000));
    expect(lifecycle.pause).toHaveBeenCalledWith('rec', { reason: 'stale_recording' });
    expect(bound).toEqual(['t9']);
    expect(result).toMatchObject({ eligible: 1, paused: 1, failed: 0 });
  });

  it('counts a failed pause and continues', async () => {
    const { svc, lifecycle } = build({ stale: [row('a', 't1', 45, 'RECORDING'), row('b', 't1', 45, 'RECORDING')] });
    lifecycle.pause.mockRejectedValueOnce(new Error('race'));
    expect(await svc.sweepStaleRecordings()).toMatchObject({ paused: 1, failed: 1 });
  });
});

describe('consultation lifecycle descriptors', () => {
  const autoClose = CONSULTATION_LIFECYCLE_SETTINGS.find((d) => d.key === CONSULTATION_AUTO_CLOSE_KEY)!;

  it('registers the three keys with the planned tier, scope and defaults', () => {
    expect(autoClose).toMatchObject({ dataType: 'json', maxScope: 'tenant', failMode: 'open-to-default', default: { mode: 'idle', idleMinutes: 720, dailyAt: null } });
    expect(HOPE_SETTINGS_REGISTRY.get(CONSULTATION_REOPEN_ALLOW_CLOSED_COMPLETE_KEY)).toMatchObject({ dataType: 'boolean', maxScope: 'tenant', default: false });
    expect(HOPE_SETTINGS_REGISTRY.get(CONSULTATION_STOP_FINAL_TRANSCRIPT_TIMEOUT_KEY)).toMatchObject({ dataType: 'number', maxScope: 'system', default: 30 });
  });

  it.each([
    [{ mode: 'idle', idleMinutes: 720, dailyAt: null }, undefined],
    [{ mode: 'daily', idleMinutes: 720, dailyAt: '23:30' }, undefined],
    [{ mode: 'idle', idleMinutes: 14, dailyAt: null }, 'idleMinutes'],
    [{ mode: 'idle', idleMinutes: 10081, dailyAt: null }, 'idleMinutes'],
    [{ mode: 'idle', idleMinutes: 60.5, dailyAt: null }, 'idleMinutes'],
    [{ mode: 'weekly', idleMinutes: 60, dailyAt: null }, 'mode'],
    [{ mode: 'daily', idleMinutes: 60, dailyAt: null }, 'dailyAt'],
    [{ mode: 'daily', idleMinutes: 60, dailyAt: '25:00' }, 'dailyAt'],
    [{ mode: 'idle', idleMinutes: 60, dailyAt: '7:00' }, 'dailyAt'],
    ['idle', 'object'],
    [null, 'object'],
  ])('validates %j', (value, problem) => {
    const message = autoClose.validate!(value);
    if (problem === undefined) expect(message).toBeUndefined();
    else expect(message).toContain(problem);
  });

  it('bounds the stop timeout to 5-120 seconds', () => {
    const d = HOPE_SETTINGS_REGISTRY.get(CONSULTATION_STOP_FINAL_TRANSCRIPT_TIMEOUT_KEY)!;
    expect(d.validate!(5)).toBeUndefined();
    expect(d.validate!(120)).toBeUndefined();
    expect(d.validate!(4)).toBeDefined();
    expect(d.validate!(121)).toBeDefined();
    expect(d.validate!(30.5)).toBeDefined();
  });

  it('resolveAutoClosePolicy falls back to the default for anything unusable', () => {
    expect(resolveAutoClosePolicy({ mode: 'daily', idleMinutes: 90, dailyAt: '01:00' })).toEqual({ mode: 'daily', idleMinutes: 90, dailyAt: '01:00' });
    expect(resolveAutoClosePolicy({ mode: 'daily', idleMinutes: 90, dailyAt: null })).toEqual(CONSULTATION_AUTO_CLOSE_DEFAULT);
    expect(resolveAutoClosePolicy(undefined)).toEqual(CONSULTATION_AUTO_CLOSE_DEFAULT);
  });

  it('declares the capture pause limit beside the other streaming knobs', () => {
    expect(STT_RUNTIME_SETTINGS.find((d) => d.key === 'stt.streaming.pauseMaxSeconds')).toMatchObject({ dataType: 'number', default: 600, category: 'STT Streaming' });
  });

  it('keeps the retired keys registered but marked deprecated', () => {
    for (const key of [
      'consultation.state.sessionTimeoutMinutes',
      'consultation.state.reviewTimeoutMinutes',
      'consultation.state.openTimeoutMinutes',
      'consultation.state.requirePrimedBeforeRecording',
      'consultation.session.completionTimeoutMinutes',
    ]) {
      expect(HOPE_SETTINGS_REGISTRY.get(key)!.label).toMatch(/^\(Deprecated\)/);
    }
  });
});
