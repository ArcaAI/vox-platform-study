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
 *   - a single row's failure never aborts the batch.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConsultationEntity, ConsultationStatus, HarnessAuditAction, ResourceStatusType, SysEventType } from '@arcaai/domains';
import { ConsultationTimeoutSweepService } from '../consultation-timeout-sweep.service';
import {
  CONSULTATION_GATE_DEFAULTS,
  CONSULTATION_SESSION_TIMEOUT_MINUTES_KEY,
  CONSULTATION_SESSION_TIMEOUT_SWEEP_CRON_KEY,
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
  updateWithVersion: vi.fn().mockImplementation(async (_id: string, entity: ConsultationEntity) => entity),
});

const createMockHarnessAuditService = () => ({
  append: vi.fn().mockResolvedValue({}),
});

const buildService = (params: {
  consultationRepository?: ReturnType<typeof createMockConsultationRepository>;
  eventEmitter?: { emit: ReturnType<typeof vi.fn> };
  clsService?: ReturnType<typeof createMockClsService>;
  appSettingsService?: ReturnType<typeof createMockAppSettingsService>;
  schedulerRegistry?: ReturnType<typeof createMockSchedulerRegistry>;
  harnessAuditService?: ReturnType<typeof createMockHarnessAuditService> | undefined;
} = {}) => {
  const consultationRepository = params.consultationRepository ?? createMockConsultationRepository();
  const eventEmitter = params.eventEmitter ?? { emit: vi.fn() };
  const clsService = params.clsService ?? createMockClsService();
  const appSettingsService = params.appSettingsService ?? createMockAppSettingsService();
  const schedulerRegistry = params.schedulerRegistry ?? createMockSchedulerRegistry();
  const harnessAuditService = 'harnessAuditService' in params ? params.harnessAuditService : createMockHarnessAuditService();

  const service = new ConsultationTimeoutSweepService(
    consultationRepository as any,
    eventEmitter as any,
    clsService as any,
    appSettingsService as any,
    schedulerRegistry as any,
    harnessAuditService as any,
  );

  return { service, consultationRepository, eventEmitter, clsService, appSettingsService, schedulerRegistry, harnessAuditService };
};

// ─── Tests ──────────────────────────────────────────────────────────

describe('ConsultationTimeoutSweepService', () => {
  describe('getConfig', () => {
    it('reads cron and timeoutMinutes from AppSettingsService', () => {
      const { service } = buildService({
        appSettingsService: createMockAppSettingsService({
          [CONSULTATION_SESSION_TIMEOUT_SWEEP_CRON_KEY]: '0 * * * *',
          [CONSULTATION_SESSION_TIMEOUT_MINUTES_KEY]: 60,
        }),
      });

      expect(service.getConfig()).toEqual({ cron: '0 * * * *', timeoutMinutes: 60 });
    });

    it('falls back to the documented code defaults when settings are missing', () => {
      const { service } = buildService();

      expect(service.getConfig()).toEqual({
        cron: CONSULTATION_GATE_DEFAULTS[CONSULTATION_SESSION_TIMEOUT_SWEEP_CRON_KEY],
        timeoutMinutes: CONSULTATION_GATE_DEFAULTS[CONSULTATION_SESSION_TIMEOUT_MINUTES_KEY],
      });
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

  describe('handleScheduledSweep', () => {
    it('runs sweepOnce and never throws even when the sweep itself fails', async () => {
      const consultationRepository = createMockConsultationRepository();
      consultationRepository.findTimeoutSweepEligible.mockRejectedValue(new Error('db unavailable'));

      const { service } = buildService({ consultationRepository });

      await expect(service.handleScheduledSweep()).resolves.toBeUndefined();
    });
  });
});
