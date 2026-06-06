/**
 * EvalService unit tests (TASK-330 Phase 0).
 *
 * The service is a thin data-layer orchestrator: it builds entities via the
 * domain factories and persists them through the repositories. Tests mock the
 * repositories (echoing the entity back from `create`) and assert the resulting
 * entity carries the expected fields + that the right repository was called.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EvalService } from '../eval.service';

// Each repository gets its OWN echoing `create` mock so per-repo call counts
// are independent (a shared fn would conflate counts across repositories).
const echo = async (entity: unknown) => entity;

const mockGoldenSetRepository = { create: vi.fn(echo), findById: vi.fn(), findAll: vi.fn() };
const mockGoldenCaseRepository = { create: vi.fn(echo), findById: vi.fn(), findAll: vi.fn(), getByGoldenSet: vi.fn() };
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
});
