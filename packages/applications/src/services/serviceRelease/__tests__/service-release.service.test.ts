/**
 * ServiceReleaseService unit tests (/ U5).
 *
 * The load-bearing behaviour under test is the sys-event posture: a heartbeat
 * must broadcast NOTHING (~15 processes × every 5 minutes would otherwise
 * write ~4,300 AuditLog rows/day of pure noise), and only a FIRST-SEEN release
 * broadcasts exactly one `ResourceCreated`.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { DataNotFoundException } from '@arcaai/exceptions';
import { SysEventType } from '@arcaai/domains';
import { ServiceReleaseService, INSTANCE_LIVENESS_THRESHOLD_MS, SERVICE_REGISTRY_TENANT_ID } from '../serviceRelease.service';

const mockClsService = { get: vi.fn(), set: vi.fn() };
const mockEventEmitter = { emit: vi.fn() };

const mockReleaseRepository = {
  findAll: vi.fn(),
  count: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
};

const mockInstanceRepository = {
  findAll: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
};

const REGISTER_INPUT = {
  service: 'smr',
  version: '2.1.0',
  releaseTag: 'SMR-2.1.0',
  gitBranch: 'main',
  gitCommitSha: 'a'.repeat(40),
  buildAt: '2026-08-01T10:00:00.000Z',
  ciPipelineId: '4242',
  ciPipelineUrl: 'https://gitlab/pipelines/4242',
  environment: 'dev',
  instanceId: 'smr-7c9d-abcde',
};

/** Minimal duck-typed ServiceRelease entity (change tracking included). */
const makeReleaseEntity = (overrides: Record<string, unknown> = {}) => {
  const changes: Record<string, unknown> = {};
  const entity: Record<string, unknown> = {
    id: 'release-1',
    tenantId: SERVICE_REGISTRY_TENANT_ID,
    serviceName: 'smr',
    releaseVersion: '2.1.0',
    releaseTag: 'SMR-2.1.0',
    gitBranch: 'main',
    gitCommitSha: 'a'.repeat(40),
    buildAt: new Date('2026-08-01T10:00:00.000Z'),
    imageRepository: null,
    imageDigest: null,
    ciPipelineId: '4242',
    ciPipelineUrl: 'https://gitlab/pipelines/4242',
    changelog: null,
    firstSeenAt: new Date('2026-08-01T10:05:00.000Z'),
    createdAt: new Date('2026-08-01T10:05:00.000Z'),
    updatedAt: new Date('2026-08-01T10:05:00.000Z'),
    version: 1,
    changes,
    get hasChanges() {
      return Object.keys(changes).length > 0;
    },
    ...overrides,
  };
  return entity;
};

/** Minimal duck-typed ServiceInstance entity with `setProperty`-like tracking. */
const makeInstanceEntity = (overrides: Record<string, unknown> = {}) => {
  const changes: Record<string, unknown> = {};
  const state: Record<string, unknown> = {
    id: 'instance-1',
    tenantId: SERVICE_REGISTRY_TENANT_ID,
    releaseId: 'release-1',
    serviceName: 'smr',
    environment: 'dev',
    instanceId: 'smr-7c9d-abcde',
    startedAt: new Date('2026-08-01T10:05:00.000Z'),
    lastSeenAt: new Date('2026-08-01T10:05:00.000Z'),
    ...overrides,
  };
  const entity = {
    ...state,
    changes,
    get hasChanges() {
      return Object.keys(changes).length > 0;
    },
  } as Record<string, unknown>;
  // Track writes the way BaseEntity.setProperty does.
  for (const key of ['releaseId', 'serviceName', 'environment', 'instanceId', 'startedAt', 'lastSeenAt']) {
    Object.defineProperty(entity, key, {
      get: () => state[key],
      set: (value: unknown) => {
        state[key] = value;
        changes[key] = value;
      },
      enumerable: true,
      configurable: true,
    });
  }
  return entity;
};

const createService = () =>
  new ServiceReleaseService(
    mockReleaseRepository as never,
    mockInstanceRepository as never,
    mockEventEmitter as never,
    mockClsService as never,
  );

describe('ServiceReleaseService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockClsService.get.mockReturnValue(undefined);
  });

  describe('registerInstance', () => {
    it('creates a first-seen release and broadcasts exactly one ResourceCreated', async () => {
      const created = makeReleaseEntity();
      mockReleaseRepository.findAll.mockResolvedValue([]);
      mockReleaseRepository.create.mockResolvedValue(created);
      mockInstanceRepository.findAll.mockResolvedValue([]);
      mockInstanceRepository.create.mockResolvedValue(makeInstanceEntity());

      const response = await createService().registerInstance(REGISTER_INPUT);

      expect(mockReleaseRepository.create).toHaveBeenCalledTimes(1);
      expect(response.version).toBe('2.1.0');
      expect(response.serviceName).toBe('smr');

      const createdEvents = mockEventEmitter.emit.mock.calls.filter(([type]) => type === SysEventType.ResourceCreated);
      expect(createdEvents).toHaveLength(1);
      expect(mockEventEmitter.emit).toHaveBeenCalledTimes(1);
    });

    it('is idempotent: a repeated (service, sha, tag) creates no second release row', async () => {
      const existing = makeReleaseEntity();
      mockReleaseRepository.findAll.mockResolvedValue([existing]);
      mockInstanceRepository.findAll.mockResolvedValue([makeInstanceEntity()]);
      mockInstanceRepository.update.mockImplementation((_id, entity) => Promise.resolve(entity));

      await createService().registerInstance(REGISTER_INPUT);

      expect(mockReleaseRepository.create).not.toHaveBeenCalled();
    });

    it('a heartbeat updates lastSeenAt and NOTHING else', async () => {
      const existing = makeReleaseEntity();
      const instance = makeInstanceEntity();
      mockReleaseRepository.findAll.mockResolvedValue([existing]);
      mockInstanceRepository.findAll.mockResolvedValue([instance]);
      mockInstanceRepository.update.mockImplementation((_id, entity) => Promise.resolve(entity));

      await createService().registerInstance({ ...REGISTER_INPUT, instanceId: 'smr-7c9d-abcde' });

      expect(mockInstanceRepository.create).not.toHaveBeenCalled();
      expect(mockInstanceRepository.update).toHaveBeenCalledTimes(1);
      const [, updatedEntity] = mockInstanceRepository.update.mock.calls[0];
      expect(Object.keys((updatedEntity as { changes: Record<string, unknown> }).changes)).toEqual(['lastSeenAt']);
    });

    it('re-points the instance and resets startedAt when the release differs (StatefulSet rollout)', async () => {
      // A StatefulSet keeps stable pod names (`stt-0`) across rollouts, so the
      // same instance identity legitimately comes back on a NEW release. It
      // must not keep reporting the old version forever.
      const newRelease = makeReleaseEntity({ id: 'release-new' });
      const originalStartedAt = new Date('2026-08-01T10:05:00.000Z');
      const instance = makeInstanceEntity({ releaseId: 'release-old', startedAt: originalStartedAt });
      mockReleaseRepository.findAll.mockResolvedValue([newRelease]);
      mockInstanceRepository.findAll.mockResolvedValue([instance]);
      mockInstanceRepository.update.mockImplementation((_id, entity) => Promise.resolve(entity));

      await createService().registerInstance(REGISTER_INPUT);

      expect(mockInstanceRepository.create).not.toHaveBeenCalled();
      const [, updatedEntity] = mockInstanceRepository.update.mock.calls[0];
      const updated = updatedEntity as { changes: Record<string, unknown>; releaseId: string; startedAt: Date };
      expect(Object.keys(updated.changes).sort()).toEqual(['lastSeenAt', 'releaseId', 'startedAt']);
      expect(updated.releaseId).toBe('release-new');
      expect(updated.startedAt.getTime()).toBeGreaterThan(originalStartedAt.getTime());
      // Re-pointing a runtime observation is still not audit-worthy; only a
      // first-seen RELEASE is, and this release was already known.
      expect(mockEventEmitter.emit).not.toHaveBeenCalled();
    });

    it('leaves startedAt untouched on a same-release heartbeat', async () => {
      const originalStartedAt = new Date('2026-08-01T10:05:00.000Z');
      const instance = makeInstanceEntity({ releaseId: 'release-1', startedAt: originalStartedAt });
      mockReleaseRepository.findAll.mockResolvedValue([makeReleaseEntity({ id: 'release-1' })]);
      mockInstanceRepository.findAll.mockResolvedValue([instance]);
      mockInstanceRepository.update.mockImplementation((_id, entity) => Promise.resolve(entity));

      await createService().registerInstance(REGISTER_INPUT);

      const [, updatedEntity] = mockInstanceRepository.update.mock.calls[0];
      const updated = updatedEntity as { changes: Record<string, unknown>; startedAt: Date };
      expect(Object.keys(updated.changes)).toEqual(['lastSeenAt']);
      expect(updated.startedAt).toBe(originalStartedAt);
    });

    it('a heartbeat broadcasts NO sys-event', async () => {
      mockReleaseRepository.findAll.mockResolvedValue([makeReleaseEntity()]);
      mockInstanceRepository.findAll.mockResolvedValue([makeInstanceEntity()]);
      mockInstanceRepository.update.mockImplementation((_id, entity) => Promise.resolve(entity));

      await createService().registerInstance(REGISTER_INPUT);

      expect(mockEventEmitter.emit).not.toHaveBeenCalled();
    });

    it('a new instance of a known release broadcasts no sys-event either', async () => {
      mockReleaseRepository.findAll.mockResolvedValue([makeReleaseEntity()]);
      mockInstanceRepository.findAll.mockResolvedValue([]);
      mockInstanceRepository.create.mockResolvedValue(makeInstanceEntity());

      await createService().registerInstance(REGISTER_INPUT);

      expect(mockInstanceRepository.create).toHaveBeenCalledTimes(1);
      expect(mockEventEmitter.emit).not.toHaveBeenCalled();
    });

    it('recovers from a concurrent create losing the unique-constraint race', async () => {
      const winner = makeReleaseEntity({ id: 'release-winner' });
      mockReleaseRepository.findAll.mockResolvedValueOnce([]).mockResolvedValueOnce([winner]);
      mockReleaseRepository.create.mockRejectedValue(new Error('Unique constraint failed'));
      mockInstanceRepository.findAll.mockResolvedValue([]);
      mockInstanceRepository.create.mockResolvedValue(makeInstanceEntity({ releaseId: 'release-winner' }));

      const response = await createService().registerInstance(REGISTER_INPUT);

      expect(response.id).toBe('release-winner');
      // The loser of the race did NOT create a row, so it must not claim one.
      expect(mockEventEmitter.emit).not.toHaveBeenCalled();
    });
  });

  describe('attachDigest', () => {
    const DIGEST_INPUT = {
      service: 'smr',
      gitCommitSha: 'a'.repeat(40),
      imageRepository: 'registry/hope/smr',
      imageDigest: `sha256:${'b'.repeat(64)}`,
    };

    it('throws rather than creating a row when no release matches', async () => {
      mockReleaseRepository.findAll.mockResolvedValue([]);

      await expect(createService().attachDigest(DIGEST_INPUT)).rejects.toBeInstanceOf(DataNotFoundException);
      expect(mockReleaseRepository.create).not.toHaveBeenCalled();
    });

    it('attaches the digest to an existing release', async () => {
      const existing = makeReleaseEntity();
      mockReleaseRepository.findAll.mockResolvedValue([existing]);
      mockReleaseRepository.update.mockImplementation((_id, entity) => Promise.resolve(entity));

      const response = await createService().attachDigest(DIGEST_INPUT);

      expect(mockReleaseRepository.update).toHaveBeenCalledTimes(1);
      expect(response.imageDigest).toBe(DIGEST_INPUT.imageDigest);
    });

    it('is idempotent: re-attaching the same digest writes nothing', async () => {
      const existing = makeReleaseEntity({ imageDigest: DIGEST_INPUT.imageDigest, imageRepository: DIGEST_INPUT.imageRepository });
      mockReleaseRepository.findAll.mockResolvedValue([existing]);

      await createService().attachDigest(DIGEST_INPUT);

      expect(mockReleaseRepository.update).not.toHaveBeenCalled();
      expect(mockEventEmitter.emit).not.toHaveBeenCalled();
    });
  });

  describe('listCurrent', () => {
    it('reports live at 14m59s and stale at 15m01s past the threshold boundary', async () => {
      const now = Date.now();
      const liveInstance = makeInstanceEntity({
        id: 'i-live',
        serviceName: 'smr',
        lastSeenAt: new Date(now - (INSTANCE_LIVENESS_THRESHOLD_MS - 1_000)),
      });
      const staleInstance = makeInstanceEntity({
        id: 'i-stale',
        serviceName: 'stt',
        releaseId: 'release-2',
        lastSeenAt: new Date(now - (INSTANCE_LIVENESS_THRESHOLD_MS + 1_000)),
      });
      mockInstanceRepository.findAll.mockResolvedValue([liveInstance, staleInstance]);
      mockReleaseRepository.findAll.mockResolvedValue([makeReleaseEntity(), makeReleaseEntity({ id: 'release-2', serviceName: 'stt' })]);

      const rows = await createService().listCurrent('dev');

      expect(rows.find((row) => row.serviceName === 'smr')?.liveness).toBe('live');
      expect(rows.find((row) => row.serviceName === 'stt')?.liveness).toBe('stale');
    });

    it('counts only live instances of a service', async () => {
      const now = Date.now();
      mockInstanceRepository.findAll.mockResolvedValue([
        makeInstanceEntity({ id: 'i-1', lastSeenAt: new Date(now - 1_000) }),
        makeInstanceEntity({ id: 'i-2', lastSeenAt: new Date(now - 2_000) }),
        makeInstanceEntity({ id: 'i-3', lastSeenAt: new Date(now - (INSTANCE_LIVENESS_THRESHOLD_MS + 60_000)) }),
      ]);
      mockReleaseRepository.findAll.mockResolvedValue([makeReleaseEntity()]);

      const rows = await createService().listCurrent('dev');

      expect(rows).toHaveLength(1);
      expect(rows[0].instanceCount).toBe(2);
      expect(rows[0].release.version).toBe('2.1.0');
    });
  });

  describe('listReleases', () => {
    it('returns a paginated envelope, newest build first', async () => {
      mockReleaseRepository.findAll.mockResolvedValue([makeReleaseEntity()]);
      mockReleaseRepository.count.mockResolvedValue(1);

      const result = await createService().listReleases({ page: 1, limit: 25 });

      expect(result.count).toBe(1);
      expect(result.data).toHaveLength(1);
      const [props] = mockReleaseRepository.findAll.mock.calls[0];
      expect((props as { sort?: unknown }).sort).toEqual([{ buildAt: 'desc' }]);
    });
  });

  describe('getHistory', () => {
    it('returns the timeline newest first', async () => {
      mockReleaseRepository.findAll.mockResolvedValue([makeReleaseEntity({ id: 'r2' }), makeReleaseEntity({ id: 'r1' })]);

      const rows = await createService().getHistory('smr');

      expect(rows.map((row) => row.id)).toEqual(['r2', 'r1']);
    });

    it('throws for an unknown service', async () => {
      mockReleaseRepository.findAll.mockResolvedValue([]);

      await expect(createService().getHistory('nope')).rejects.toBeInstanceOf(DataNotFoundException);
    });
  });
});
