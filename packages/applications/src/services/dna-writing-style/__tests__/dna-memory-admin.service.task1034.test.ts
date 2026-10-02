/**
 * TASK-1034 — the tenant-admin DNA memory + schedule surface. Tenant-scoped; a foreign clinician
 * or a foreign sample is 404 (never 403); previews are PHI-redacted and at most 200 characters.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import { ResourceStatusType, SysEventType } from '@arcaai/domains';
import { DnaMemoryAdminService } from '../dna-memory-admin.service';

const TENANT = 'tenant-1';
const DOCTOR = 'doctor-1';

const sampleRepo = {
  findPaginated: vi.fn(),
  summarizeByDoctor: vi.fn(),
  findById: vi.fn(),
  softDelete: vi.fn(),
  decryptText: vi.fn(async (_s: unknown, buf: Buffer) => buf.toString('utf8')),
};
const reportRepo = { findAll: vi.fn() };
const userRepo = { findAll: vi.fn(), findFirst: vi.fn() };
const profileRepo = { findAll: vi.fn() };
const uraRepo = { findFirst: vi.fn() };
const udRepo = { findFirst: vi.fn() };
const scheduler = { getConfig: vi.fn(), nextRunAt: vi.fn(), getLastRun: vi.fn(), runForTenant: vi.fn() };
const eventEmitter = { emit: vi.fn() };
const cls = {
  get: vi.fn((k: string) => (k === 'tenantId' ? TENANT : k === 'user' ? { id: 'admin-1', roles: ['TENANT_ADMIN'] } : undefined)),
  set: vi.fn(),
};
const secrets = { encrypt: vi.fn(), decrypt: vi.fn() };
const redactor = { redact: vi.fn(async (t: string) => t.replace('Jane Doe', '[NAME]')) };
const configResolver = { resolveEffectiveDnaStyleEnabled: vi.fn().mockResolvedValue({ effective: true }) };
const settingsWrite = { write: vi.fn().mockResolvedValue({}), getBackingRowVersion: vi.fn().mockResolvedValue(0) };

const make = () =>
  new DnaMemoryAdminService(
    sampleRepo as never,
    reportRepo as never,
    userRepo as never,
    profileRepo as never,
    uraRepo as never,
    udRepo as never,
    scheduler as never,
    eventEmitter as never,
    cls as never,
    secrets as never,
    redactor as never,
    configResolver as never,
    settingsWrite as never,
  );

const member = () => {
  uraRepo.findFirst.mockResolvedValue({ id: 'ura', userId: DOCTOR, tenantId: TENANT, resourceStatus: ResourceStatusType.ENABLED });
  udRepo.findFirst.mockResolvedValue({ id: 'ud', userId: DOCTOR, tenantId: TENANT, resourceStatus: ResourceStatusType.ENABLED });
  userRepo.findFirst.mockResolvedValue({ id: DOCTOR, isServiceAccount: false });
};
const foreign = () => {
  uraRepo.findFirst.mockResolvedValue(null);
  udRepo.findFirst.mockResolvedValue(null);
  userRepo.findFirst.mockResolvedValue(null);
};

beforeEach(() => vi.clearAllMocks());

describe('memory list', () => {
  it('returns a redacted ≤200-char preview, never the full text', async () => {
    member();
    const long = `Jane Doe presented with ${'x'.repeat(400)}`;
    sampleRepo.findPaginated.mockResolvedValue({
      count: 1,
      data: [
        {
          id: 's-1',
          doctorId: DOCTOR,
          source: 'INGEST',
          kind: 'CASE_NOTE',
          writtenAt: new Date('2026-09-01T00:00:00Z'),
          sourceRef: 'emr-1',
          consultationId: null,
          consumedByReportId: null,
          textCiphertext: Buffer.from(long),
          createdAt: new Date('2026-09-02T00:00:00Z'),
        },
      ],
    });

    const page = await make().listMemory({ doctorId: DOCTOR });

    expect(sampleRepo.findPaginated).toHaveBeenCalledWith({ tenantId: TENANT, doctorId: DOCTOR }, 1, 20);
    const row = page.data[0]!;
    expect(row.preview.length).toBeLessThanOrEqual(200);
    expect(row.preview).not.toContain('Jane Doe');
    expect(row.preview.startsWith('[NAME] presented')).toBe(true);
    expect(row).toMatchObject({ id: 's-1', source: 'INGEST', consumed: false, writtenAt: '2026-09-01T00:00:00.000Z' });
    expect(row).not.toHaveProperty('textCiphertext');
  });

  it('a clinician of ANOTHER tenant is 404', async () => {
    foreign();
    await expect(make().listMemory({ doctorId: 'other-doctor' })).rejects.toBeInstanceOf(NotFoundException);
    expect(sampleRepo.findPaginated).not.toHaveBeenCalled();
  });

  it('no redactor ⇒ an empty preview, never unredacted text', async () => {
    member();
    sampleRepo.findPaginated.mockResolvedValue({
      count: 1,
      data: [{ id: 's-1', doctorId: DOCTOR, source: 'EDIT', writtenAt: new Date(), textCiphertext: Buffer.from('Jane Doe'), createdAt: new Date() }],
    });
    const svc = new DnaMemoryAdminService(
      sampleRepo as never,
      reportRepo as never,
      userRepo as never,
      profileRepo as never,
      uraRepo as never,
      udRepo as never,
      scheduler as never,
      eventEmitter as never,
      cls as never,
      secrets as never,
      undefined,
      configResolver as never,
      settingsWrite as never,
    );
    const page = await svc.listMemory({ doctorId: DOCTOR });
    expect(page.data[0]!.preview).toBe('');
  });
});

describe('memory delete', () => {
  it('soft-deletes an own-tenant sample and broadcasts', async () => {
    sampleRepo.findById.mockResolvedValue({ id: 's-1', tenantId: TENANT, doctorId: DOCTOR });
    await make().deleteMemory('s-1');
    expect(sampleRepo.softDelete).toHaveBeenCalledWith('s-1', 'admin-1');
    expect(eventEmitter.emit).toHaveBeenCalledWith(SysEventType.ResourceDeleted, expect.anything());
  });

  it('a sample of ANOTHER tenant is 404 and untouched', async () => {
    sampleRepo.findById.mockResolvedValue({ id: 's-9', tenantId: 'tenant-2', doctorId: 'x' });
    await expect(make().deleteMemory('s-9')).rejects.toBeInstanceOf(NotFoundException);
    sampleRepo.findById.mockRejectedValue(new Error('not found'));
    await expect(make().deleteMemory('missing')).rejects.toBeInstanceOf(NotFoundException);
    expect(sampleRepo.softDelete).not.toHaveBeenCalled();
  });
});

describe('memory summary', () => {
  it('joins memory counts, latest report, user names and the DNA gate', async () => {
    sampleRepo.summarizeByDoctor.mockResolvedValue([
      { doctorId: DOCTOR, total: 3, unconsumed: 2, bySource: { EDIT: 1, SIGNOFF: 1, INGEST: 1 }, lastSampleAt: new Date('2026-09-03T00:00:00Z') },
    ]);
    reportRepo.findAll.mockResolvedValue([{ id: 'r-1', doctorId: DOCTOR, createdAt: new Date('2026-09-01T00:00:00Z') }]);
    userRepo.findAll.mockResolvedValue([{ id: DOCTOR, username: 'dr.one' }]);
    profileRepo.findAll.mockResolvedValue([{ userId: DOCTOR, firstName: 'Ann', lastName: 'One' }]);

    const rows = await make().getMemorySummary();

    expect(rows).toEqual([
      {
        doctorId: DOCTOR,
        username: 'dr.one',
        displayName: 'Ann One',
        total: 3,
        unconsumed: 2,
        bySource: { EDIT: 1, SIGNOFF: 1, INGEST: 1 },
        lastSampleAt: '2026-09-03T00:00:00.000Z',
        lastReportAt: '2026-09-01T00:00:00.000Z',
        latestReportId: 'r-1',
        dnaEnabled: true,
      },
    ]);
    expect(reportRepo.findAll).toHaveBeenCalledWith(
      expect.objectContaining({ filters: expect.objectContaining({ tenantId: TENANT, isLatest: true }) }),
    );
  });
});

describe('schedule', () => {
  it('writes only the supplied keys at TENANT scope and answers the effective schedule', async () => {
    scheduler.getConfig.mockReturnValue({ enabled: true, cron: '0 3 * * 1', minNewSamples: 4, timeZone: 'UTC', jobDelayMs: 0 });
    scheduler.nextRunAt.mockReturnValue(new Date('2026-10-05T03:00:00Z'));
    scheduler.getLastRun.mockResolvedValue(null);
    settingsWrite.getBackingRowVersion.mockResolvedValueOnce(2);

    const out = await make().updateSchedule({ cron: '0 3 * * 1', minNewSamples: 4 });

    expect(settingsWrite.write).toHaveBeenCalledTimes(2);
    expect(settingsWrite.write).toHaveBeenCalledWith('dna-regen.cron', '0 3 * * 1', { scope: 'tenant', expectedVersion: 2 });
    expect(settingsWrite.write).toHaveBeenCalledWith('dna-regen.min-new-samples', 4, { scope: 'tenant' });
    expect(out).toEqual({
      enabled: true,
      cron: '0 3 * * 1',
      minNewSamples: 4,
      timeZone: 'UTC',
      nextRunAt: '2026-10-05T03:00:00.000Z',
      lastRun: null,
    });
  });

  it('run now runs THIS tenant only', async () => {
    scheduler.runForTenant.mockResolvedValue({
      tenantId: TENANT,
      at: 'x',
      queued: 1,
      skipped: { noFeedback: 0, optedOut: 0, quota: 0, belowFloor: 0 },
      jobs: [{ doctorId: DOCTOR, jobId: 'j' }],
      errors: [],
    });
    const out = await make().runNow();
    expect(scheduler.runForTenant).toHaveBeenCalledWith(TENANT);
    expect(out).toEqual({ queued: 1, skipped: { noFeedback: 0, optedOut: 0, quota: 0, belowFloor: 0 }, jobs: [{ doctorId: DOCTOR, jobId: 'j' }] });
  });
});
