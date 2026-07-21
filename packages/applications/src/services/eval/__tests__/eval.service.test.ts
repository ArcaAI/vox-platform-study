/**
 * EvalService unit tests.
 *
 * The service is a thin data-layer orchestrator: it builds entities via the
 * domain factories and persists them through the repositories. Tests mock the
 * repositories (echoing the entity back from `create`) and assert the resulting
 * entity carries the expected fields + that the right repository was called.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DataNotFoundException } from '@arcaai/exceptions';
import { EvalService } from '../eval.service';

// Each repository gets its OWN echoing `create` mock so per-repo call counts
// are independent (a shared fn would conflate counts across repositories).
const echo = async (entity: unknown) => entity;

const mockGoldenSetRepository = { create: vi.fn(echo), findById: vi.fn(), findAll: vi.fn(), count: vi.fn() };
const mockGoldenCaseRepository = { create: vi.fn(echo), findById: vi.fn(), findAll: vi.fn(), getByGoldenSet: vi.fn(), count: vi.fn() };
const mockEvalRunRepository = { create: vi.fn(echo), findById: vi.fn(), findAll: vi.fn(), getByGoldenSet: vi.fn() };
const mockEvalScoreRepository = { create: vi.fn(echo), findById: vi.fn(), findAll: vi.fn(), getByEvalRun: vi.fn() };

describe('EvalService', () => {
  let service: EvalService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new EvalService(
      mockGoldenSetRepository as any,
      mockGoldenCaseRepository as any,
      mockEvalRunRepository as any,
      mockEvalScoreRepository as any,
    );
  });

  describe('createGoldenSet', () => {
    it('builds and persists a golden set scoped to the tenant', async () => {
      const result = await service.createGoldenSet({
        tenantId: 'tenant-1',
        name: 'GI golden set',
        description: 'gold pairs',
      });

      expect(result.tenantId).toBe('tenant-1');
      expect(result.name).toBe('GI golden set');
      expect(result.description).toBe('gold pairs');
      expect(result.id).toBeTruthy();
      expect(mockGoldenSetRepository.create).toHaveBeenCalledTimes(1);
      expect(mockGoldenSetRepository.create).toHaveBeenCalledWith(result);
    });
  });

  describe('createGoldenCase', () => {
    it('builds and persists a golden case under a golden set', async () => {
      const result = await service.createGoldenCase({
        tenantId: 'tenant-1',
        goldenSetId: 'set-1',
        transcript: 'patient reports headache',
        referenceNote: 'HPI: headache x2 days',
        label: 'case-a',
      });

      expect(result.tenantId).toBe('tenant-1');
      expect(result.goldenSetId).toBe('set-1');
      expect(result.transcript).toBe('patient reports headache');
      expect(result.referenceNote).toBe('HPI: headache x2 days');
      expect(result.label).toBe('case-a');
      expect(mockGoldenCaseRepository.create).toHaveBeenCalledWith(result);
    });
  });

  describe('recordEvalRun', () => {
    it('builds and persists an eval run', async () => {
      const result = await service.recordEvalRun({
        tenantId: 'tenant-1',
        goldenSetId: 'set-1',
        modelName: 'gpt-x',
        modelVersion: 'v2',
        judgeModel: 'judge-1',
        status: 'COMPLETED',
        aggregateScores: { faithfulness: 0.92 },
      });

      expect(result.tenantId).toBe('tenant-1');
      expect(result.goldenSetId).toBe('set-1');
      expect(result.modelName).toBe('gpt-x');
      expect(result.modelVersion).toBe('v2');
      expect(result.judgeModel).toBe('judge-1');
      expect(result.status).toBe('COMPLETED');
      expect(mockEvalRunRepository.create).toHaveBeenCalledWith(result);
    });
  });

  describe('recordEvalScore', () => {
    it('builds and persists a single metric score', async () => {
      const result = await service.recordEvalScore({
        tenantId: 'tenant-1',
        evalRunId: 'run-1',
        goldenCaseId: 'case-1',
        metric: 'faithfulness',
        score: 0.9,
        maxScore: 1,
      });

      expect(result.tenantId).toBe('tenant-1');
      expect(result.evalRunId).toBe('run-1');
      expect(result.goldenCaseId).toBe('case-1');
      expect(result.metric).toBe('faithfulness');
      expect(result.score).toBe(0.9);
      expect(result.maxScore).toBe(1);
      expect(mockEvalScoreRepository.create).toHaveBeenCalledWith(result);
    });
  });

  describe('recordEvalRunWithScores', () => {
    it('persists the run then a score per case, all linked to the run', async () => {
      const { run, scores } = await service.recordEvalRunWithScores(
        { tenantId: 'tenant-1', goldenSetId: 'set-1', modelName: 'gpt-x' },
        [
          { goldenCaseId: 'case-1', metric: 'faithfulness', score: 0.9 },
          { goldenCaseId: 'case-2', metric: 'coverage', score: 0.8 },
        ],
      );

      expect(mockEvalRunRepository.create).toHaveBeenCalledTimes(1);
      expect(mockEvalScoreRepository.create).toHaveBeenCalledTimes(2);
      expect(scores).toHaveLength(2);
      // every score is linked to the created run + same tenant
      for (const score of scores) {
        expect(score.evalRunId).toBe(run.id);
        expect(score.tenantId).toBe('tenant-1');
      }
      expect(scores[0].metric).toBe('faithfulness');
      expect(scores[1].metric).toBe('coverage');
    });
  });

  // ===========================================================================
  // Read projections for the /admin/harness golden-set
  // surface. Mirrors HarnessObservabilityService.listEvalRuns: repository
  // count + findAll pinned to the tenant, newest-first, {items,total}.
  // ===========================================================================
  const goldenSetRow = {
    id: 'set-1',
    tenantId: 'tenant-1',
    name: 'GI golden set',
    description: 'gold pairs',
    pinnedVersion: null,
    createdAt: new Date('2026-07-01T00:00:00.000Z'),
    updatedAt: new Date('2026-07-02T00:00:00.000Z'),
    createdBy: 'user-1',
  };

  const goldenCaseRow = {
    id: 'case-1',
    tenantId: 'tenant-1',
    goldenSetId: 'set-1',
    label: 'case-a',
    transcript: 'patient reports headache', // PHI — must NOT surface in the projection
    referenceNote: 'HPI: headache x2 days', // PHI — must NOT surface in the projection
    createdAt: new Date('2026-07-01T00:00:00.000Z'),
    updatedAt: new Date('2026-07-01T00:00:00.000Z'),
    createdBy: 'user-1',
  };

  describe('listGoldenSets (TASK-419 item 1)', () => {
    it('pages the tenant golden sets newest-first and returns {items,total}', async () => {
      mockGoldenSetRepository.count.mockResolvedValue(7);
      mockGoldenSetRepository.findAll.mockResolvedValue([goldenSetRow]);

      const result = await service.listGoldenSets('tenant-1', { page: 2, limit: 5 });

      expect(mockGoldenSetRepository.count).toHaveBeenCalledWith({ filters: { tenantId: 'tenant-1' } });
      expect(mockGoldenSetRepository.findAll).toHaveBeenCalledWith({
        filters: { tenantId: 'tenant-1' },
        sort: [{ createdAt: 'desc' }],
        page: 2,
        limit: 5,
      });
      expect(result.total).toBe(7);
      expect(result.items).toEqual([
        {
          id: 'set-1',
          tenantId: 'tenant-1',
          name: 'GI golden set',
          description: 'gold pairs',
          pinnedVersion: null,
          createdAt: '2026-07-01T00:00:00.000Z',
          updatedAt: '2026-07-02T00:00:00.000Z',
          createdBy: 'user-1',
        },
      ]);
    });
  });

  describe('getGoldenSet (TASK-419 item 1)', () => {
    it('returns the mapped set when found for the tenant', async () => {
      mockGoldenSetRepository.findAll.mockResolvedValue([goldenSetRow]);

      const result = await service.getGoldenSet('tenant-1', 'set-1');

      expect(mockGoldenSetRepository.findAll).toHaveBeenCalledWith({ filters: { tenantId: 'tenant-1', id: 'set-1' }, limit: 1 });
      expect(result.id).toBe('set-1');
      expect(result.name).toBe('GI golden set');
    });

    it('throws DataNotFoundException when the set does not exist for the tenant (404-over-403)', async () => {
      mockGoldenSetRepository.findAll.mockResolvedValue([]);

      await expect(service.getGoldenSet('tenant-1', 'missing')).rejects.toThrow(DataNotFoundException);
    });
  });

  describe('listGoldenCases (TASK-419 item 1)', () => {
    it('lists PHI-SAFE case metadata (never transcript/referenceNote) for an existing set', async () => {
      mockGoldenSetRepository.findAll.mockResolvedValue([goldenSetRow]);
      mockGoldenCaseRepository.count.mockResolvedValue(1);
      mockGoldenCaseRepository.findAll.mockResolvedValue([goldenCaseRow]);

      const result = await service.listGoldenCases('tenant-1', 'set-1', {});

      expect(mockGoldenCaseRepository.count).toHaveBeenCalledWith({ filters: { tenantId: 'tenant-1', goldenSetId: 'set-1' } });
      expect(result.total).toBe(1);
      expect(result.items[0]).toEqual({
        id: 'case-1',
        tenantId: 'tenant-1',
        goldenSetId: 'set-1',
        label: 'case-a',
        createdAt: '2026-07-01T00:00:00.000Z',
        updatedAt: '2026-07-01T00:00:00.000Z',
        createdBy: 'user-1',
      });
      // The projection must not carry the PHI columns under ANY key.
      expect(JSON.stringify(result)).not.toContain('headache');
    });

    it('throws DataNotFoundException when the parent set is missing (no cross-tenant probe)', async () => {
      mockGoldenSetRepository.findAll.mockResolvedValue([]);

      await expect(service.listGoldenCases('tenant-1', 'missing', {})).rejects.toThrow(DataNotFoundException);
      expect(mockGoldenCaseRepository.findAll).not.toHaveBeenCalled();
    });
  });

  describe('addGoldenSet (TASK-419 item 1)', () => {
    it('creates the set and returns the response projection (not the entity)', async () => {
      const result = await service.addGoldenSet({ tenantId: 'tenant-1', name: 'GI golden set', description: 'gold pairs' });

      expect(mockGoldenSetRepository.create).toHaveBeenCalledTimes(1);
      expect(result.name).toBe('GI golden set');
      expect(result.tenantId).toBe('tenant-1');
      expect(typeof result.createdAt).toBe('string'); // ISO string ⇒ projected, not the raw entity
    });
  });

  describe('addGoldenCase (TASK-419 item 1)', () => {
    it('verifies the parent set exists, creates the case, and returns PHI-safe metadata only', async () => {
      mockGoldenSetRepository.findAll.mockResolvedValue([goldenSetRow]);

      const result = await service.addGoldenCase({
        tenantId: 'tenant-1',
        goldenSetId: 'set-1',
        transcript: 'patient reports headache',
        referenceNote: 'HPI: headache x2 days',
        label: 'case-a',
      });

      expect(mockGoldenCaseRepository.create).toHaveBeenCalledTimes(1);
      expect(result.goldenSetId).toBe('set-1');
      expect(result.label).toBe('case-a');
      expect(JSON.stringify(result)).not.toContain('headache'); // PHI never echoed back
    });

    it('throws DataNotFoundException (no create) when the parent set is missing for the tenant', async () => {
      mockGoldenSetRepository.findAll.mockResolvedValue([]);

      await expect(
        service.addGoldenCase({ tenantId: 'tenant-1', goldenSetId: 'missing', transcript: 't', referenceNote: 'r' }),
      ).rejects.toThrow(DataNotFoundException);
      expect(mockGoldenCaseRepository.create).not.toHaveBeenCalled();
    });
  });
});
