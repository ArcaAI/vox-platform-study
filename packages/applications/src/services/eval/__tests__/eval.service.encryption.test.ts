/**
 * EvalService encryption wiring (TASK-369 Phase 3C).
 *
 * Verifies the encrypt-on-write contract for the three eval models that carry
 * free-text clinical content (GoldenCase transcript/referenceNote, EvalRun
 * notes, EvalScore rationale/details):
 *   - `encryptFieldsIntoEntity` is invoked with the freshly built entity BEFORE
 *     it is persisted (so the ciphertext columns land on the first write);
 *   - encryption is best-effort in soft mode — a Vault failure must NOT block the
 *     write (the row still persists, just without the PHI ciphertext);
 *   - when no SecretsService is wired the encrypt helper is never called.
 *
 * Repositories + SecretsService are fully mocked; no DB or Vault is touched.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EvalService } from '../eval.service';

const echo = async (entity: unknown) => entity;

const mockGoldenSetRepository = { create: vi.fn(echo) };
const mockGoldenCaseRepository = { create: vi.fn(echo), encryptFieldsIntoEntity: vi.fn(async () => undefined) };
const mockEvalRunRepository = { create: vi.fn(echo), encryptFieldsIntoEntity: vi.fn(async () => undefined) };
const mockEvalScoreRepository = { create: vi.fn(echo), encryptFieldsIntoEntity: vi.fn(async () => undefined) };

const mockSecretsService = { encrypt: vi.fn(), decrypt: vi.fn() };

function buildService(withSecrets: boolean): EvalService {
  return new EvalService(
    mockGoldenSetRepository as never,
    mockGoldenCaseRepository as never,
    mockEvalRunRepository as never,
    mockEvalScoreRepository as never,
    withSecrets ? (mockSecretsService as never) : undefined,
  );
}

describe('EvalService — TASK-369 field encryption', () => {
  beforeEach(() => vi.clearAllMocks());

  describe('createGoldenCase', () => {
    it('encrypts the golden case BEFORE persisting it', async () => {
      const service = buildService(true);
      const result = await service.createGoldenCase({
        tenantId: 'tenant-1',
        goldenSetId: 'set-1',
        transcript: 'patient reports chest pain',
        referenceNote: 'HPI: chest pain x1 day',
      });

      expect(mockGoldenCaseRepository.encryptFieldsIntoEntity).toHaveBeenCalledTimes(1);
      expect(mockGoldenCaseRepository.encryptFieldsIntoEntity).toHaveBeenCalledWith(result, mockSecretsService);
      expect(mockGoldenCaseRepository.create).toHaveBeenCalledWith(result);
      // encrypt must run before persist
      expect(mockGoldenCaseRepository.encryptFieldsIntoEntity.mock.invocationCallOrder[0]).toBeLessThan(
        mockGoldenCaseRepository.create.mock.invocationCallOrder[0],
      );
    });

    it('still persists when encryption fails (dual-write soak)', async () => {
      mockGoldenCaseRepository.encryptFieldsIntoEntity.mockRejectedValueOnce(new Error('vault down'));
      const service = buildService(true);

      const result = await service.createGoldenCase({
        tenantId: 'tenant-1',
        goldenSetId: 'set-1',
        transcript: 'x',
        referenceNote: 'y',
      });

      expect(result).toBeTruthy();
      expect(mockGoldenCaseRepository.create).toHaveBeenCalledTimes(1);
    });

    it('does NOT encrypt when no SecretsService is wired', async () => {
      const service = buildService(false);
      await service.createGoldenCase({ tenantId: 't', goldenSetId: 's', transcript: 'x', referenceNote: 'y' });
      expect(mockGoldenCaseRepository.encryptFieldsIntoEntity).not.toHaveBeenCalled();
      expect(mockGoldenCaseRepository.create).toHaveBeenCalledTimes(1);
    });
  });

  describe('recordEvalRun', () => {
    it('encrypts the run BEFORE persisting it', async () => {
      const service = buildService(true);
      const result = await service.recordEvalRun({
        tenantId: 'tenant-1',
        goldenSetId: 'set-1',
        modelName: 'gpt-x',
        notes: 'reviewer note with PHI hint',
      });

      expect(mockEvalRunRepository.encryptFieldsIntoEntity).toHaveBeenCalledWith(result, mockSecretsService);
      expect(mockEvalRunRepository.encryptFieldsIntoEntity.mock.invocationCallOrder[0]).toBeLessThan(
        mockEvalRunRepository.create.mock.invocationCallOrder[0],
      );
    });
  });

  describe('recordEvalScore', () => {
    it('encrypts the score BEFORE persisting it', async () => {
      const service = buildService(true);
      const result = await service.recordEvalScore({
        tenantId: 'tenant-1',
        evalRunId: 'run-1',
        goldenCaseId: 'case-1',
        metric: 'faithfulness',
        score: 0.9,
        rationale: 'rationale text',
        details: { spans: ['a'] },
      });

      expect(mockEvalScoreRepository.encryptFieldsIntoEntity).toHaveBeenCalledWith(result, mockSecretsService);
      expect(mockEvalScoreRepository.encryptFieldsIntoEntity.mock.invocationCallOrder[0]).toBeLessThan(
        mockEvalScoreRepository.create.mock.invocationCallOrder[0],
      );
    });
  });

  describe('recordEvalRunWithScores', () => {
    it('encrypts the run and every score before persisting', async () => {
      const service = buildService(true);
      await service.recordEvalRunWithScores(
        { tenantId: 'tenant-1', goldenSetId: 'set-1', modelName: 'gpt-x', notes: 'n' },
        [
          { goldenCaseId: 'case-1', metric: 'faithfulness', score: 0.9, rationale: 'r1' },
          { goldenCaseId: 'case-2', metric: 'coverage', score: 0.8, rationale: 'r2' },
        ],
      );

      expect(mockEvalRunRepository.encryptFieldsIntoEntity).toHaveBeenCalledTimes(1);
      expect(mockEvalScoreRepository.encryptFieldsIntoEntity).toHaveBeenCalledTimes(2);
    });
  });
});
