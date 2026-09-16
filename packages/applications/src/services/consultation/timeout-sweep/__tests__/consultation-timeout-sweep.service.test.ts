/**
 * ConsultationTimeoutSweepService
 *
 * Covers:
 *   - self-scheduling cron (mirrors AgentTrajectoryRetentionService's suite
 *     shape), deliberately WITHOUT an `enabled` gate;
 *   - `sweepOnce()` reads the settings-driven staleness window, queries
 *     `ConsultationRepository.findTimeoutSweepEligible`, and transitions
 *     every eligible row to `CLOSED_INCOMPLETE` via `transitionTo` +
 *     `updateWithVersion`, broadcasting `ResourceUpdated` and appending the
 *     `SESSION_CLOSED_INCOMPLETE` WORM row — each correctly attributed to
 *     THAT row's own tenant, not a shared/ambient one;
 *   - a single row's failure never aborts the batch;
 *   - `sweepStaleRecordings()` (TASK-932 OD-9) — the RECORDING leg: a stale
 *     RECORDING row with no live-summary lock is stopped via the real client
 *     path (`ConsultationService.stopRecording`); a row that still holds the
 *     lock is left alone; a single row's failure never aborts the batch
 *     either; the window comes from the descriptor, never a literal.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConsultationEntity, ConsultationStatus, HarnessAuditAction, ResourceStatusType, SysEventType } from '@arcaai/domains';
import { ConsultationTimeoutSweepService, liveSummaryLockKey } from '../consultation-timeout-sweep.service';
import {
  CONSULTATION_GATE_DEFAULTS,
  CONSULTATION_RECORDING_STALE_MINUTES_KEY,
  CONSULTATION_SESSION_TIMEOUT_MINUTES_KEY,
  CONSULTATION_SESSION_TIMEOUT_SWEEP_CRON_KEY,
  CONSULTATION_REVIEW_TIMEOUT_MINUTES_KEY,
  CONSULTATION_OPEN_TIMEOUT_MINUTES_KEY,
} from '../../consultation-gates.constants';

vi.mock('cron', () => {
  return {
    CronJob: class MockCronJob {
      _callback: () => void;
      start = vi.fn();
      stop = vi.fn();
      constructor(_cron: string, callback: () => void) {
        this._callback = callback;
      }
    },
  };
});

// ─── Mock Factories ─────────────────────────────────────────────────

function makeEntity(overrides: Partial<{ id: string; tenantId: string; status: ConsultationStatus; version: number }> = {}): ConsultationEntity {
  return new ConsultationEntity({
    id: overrides.id ?? 'c-1',
    tenantId: overrides.tenantId ?? 'tenant-1',
    patientId: 'patient-1',
    doctorId: 'doctor-1',
    appointmentDate: new Date('2026-06-08'),
    departmentId: null,
    parentConsultationId: null,
    metadata: null,
    status: overrides.status ?? ConsultationStatus.PRIMED,
    degradedReasons: [],
    createdAt: new Date('2026-06-08T00:00:00Z'),
    updatedAt: new Date('2026-06-08T00:00:00Z'),
    createdBy: 'user-1',
    updatedBy: null,
    resourceStatus: ResourceStatusType.ENABLED,
    resourceStatusUpdatedAt: null,
    resourceStatusUpdatedBy: null,
    metaData: undefined,
    version: overrides.version ?? 3,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);
}

const createMockAppSettingsService = (overrides: Record<string, unknown> = {}) => {
  const settings: Record<string, unknown> = { ...overrides };
  return {
    getValueWithDefault: vi.fn(<T>(key: string, defaultValue: T): T => {
      return key in settings ? (settings[key] as T) : defaultValue;
    }),
    getValueFromCache: vi.fn((key: string) => settings[key] ?? null),
  };
};

const createMockSchedulerRegistry = () => {
  const registeredJobs = new Map<string, { stop: ReturnType<typeof vi.fn> }>();
  return {
    addCronJob: vi.fn((name: string, job: any) => {
      registeredJobs.set(name, job);
    }),
    deleteCronJob: vi.fn((name: string) => {
      registeredJobs.delete(name);
    }),
    getCronJob: vi.fn((name: string) => {
      if (!registeredJobs.has(name)) throw new Error(`No job named "${name}"`);
      return registeredJobs.get(name);
    }),
  };
};

const createMockClsService = () => {
  const store = new Map<string, unknown>();
  return {
    run: vi.fn((callback: () => unknown) => callback()),
    set: vi.fn((key: string, value: unknown) => store.set(key, value)),
    get: vi.fn((key?: string) => (key === undefined ? Object.fromEntries(store) : store.get(key))),
  };
};

const createMockConsultationRepository = () => ({
  findTimeoutSweepEligible: vi.fn().mockResolvedValue([]),
  findStaleRecording: vi.fn().mockResolvedValue([]),
  // TASK-972 Lane 8 — the two stranding-state legs.
  findIdlePendingReview: vi.fn().mockResolvedValue([]),
  findIdleOpen: vi.fn().mockResolvedValue([]),
  updateWithVersion: vi.fn().mockImplementation(async (_id: string, entity: ConsultationEntity) => entity),
});

const createMockConsultationService = () => ({
  stopRecording: vi.fn().mockResolvedValue({}),
});

const createMockCacheService = () => ({
  get: vi.fn().mockResolvedValue(null),
});

const createMockHarnessAuditService = () => ({
  append: vi.fn().mockResolvedValue({}),
});

const buildService = (
  params: {
    consultationRepository?: ReturnType<typeof createMockConsultationRepository>;
    eventEmitter?: { emit: ReturnType<typeof vi.fn> };
    clsService?: ReturnType<typeof createMockClsService>;
    appSettingsService?: ReturnType<typeof createMockAppSettingsService>;
    schedulerRegistry?: ReturnType<typeof createMockSchedulerRegistry>;
    consultationService?: ReturnType<typeof createMockConsultationService>;
    cacheService?: ReturnType<typeof createMockCacheService>;
    harnessAuditService?: ReturnType<typeof createMockHarnessAuditService> | undefined;
  } = {},
) => {
  const consultationRepository = params.consultationRepository ?? createMockConsultationRepository();
  const eventEmitter = params.eventEmitter ?? { emit: vi.fn() };
  const clsService = params.clsService ?? createMockClsService();
  const appSettingsService = params.appSettingsService ?? createMockAppSettingsService();
  const schedulerRegistry = params.schedulerRegistry ?? createMockSchedulerRegistry();
  const consultationService = params.consultationService ?? createMockConsultationService();
  const cacheService = params.cacheService ?? createMockCacheService();
  const harnessAuditService = 'harnessAuditService' in params ? params.harnessAuditService : createMockHarnessAuditService();

  const service = new ConsultationTimeoutSweepService(
    consultationRepository as any,
    eventEmitter as any,
    clsService as any,
    appSettingsService as any,
    schedulerRegistry as any,
    consultationService as any,
    cacheService as any,
    harnessAuditService as any,
  );

  return {
    service,
    consultationRepository,
    eventEmitter,
    clsService,
    appSettingsService,
    schedulerRegistry,
    consultationService,
    cacheService,
    harnessAuditService,
  };
};

// ─── Tests ──────────────────────────────────────────────────────────

describe('ConsultationTimeoutSweepService', () => {
  // A failed assertion skips a test's inline vi.useRealTimers(); never leak fake timers into the next test.
  afterEach(() => {
    vi.useRealTimers();
  });

  describe('getConfig', () => {
    it('reads cron, timeoutMinutes and recordingStaleMinutes from AppSettingsService', () => {
      const { service } = buildService({
        appSettingsService: createMockAppSettingsService({
          [CONSULTATION_SESSION_TIMEOUT_SWEEP_CRON_KEY]: '0 * * * *',
          [CONSULTATION_SESSION_TIMEOUT_MINUTES_KEY]: 60,
          [CONSULTATION_RECORDING_STALE_MINUTES_KEY]: 45,
        }),
      });

      expect(service.getConfig()).toMatchObject({ cron: '0 * * * *', timeoutMinutes: 60, recordingStaleMinutes: 45 });
    });

    it('falls back to the documented code defaults when settings are missing', () => {
      const { service } = buildService();

      expect(service.getConfig()).toEqual({
        cron: CONSULTATION_GATE_DEFAULTS[CONSULTATION_SESSION_TIMEOUT_SWEEP_CRON_KEY],
        timeoutMinutes: CONSULTATION_GATE_DEFAULTS[CONSULTATION_SESSION_TIMEOUT_MINUTES_KEY],
        recordingStaleMinutes: CONSULTATION_GATE_DEFAULTS[CONSULTATION_RECORDING_STALE_MINUTES_KEY],
        reviewTimeoutMinutes: CONSULTATION_GATE_DEFAULTS[CONSULTATION_REVIEW_TIMEOUT_MINUTES_KEY],
        openTimeoutMinutes: CONSULTATION_GATE_DEFAULTS[CONSULTATION_OPEN_TIMEOUT_MINUTES_KEY],
      });
    });

    it('the recordingStaleMinutes window is read from the descriptor (default 30), never a literal', () => {
      const { service } = buildService();

      expect(CONSULTATION_GATE_DEFAULTS[CONSULTATION_RECORDING_STALE_MINUTES_KEY]).toBe(30);
      expect(service.getConfig().recordingStaleMinutes).toBe(30);
    });
  });

  describe('syncSchedulerFromConfig / onModuleInit', () => {
    it('schedules the cron job on init with no enabled gate to check', () => {
      const { service, schedulerRegistry } = buildService();

      service.onModuleInit();

      expect(schedulerRegistry.addCronJob).toHaveBeenCalledWith('consultation-timeout-sweep', expect.any(Object));
    });

    it('replaces the job when the cron expression changes', () => {
      const appSettingsService = createMockAppSettingsService({ [CONSULTATION_SESSION_TIMEOUT_SWEEP_CRON_KEY]: '*/15 * * * *' });
      const { service, schedulerRegistry } = buildService({ appSettingsService });

      service.syncSchedulerFromConfig();
      expect(schedulerRegistry.addCronJob).toHaveBeenCalledTimes(1);

      appSettingsService.getValueWithDefault.mockImplementation(<T>(key: string, defaultValue: T): T => {
        if (key === CONSULTATION_SESSION_TIMEOUT_SWEEP_CRON_KEY) return '0 * * * *' as T;
        return defaultValue;
      });

      service.syncSchedulerFromConfig();

      expect(schedulerRegistry.deleteCronJob).toHaveBeenCalledWith('consultation-timeout-sweep');
      expect(schedulerRegistry.addCronJob).toHaveBeenCalledTimes(2);
    });

    it('does not replace the job when config is unchanged', () => {
      const { service, schedulerRegistry } = buildService();

      service.syncSchedulerFromConfig();
      service.syncSchedulerFromConfig();

      expect(schedulerRegistry.addCronJob).toHaveBeenCalledTimes(1);
    });
  });

  describe('onSettingsRefreshed', () => {
    it('re-syncs the scheduler from the refreshed cache', () => {
      const { service, appSettingsService } = buildService();

      service.onSettingsRefreshed();

      expect(appSettingsService.getValueWithDefault).toHaveBeenCalledWith(CONSULTATION_SESSION_TIMEOUT_SWEEP_CRON_KEY, expect.any(String));
    });
  });

  describe('onModuleDestroy', () => {
    it('stops the cron job on shutdown', () => {
      const { service, schedulerRegistry } = buildService();

      service.syncSchedulerFromConfig();
      service.onModuleDestroy();

      expect(schedulerRegistry.deleteCronJob).toHaveBeenCalledWith('consultation-timeout-sweep');
    });
  });

  describe('sweepOnce', () => {
    it('refuses to sweep with a non-positive timeout window', async () => {
      const { service, consultationRepository } = buildService({
        appSettingsService: createMockAppSettingsService({ [CONSULTATION_SESSION_TIMEOUT_MINUTES_KEY]: 0 }),
      });

      const result = await service.sweepOnce();

      expect(result).toEqual({ eligible: 0, transitioned: 0, failed: 0 });
      expect(consultationRepository.findTimeoutSweepEligible).not.toHaveBeenCalled();
    });

    it('queries eligible rows with a cutoff derived from the configured window', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-08-20T12:00:00.000Z'));

      const { service, consultationRepository } = buildService({
        appSettingsService: createMockAppSettingsService({ [CONSULTATION_SESSION_TIMEOUT_MINUTES_KEY]: 1440 }),
      });

      await service.sweepOnce();

      expect(consultationRepository.findTimeoutSweepEligible).toHaveBeenCalledWith(new Date('2026-08-19T12:00:00.000Z'));

      vi.useRealTimers();
    });

    it('an explicit timeoutMinutes override takes precedence over the descriptor-resolved value (one-off cleanup script, TASK-932 O-2)', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-09-09T12:00:00.000Z'));

      const { service, consultationRepository } = buildService({
        // Descriptor/settings say 1440 (24h) — the override must win.
        appSettingsService: createMockAppSettingsService({ [CONSULTATION_SESSION_TIMEOUT_MINUTES_KEY]: 1440 }),
      });

      await service.sweepOnce({ timeoutMinutes: 30 });

      expect(consultationRepository.findTimeoutSweepEligible).toHaveBeenCalledWith(new Date('2026-09-09T11:30:00.000Z'));

      vi.useRealTimers();
    });

    it('the non-positive-window safety guard still applies to an explicit override', async () => {
      const { service, consultationRepository } = buildService();

      const result = await service.sweepOnce({ timeoutMinutes: 0 });

      expect(result).toEqual({ eligible: 0, transitioned: 0, failed: 0 });
      expect(consultationRepository.findTimeoutSweepEligible).not.toHaveBeenCalled();
    });

    it('transitions each eligible row to CLOSED_INCOMPLETE, persists, and broadcasts ResourceUpdated attributed to ITS OWN tenant', async () => {
      const rowTenantA = makeEntity({ id: 'c-a', tenantId: 'tenant-A', status: ConsultationStatus.PRIMED, version: 3 });
      const rowTenantB = makeEntity({ id: 'c-b', tenantId: 'tenant-B', status: ConsultationStatus.REOPENED, version: 5 });
      const consultationRepository = createMockConsultationRepository();
      consultationRepository.findTimeoutSweepEligible.mockResolvedValue([rowTenantA, rowTenantB]);
      const eventEmitter = { emit: vi.fn() };

      const { service } = buildService({ consultationRepository, eventEmitter });

      const result = await service.sweepOnce();

      expect(result).toEqual({ eligible: 2, transitioned: 2, failed: 0 });

      expect(rowTenantA.status).toBe(ConsultationStatus.CLOSED_INCOMPLETE);
      expect(rowTenantB.status).toBe(ConsultationStatus.CLOSED_INCOMPLETE);

      expect(consultationRepository.updateWithVersion).toHaveBeenCalledWith('c-a', rowTenantA, 3);
      expect(consultationRepository.updateWithVersion).toHaveBeenCalledWith('c-b', rowTenantB, 5);

      const emittedEvents = eventEmitter.emit.mock.calls.filter(([type]) => type === SysEventType.ResourceUpdated);
      expect(emittedEvents).toHaveLength(2);
      const [, payloadA] = emittedEvents.find(([, payload]) => payload.resourceId === 'c-a')!;
      const [, payloadB] = emittedEvents.find(([, payload]) => payload.resourceId === 'c-b')!;
      expect(payloadA.tenantId).toBe('tenant-A');
      expect(payloadB.tenantId).toBe('tenant-B');
      expect(payloadA.data).toEqual({ action: 'session-timeout-sweep', status: ConsultationStatus.CLOSED_INCOMPLETE });
    });

    it('appends a SESSION_CLOSED_INCOMPLETE WORM row per transitioned consultation', async () => {
      const row = makeEntity({ id: 'c-1', tenantId: 'tenant-1', status: ConsultationStatus.TIMED_OUT, version: 2 });
      const consultationRepository = createMockConsultationRepository();
      consultationRepository.findTimeoutSweepEligible.mockResolvedValue([row]);
      const harnessAuditService = createMockHarnessAuditService();

      const { service } = buildService({ consultationRepository, harnessAuditService });

      await service.sweepOnce();

      expect(harnessAuditService.append).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantId: 'tenant-1',
          consultationId: 'c-1',
          action: HarnessAuditAction.SESSION_CLOSED_INCOMPLETE,
        }),
      );
    });

    it('works without a HarnessAuditService (optional dependency, best-effort)', async () => {
      const row = makeEntity({ id: 'c-1', status: ConsultationStatus.DRAINING });
      const consultationRepository = createMockConsultationRepository();
      consultationRepository.findTimeoutSweepEligible.mockResolvedValue([row]);

      const { service } = buildService({ consultationRepository, harnessAuditService: undefined });

      const result = await service.sweepOnce();

      expect(result).toEqual({ eligible: 1, transitioned: 1, failed: 0 });
    });

    it('continues the batch when one row fails (e.g. a concurrent version conflict)', async () => {
      const rowOk = makeEntity({ id: 'c-ok', tenantId: 'tenant-1', status: ConsultationStatus.PRIMED });
      const rowFails = makeEntity({ id: 'c-fails', tenantId: 'tenant-1', status: ConsultationStatus.DRAFT_PENDING_SENSORS });
      const consultationRepository = createMockConsultationRepository();
      consultationRepository.findTimeoutSweepEligible.mockResolvedValue([rowFails, rowOk]);
      consultationRepository.updateWithVersion.mockImplementation(async (id: string, entity: ConsultationEntity) => {
        if (id === 'c-fails') throw new Error('optimistic concurrency conflict');
        return entity;
      });

      const { service } = buildService({ consultationRepository });

      const result = await service.sweepOnce();

      expect(result).toEqual({ eligible: 2, transitioned: 1, failed: 1 });
      expect(rowOk.status).toBe(ConsultationStatus.CLOSED_INCOMPLETE);
    });

    it('binds a fresh CLS context per row via clsService.run', async () => {
      const rowA = makeEntity({ id: 'c-a', tenantId: 'tenant-A' });
      const rowB = makeEntity({ id: 'c-b', tenantId: 'tenant-B' });
      const consultationRepository = createMockConsultationRepository();
      consultationRepository.findTimeoutSweepEligible.mockResolvedValue([rowA, rowB]);
      const clsService = createMockClsService();

      const { service } = buildService({ consultationRepository, clsService });

      await service.sweepOnce();

      expect(clsService.run).toHaveBeenCalledTimes(2);
    });
  });

  describe('sweepStaleRecordings (TASK-932 OD-9 — the RECORDING leg)', () => {
    it('refuses to sweep with a non-positive recordingStaleMinutes window', async () => {
      const { service, consultationRepository } = buildService({
        appSettingsService: createMockAppSettingsService({ [CONSULTATION_RECORDING_STALE_MINUTES_KEY]: 0 }),
      });

      const result = await service.sweepStaleRecordings();

      expect(result).toEqual({ eligible: 0, transitioned: 0, failed: 0 });
      expect(consultationRepository.findStaleRecording).not.toHaveBeenCalled();
    });

    it('the window is read from the descriptor (default 30) not a literal', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-09-09T12:00:00.000Z'));

      const { service, consultationRepository } = buildService();

      await service.sweepStaleRecordings();

      expect(consultationRepository.findStaleRecording).toHaveBeenCalledWith(new Date('2026-09-09T11:30:00.000Z'));

      vi.useRealTimers();
    });

    it('an explicit recordingStaleMinutes override takes precedence over the descriptor-resolved value (one-off cleanup script, TASK-932 O-2)', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-09-09T12:00:00.000Z'));

      const { service, consultationRepository } = buildService();

      await service.sweepStaleRecordings({ recordingStaleMinutes: 5 });

      expect(consultationRepository.findStaleRecording).toHaveBeenCalledWith(new Date('2026-09-09T11:55:00.000Z'));

      vi.useRealTimers();
    });

    it('a stale RECORDING row with no lock is stopped via ConsultationService.stopRecording', async () => {
      const row = makeEntity({ id: 'c-rec', tenantId: 'tenant-1', status: ConsultationStatus.RECORDING });
      const consultationRepository = createMockConsultationRepository();
      consultationRepository.findStaleRecording.mockResolvedValue([row]);
      const cacheService = createMockCacheService();
      cacheService.get.mockResolvedValue(null); // no lock held

      const { service, consultationService, clsService } = buildService({ consultationRepository, cacheService });

      const result = await service.sweepStaleRecordings();

      expect(cacheService.get).toHaveBeenCalledWith(liveSummaryLockKey('c-rec'));
      expect(consultationService.stopRecording).toHaveBeenCalledWith('c-rec');
      expect(clsService.run).toHaveBeenCalledTimes(1);
      expect(result).toEqual({ eligible: 1, transitioned: 1, failed: 0 });
    });

    it('a stale RECORDING row WITH a lock is left alone', async () => {
      const row = makeEntity({ id: 'c-rec', tenantId: 'tenant-1', status: ConsultationStatus.RECORDING });
      const consultationRepository = createMockConsultationRepository();
      consultationRepository.findStaleRecording.mockResolvedValue([row]);
      const cacheService = createMockCacheService();
      cacheService.get.mockResolvedValue('instance-abc'); // lock held by a live instance

      const { service, consultationService } = buildService({ consultationRepository, cacheService });

      const result = await service.sweepStaleRecordings();

      expect(consultationService.stopRecording).not.toHaveBeenCalled();
      expect(result).toEqual({ eligible: 1, transitioned: 0, failed: 0 });
    });

    it('a fresh RECORDING row is not considered (excluded upstream by the cutoff-scoped query)', async () => {
      const consultationRepository = createMockConsultationRepository();
      consultationRepository.findStaleRecording.mockResolvedValue([]);
      const { service, consultationService } = buildService({ consultationRepository });

      const result = await service.sweepStaleRecordings();

      expect(consultationService.stopRecording).not.toHaveBeenCalled();
      expect(result).toEqual({ eligible: 0, transitioned: 0, failed: 0 });
    });

    it('a failing stop does not abort the batch', async () => {
      const rowOk = makeEntity({ id: 'c-ok', tenantId: 'tenant-1', status: ConsultationStatus.RECORDING });
      const rowFails = makeEntity({ id: 'c-fails', tenantId: 'tenant-1', status: ConsultationStatus.RECORDING });
      const consultationRepository = createMockConsultationRepository();
      consultationRepository.findStaleRecording.mockResolvedValue([rowFails, rowOk]);
      const consultationService = createMockConsultationService();
      consultationService.stopRecording.mockImplementation(async (id: string) => {
        if (id === 'c-fails') throw new Error('illegal transition race');
        return {};
      });

      const { service } = buildService({ consultationRepository, consultationService });

      const result = await service.sweepStaleRecordings();

      expect(result).toEqual({ eligible: 2, transitioned: 1, failed: 1 });
      expect(consultationService.stopRecording).toHaveBeenCalledWith('c-ok');
    });

    it('binds the row-owning tenant on CLS before calling stopRecording, mirroring the DRAINING leg', async () => {
      const row = makeEntity({ id: 'c-rec', tenantId: 'tenant-Z', status: ConsultationStatus.RECORDING });
      const consultationRepository = createMockConsultationRepository();
      consultationRepository.findStaleRecording.mockResolvedValue([row]);
      const clsService = createMockClsService();

      const { service } = buildService({ consultationRepository, clsService });

      await service.sweepStaleRecordings();

      expect(clsService.set).toHaveBeenCalledWith('tenantId', 'tenant-Z');
    });

    it('a cache lookup failure is treated like any other per-row failure — never aborts the batch', async () => {
      const rowOk = makeEntity({ id: 'c-ok', tenantId: 'tenant-1', status: ConsultationStatus.RECORDING });
      const rowFails = makeEntity({ id: 'c-fails', tenantId: 'tenant-1', status: ConsultationStatus.RECORDING });
      const consultationRepository = createMockConsultationRepository();
      consultationRepository.findStaleRecording.mockResolvedValue([rowFails, rowOk]);
      const cacheService = createMockCacheService();
      cacheService.get.mockImplementation(async (key: string) => {
        if (key === liveSummaryLockKey('c-fails')) throw new Error('redis unavailable');
        return null;
      });

      const { service, consultationService } = buildService({ consultationRepository, cacheService });

      const result = await service.sweepStaleRecordings();

      expect(result).toEqual({ eligible: 2, transitioned: 1, failed: 1 });
      expect(consultationService.stopRecording).toHaveBeenCalledWith('c-ok');
    });
  });

  // ── TASK-972 Lane 8 (OD-6 / OD-7) — the two stranding-state legs ──
  //
  // These exist because the two states a consultation ACTUALLY strands in were
  // the two the sweep deliberately excluded. Measured on `hope-v2-dev`
  // 2026-09-15: one real consultation idle 29.4 h in PENDING_REVIEW, the sweep
  // reporting `eligible: 0` every 15 minutes, Temporal `Running = 0` — a row
  // leak, not a workflow leak.

  describe('sweepIdlePendingReview (OD-6)', () => {
    it('reads the window from the descriptor (default 120), never a literal', async () => {
      const consultationRepository = createMockConsultationRepository();
      const { service } = buildService({ consultationRepository });

      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-09-09T12:00:00.000Z'));

      await service.sweepIdlePendingReview();

      expect(CONSULTATION_GATE_DEFAULTS[CONSULTATION_REVIEW_TIMEOUT_MINUTES_KEY]).toBe(120);
      expect(consultationRepository.findIdlePendingReview.mock.calls[0][0]).toEqual(new Date('2026-09-09T10:00:00.000Z'));

      vi.useRealTimers();
    });

    it('honours an operator-tuned window from AppSettingsService', async () => {
      const consultationRepository = createMockConsultationRepository();
      const { service } = buildService({
        consultationRepository,
        appSettingsService: createMockAppSettingsService({ [CONSULTATION_REVIEW_TIMEOUT_MINUTES_KEY]: 600 }),
      });

      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-09-09T12:00:00.000Z'));

      await service.sweepIdlePendingReview();

      expect(consultationRepository.findIdlePendingReview.mock.calls[0][0]).toEqual(new Date('2026-09-09T02:00:00.000Z'));

      vi.useRealTimers();
    });

    it('transitions an idle PENDING_REVIEW row to TIMED_OUT — NOT CLOSED_INCOMPLETE', async () => {
      const row = makeEntity({ id: 'c-pr', tenantId: 'tenant-7', status: ConsultationStatus.PENDING_REVIEW, version: 11 });
      const consultationRepository = createMockConsultationRepository();
      consultationRepository.findIdlePendingReview.mockResolvedValue([row]);

      const { service, eventEmitter, harnessAuditService } = buildService({ consultationRepository });

      const result = await service.sweepIdlePendingReview();

      expect(result).toEqual({ eligible: 1, transitioned: 1, failed: 0 });
      expect(row.status).toBe(ConsultationStatus.TIMED_OUT);
      expect(consultationRepository.updateWithVersion).toHaveBeenCalledWith('c-pr', row, 11);
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        SysEventType.ResourceUpdated,
        expect.objectContaining({ resourceId: 'c-pr', data: expect.objectContaining({ status: ConsultationStatus.TIMED_OUT }) }),
      );
      expect(harnessAuditService!.append).toHaveBeenCalledWith(
        expect.objectContaining({ consultationId: 'c-pr', tenantId: 'tenant-7', action: HarnessAuditAction.SESSION_TIMED_OUT }),
      );
    });

    it("binds the ROW's own tenant on CLS for the write, not an ambient one", async () => {
      const row = makeEntity({ id: 'c-pr', tenantId: 'tenant-42', status: ConsultationStatus.PENDING_REVIEW });
      const consultationRepository = createMockConsultationRepository();
      consultationRepository.findIdlePendingReview.mockResolvedValue([row]);

      const { service, clsService } = buildService({ consultationRepository });

      await service.sweepIdlePendingReview();

      expect(clsService.run).toHaveBeenCalled();
      expect(clsService.set).toHaveBeenCalledWith('tenantId', 'tenant-42');
    });

    /**
     * OD-6's whole point: the target is RECOVERABLE. A clinician who reviews
     * and submits AFTER the sweep still signs, which is what keeps the note
     * closable and the training pair harvestable.
     */
    it('leaves the row able to reach SIGNED afterwards (the OD-6 recovery path)', async () => {
      const row = makeEntity({ id: 'c-pr', status: ConsultationStatus.PENDING_REVIEW });
      const consultationRepository = createMockConsultationRepository();
      consultationRepository.findIdlePendingReview.mockResolvedValue([row]);

      const { service } = buildService({ consultationRepository });
      await service.sweepIdlePendingReview();

      expect(row.status).toBe(ConsultationStatus.TIMED_OUT);
      expect(row.canTransitionTo(ConsultationStatus.SIGNED)).toBe(true);
      expect(row.transitionTo(ConsultationStatus.SIGNED, 'user-1', 'late-submit')).toBe(true);
      expect(row.status).toBe(ConsultationStatus.SIGNED);
    });

    it('refuses to sweep on a non-positive window', async () => {
      const consultationRepository = createMockConsultationRepository();
      const { service } = buildService({
        consultationRepository,
        appSettingsService: createMockAppSettingsService({ [CONSULTATION_REVIEW_TIMEOUT_MINUTES_KEY]: 0 }),
      });

      expect(await service.sweepIdlePendingReview()).toEqual({ eligible: 0, transitioned: 0, failed: 0 });
      expect(consultationRepository.findIdlePendingReview).not.toHaveBeenCalled();
    });

    it('never forces an illegal transition — a raced row is refused and counted failed, not written', async () => {
      const raced = makeEntity({ id: 'c-signed', status: ConsultationStatus.SIGNED });
      const good = makeEntity({ id: 'c-ok', status: ConsultationStatus.PENDING_REVIEW });
      const consultationRepository = createMockConsultationRepository();
      consultationRepository.findIdlePendingReview.mockResolvedValue([raced, good]);

      const { service } = buildService({ consultationRepository });

      const result = await service.sweepIdlePendingReview();

      expect(result).toEqual({ eligible: 2, transitioned: 1, failed: 1 });
      expect(raced.status).toBe(ConsultationStatus.SIGNED);
      expect(consultationRepository.updateWithVersion).toHaveBeenCalledTimes(1);
      expect(consultationRepository.updateWithVersion).toHaveBeenCalledWith('c-ok', good, expect.any(Number));
    });

    it('one failing row never aborts the batch', async () => {
      const first = makeEntity({ id: 'c-1', status: ConsultationStatus.PENDING_REVIEW });
      const second = makeEntity({ id: 'c-2', status: ConsultationStatus.PENDING_REVIEW });
      const consultationRepository = createMockConsultationRepository();
      consultationRepository.findIdlePendingReview.mockResolvedValue([first, second]);
      consultationRepository.updateWithVersion.mockRejectedValueOnce(new Error('OptimisticConcurrencyException'));

      const { service } = buildService({ consultationRepository });

      expect(await service.sweepIdlePendingReview()).toEqual({ eligible: 2, transitioned: 1, failed: 1 });
    });
  });

  describe('sweepIdleOpen (OD-7)', () => {
    it('reads the window from the descriptor (default 120), never a literal', async () => {
      const consultationRepository = createMockConsultationRepository();
      const { service } = buildService({ consultationRepository });

      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-09-09T12:00:00.000Z'));

      await service.sweepIdleOpen();

      expect(CONSULTATION_GATE_DEFAULTS[CONSULTATION_OPEN_TIMEOUT_MINUTES_KEY]).toBe(120);
      expect(consultationRepository.findIdleOpen.mock.calls[0][0]).toEqual(new Date('2026-09-09T10:00:00.000Z'));

      vi.useRealTimers();
    });

    it('transitions an idle OPEN row to CLOSED_INCOMPLETE with the SESSION_CLOSED_INCOMPLETE WORM row', async () => {
      const row = makeEntity({ id: 'c-open', tenantId: 'tenant-3', status: ConsultationStatus.OPEN, version: 2 });
      const consultationRepository = createMockConsultationRepository();
      consultationRepository.findIdleOpen.mockResolvedValue([row]);

      const { service, eventEmitter, harnessAuditService, clsService } = buildService({ consultationRepository });

      const result = await service.sweepIdleOpen();

      expect(result).toEqual({ eligible: 1, transitioned: 1, failed: 0 });
      expect(row.status).toBe(ConsultationStatus.CLOSED_INCOMPLETE);
      expect(consultationRepository.updateWithVersion).toHaveBeenCalledWith('c-open', row, 2);
      expect(clsService.set).toHaveBeenCalledWith('tenantId', 'tenant-3');
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        SysEventType.ResourceUpdated,
        expect.objectContaining({ resourceId: 'c-open', data: expect.objectContaining({ status: ConsultationStatus.CLOSED_INCOMPLETE }) }),
      );
      expect(harnessAuditService!.append).toHaveBeenCalledWith(
        expect.objectContaining({ consultationId: 'c-open', tenantId: 'tenant-3', action: HarnessAuditAction.SESSION_CLOSED_INCOMPLETE }),
      );
    });

    it('writes nothing when no row is past its threshold', async () => {
      const consultationRepository = createMockConsultationRepository();
      const { service, eventEmitter } = buildService({ consultationRepository });

      expect(await service.sweepIdleOpen()).toEqual({ eligible: 0, transitioned: 0, failed: 0 });
      expect(consultationRepository.updateWithVersion).not.toHaveBeenCalled();
      expect(eventEmitter.emit).not.toHaveBeenCalled();
    });

    it('never forces an illegal transition — a RECORDING row raced into the batch is refused, not closed', async () => {
      const raced = makeEntity({ id: 'c-rec', status: ConsultationStatus.RECORDING });
      const consultationRepository = createMockConsultationRepository();
      consultationRepository.findIdleOpen.mockResolvedValue([raced]);

      const { service } = buildService({ consultationRepository });

      expect(await service.sweepIdleOpen()).toEqual({ eligible: 1, transitioned: 0, failed: 1 });
      expect(raced.status).toBe(ConsultationStatus.RECORDING);
      expect(consultationRepository.updateWithVersion).not.toHaveBeenCalled();
    });

    it('refuses to sweep on a non-positive window', async () => {
      const consultationRepository = createMockConsultationRepository();
      const { service } = buildService({
        consultationRepository,
        appSettingsService: createMockAppSettingsService({ [CONSULTATION_OPEN_TIMEOUT_MINUTES_KEY]: 0 }),
      });

      expect(await service.sweepIdleOpen()).toEqual({ eligible: 0, transitioned: 0, failed: 0 });
      expect(consultationRepository.findIdleOpen).not.toHaveBeenCalled();
    });

    it('one failing row never aborts the batch', async () => {
      const first = makeEntity({ id: 'c-1', status: ConsultationStatus.OPEN });
      const second = makeEntity({ id: 'c-2', status: ConsultationStatus.OPEN });
      const consultationRepository = createMockConsultationRepository();
      consultationRepository.findIdleOpen.mockResolvedValue([first, second]);
      consultationRepository.updateWithVersion.mockRejectedValueOnce(new Error('OptimisticConcurrencyException'));

      const { service } = buildService({ consultationRepository });

      expect(await service.sweepIdleOpen()).toEqual({ eligible: 2, transitioned: 1, failed: 1 });
    });
  });

  describe('handleScheduledSweep', () => {
    it('runs sweepOnce and never throws even when the sweep itself fails', async () => {
      const consultationRepository = createMockConsultationRepository();
      consultationRepository.findTimeoutSweepEligible.mockRejectedValue(new Error('db unavailable'));

      const { service } = buildService({ consultationRepository });

      await expect(service.handleScheduledSweep()).resolves.toBeUndefined();
    });

    it('runs the stale-recording leg too, and one leg failing never blocks the other', async () => {
      const consultationRepository = createMockConsultationRepository();
      consultationRepository.findStaleRecording.mockRejectedValue(new Error('db unavailable'));

      const { service } = buildService({ consultationRepository });

      await expect(service.handleScheduledSweep()).resolves.toBeUndefined();

      expect(consultationRepository.findStaleRecording).toHaveBeenCalled();
      expect(consultationRepository.findTimeoutSweepEligible).toHaveBeenCalled();
    });

    it('runs all FOUR legs, each isolated from the others failing', async () => {
      const consultationRepository = createMockConsultationRepository();
      consultationRepository.findStaleRecording.mockRejectedValue(new Error('db unavailable'));
      consultationRepository.findTimeoutSweepEligible.mockRejectedValue(new Error('db unavailable'));
      consultationRepository.findIdlePendingReview.mockRejectedValue(new Error('db unavailable'));

      const { service } = buildService({ consultationRepository });

      await expect(service.handleScheduledSweep()).resolves.toBeUndefined();

      expect(consultationRepository.findStaleRecording).toHaveBeenCalled();
      expect(consultationRepository.findTimeoutSweepEligible).toHaveBeenCalled();
      expect(consultationRepository.findIdlePendingReview).toHaveBeenCalled();
      expect(consultationRepository.findIdleOpen).toHaveBeenCalled();
    });

    /**
     * The PENDING_REVIEW leg runs AFTER the five-state leg, deliberately: a row
     * it moves to TIMED_OUT becomes a member of `findTimeoutSweepEligible`'s
     * own eligible set, so running it first would let a single tick carry a
     * consultation from PENDING_REVIEW all the way to CLOSED_INCOMPLETE and
     * silently destroy the recovery path OD-6 exists to preserve. (The write
     * refreshes `updatedAt`, so in practice the 1440-minute cutoff would
     * exclude it anyway — this ordering means the guarantee does not depend on
     * that.)
     */
    it('runs the PENDING_REVIEW leg after the five-state leg, so one tick can never chain them', async () => {
      const order: string[] = [];
      const consultationRepository = createMockConsultationRepository();
      consultationRepository.findTimeoutSweepEligible.mockImplementation(async () => {
        order.push('sweepOnce');
        return [];
      });
      consultationRepository.findIdlePendingReview.mockImplementation(async () => {
        order.push('pendingReview');
        return [];
      });

      const { service } = buildService({ consultationRepository });
      await service.handleScheduledSweep();

      expect(order).toEqual(['sweepOnce', 'pendingReview']);
    });
  });
});
