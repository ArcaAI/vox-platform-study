/**
 * HarnessAuditService unit tests (TASK-330 Phase 0).
 *
 * Verifies the append-only write computes the hash chain correctly (genesis
 * anchor for the first event, prevHash → previous hash thereafter) and that
 * `verifyChain` maps persisted events back to chain records and detects
 * tampering. Repositories are mocked; the real domain factory + hash helper run.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GENESIS_PREV_HASH, HarnessAuditAction, HarnessAuditEventFactory } from '@arcaai/domains';
import { HarnessAuditService } from '../harness-audit.service';

const mockRepository = {
  create: vi.fn(async (entity) => entity),
  getLatestForTenant: vi.fn(),
  getChainForTenant: vi.fn(),
  getByConsultation: vi.fn(),
};

const baseInput = () => ({
  tenantId: 'tenant-1',
  consultationId: 'consult-1',
  action: HarnessAuditAction.GENERATE,
  modelName: 'gpt-x',
  modelVersion: 'v1',
  sensorScores: { faithfulness: 0.9 },
  citations: [{ id: 'c1' }],
});

/** Read an entity's chain-relevant fields into a plain record (for tampering). */
const pick = (e: any) => ({
  tenantId: e.tenantId,
  consultationId: e.consultationId,
  contextItemVersionId: e.contextItemVersionId ?? null,
  action: e.action,
  modelName: e.modelName,
  modelVersion: e.modelVersion,
  promptTemplateId: e.promptTemplateId ?? null,
  promptVersion: e.promptVersion ?? null,
  sensorScores: e.sensorScores,
  citations: e.citations,
  gateDecision: e.gateDecision ?? null,
  clinicianId: e.clinicianId ?? null,
  attestationHash: e.attestationHash ?? null,
  createdAt: e.createdAt,
  prevHash: e.prevHash,
  hash: e.hash,
});

describe('HarnessAuditService', () => {
  let service: HarnessAuditService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new HarnessAuditService(mockRepository as any);
  });

  describe('append', () => {
    it('anchors the first event for a tenant to the genesis prevHash', async () => {
      mockRepository.getLatestForTenant.mockResolvedValue(null);

      const event = await service.append(baseInput());

      expect(event.prevHash).toBe(GENESIS_PREV_HASH);
      expect(event.hash).toMatch(/^[0-9a-f]{64}$/);
      expect(mockRepository.getLatestForTenant).toHaveBeenCalledWith('tenant-1');
      expect(mockRepository.create).toHaveBeenCalledWith(event);
    });

    it('links a subsequent event to the previous event hash', async () => {
      const previous = HarnessAuditEventFactory.CreateHarnessAuditEvent(baseInput());
      mockRepository.getLatestForTenant.mockResolvedValue(previous);

      const event = await service.append({ ...baseInput(), action: HarnessAuditAction.ATTEST });

      expect(event.prevHash).toBe(previous.hash);
      expect(event.hash).not.toBe(previous.hash);
    });
  });

  describe('verifyChain', () => {
    it('returns valid for a correctly linked chain', async () => {
      const e1 = HarnessAuditEventFactory.CreateHarnessAuditEvent(baseInput());
      const e2 = HarnessAuditEventFactory.CreateHarnessAuditEvent({
        ...baseInput(),
        action: HarnessAuditAction.ATTEST,
        prevHash: e1.hash,
      });
      mockRepository.getChainForTenant.mockResolvedValue([e1, e2]);

      const result = await service.verifyChain('tenant-1');

      expect(result.valid).toBe(true);
      expect(result.brokenAtIndex).toBeNull();
      expect(mockRepository.getChainForTenant).toHaveBeenCalledWith('tenant-1');
    });

    it('detects a tampered event whose stored hash no longer matches its fields', async () => {
      const e1 = HarnessAuditEventFactory.CreateHarnessAuditEvent(baseInput());
      const e2 = HarnessAuditEventFactory.CreateHarnessAuditEvent({ ...baseInput(), prevHash: e1.hash });
      // Persisted row edited in place (modelName) but the stored hash is the
      // original — exactly what the WORM REVOKE is meant to prevent.
      const tampered = { ...pick(e2), modelName: 'malicious-model' };
      mockRepository.getChainForTenant.mockResolvedValue([e1, tampered]);

      const result = await service.verifyChain('tenant-1');

      expect(result.valid).toBe(false);
      expect(result.brokenAtIndex).toBe(1);
    });

    it('returns valid for an empty chain', async () => {
      mockRepository.getChainForTenant.mockResolvedValue([]);
      const result = await service.verifyChain('tenant-1');
      expect(result.valid).toBe(true);
    });
  });
});
