/**
 * HarnessObservabilityService unit tests (TASK-330 Phase 6 — Phase A).
 *
 *  - listAuditEvents pages newest-first, filters by consultation, and reports a
 *    chain-global integrity verdict computed from REAL hash-chained events.
 *  - listEvalRuns / getEvalRun project EvalRun (+ EvalScore) and 404 on miss.
 *  - gateQueue computes SLA/escalation from the effective policy timers, clocks
 *    each item from its latest GENERATE event, and tags the policy source.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GENESIS_PREV_HASH, HarnessAuditAction, HarnessAuditEventFactory, HarnessPolicyFactory } from '@arcaai/domains';
import { DataNotFoundException } from '@arcaai/exceptions';
import { HarnessObservabilityService } from '../harness-observability.service';

const TENANT = 'tenant-1';

const auditRepository = { getChainForTenant: vi.fn() };
const evalRunRepository = { count: vi.fn(), findAll: vi.fn() };
const evalScoreRepository = { getByEvalRun: vi.fn() };
const consultationRepository = { findPendingReviewForTenant: vi.fn() };
const policyRepository = { findActiveForTenant: vi.fn() };

function makeService(): HarnessObservabilityService {
  return new HarnessObservabilityService(
    auditRepository as never,
    evalRunRepository as never,
    evalScoreRepository as never,
    consultationRepository as never,
    policyRepository as never,
  );
}

/** Build a valid 3-event chain: c1 GENERATE → c1 GATE_DECISION → c2 GENERATE. */
function buildChain() {
  const base = { tenantId: TENANT, modelName: 'gpt', modelVersion: '1', sensorScores: {}, citations: [] };
  const e1 = HarnessAuditEventFactory.CreateHarnessAuditEvent({ ...base, consultationId: 'c1', action: HarnessAuditAction.GENERATE, prevHash: GENESIS_PREV_HASH });
  const e2 = HarnessAuditEventFactory.CreateHarnessAuditEvent({ ...base, consultationId: 'c1', action: HarnessAuditAction.GATE_DECISION, gateDecision: 'APPROVE', prevHash: e1.hash });
  const e3 = HarnessAuditEventFactory.CreateHarnessAuditEvent({ ...base, consultationId: 'c2', action: HarnessAuditAction.GENERATE, prevHash: e2.hash });
  return [e1, e2, e3];
}

describe('HarnessObservabilityService', () => {
  let service: HarnessObservabilityService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = makeService();
  });

  describe('listAuditEvents', () => {
    it('returns events newest-first with a valid chain verdict and full-chain total', async () => {
      const [e1, e2, e3] = buildChain();
      auditRepository.getChainForTenant.mockResolvedValue([e1, e2, e3]);

      const result = await service.listAuditEvents(TENANT);

      expect(result.total).toBe(3);
      expect(result.verification.valid).toBe(true);
      expect(result.verification.brokenAtIndex).toBeNull();
      // Newest-first (chain is oldest→newest).
      expect(result.items.map((i) => i.id)).toEqual([e3.id, e2.id, e1.id]);
      expect(result.items[0].action).toBe(HarnessAuditAction.GENERATE);
    });

    it('narrows to a single consultation when consultationId is supplied', async () => {
      const [e1, e2, e3] = buildChain();
      auditRepository.getChainForTenant.mockResolvedValue([e1, e2, e3]);

      const result = await service.listAuditEvents(TENANT, { consultationId: 'c1' });

      expect(result.total).toBe(2);
      expect(result.items.map((i) => i.id)).toEqual([e2.id, e1.id]);
    });

    it('detects a tampered chain', async () => {
      const [e1, e2, e3] = buildChain();
      // Splice: drop e2 so e3.prevHash no longer links.
      auditRepository.getChainForTenant.mockResolvedValue([e1, e3]);

      const result = await service.listAuditEvents(TENANT);

      expect(result.verification.valid).toBe(false);
      expect(result.verification.brokenAtIndex).toBe(1);
    });
  });

  describe('listEvalRuns / getEvalRun', () => {
    const run = {
      id: 'run-1',
      tenantId: TENANT,
      goldenSetId: 'gs-1',
      modelName: 'gpt',
      modelVersion: '1',
      judgeModel: 'judge',
      status: 'COMPLETED',
      startedAt: new Date('2026-01-01T00:00:00Z'),
      completedAt: new Date('2026-01-01T01:00:00Z'),
      aggregateScores: { overall: 0.9 },
      notes: null,
      createdAt: new Date('2026-01-01T00:00:00Z'),
      updatedAt: new Date('2026-01-01T01:00:00Z'),
    };

    it('lists eval runs with a total count', async () => {
      evalRunRepository.count.mockResolvedValue(3);
      evalRunRepository.findAll.mockResolvedValue([run]);

      const result = await service.listEvalRuns(TENANT, { page: 1, limit: 20 });

      expect(result.total).toBe(3);
      expect(result.items).toHaveLength(1);
      expect(result.items[0].id).toBe('run-1');
      expect(result.items[0].startedAt).toBe('2026-01-01T00:00:00.000Z');
    });

    it('returns a run with its per-case scores', async () => {
      evalRunRepository.findAll.mockResolvedValue([run]);
      evalScoreRepository.getByEvalRun.mockResolvedValue([
        { id: 's1', tenantId: TENANT, evalRunId: 'run-1', goldenCaseId: 'gc1', metric: 'pdsqi', score: 4, maxScore: 5, rationale: 'ok', judgeModel: 'judge', details: null, createdAt: new Date('2026-01-01T00:30:00Z') },
      ]);

      const result = await service.getEvalRun(TENANT, 'run-1');

      expect(result.id).toBe('run-1');
      expect(result.scores).toHaveLength(1);
      expect(result.scores[0].metric).toBe('pdsqi');
      expect(result.scores[0].score).toBe(4);
    });

    it('throws when the run does not exist for the tenant', async () => {
      evalRunRepository.findAll.mockResolvedValue([]);
      await expect(service.getEvalRun(TENANT, 'missing')).rejects.toBeInstanceOf(DataNotFoundException);
    });
  });

  describe('gateQueue', () => {
    it('computes SLA/escalation from the effective policy and clocks from the latest GENERATE event', async () => {
      const now = Date.now();
      const pendingSince = new Date(now - 200_000); // 200s ago

      policyRepository.findActiveForTenant.mockResolvedValue(
        HarnessPolicyFactory.CreateHarnessPolicy({ tenantId: TENANT, gateSlaSeconds: 100, gateEscalationSeconds: 50 }),
      );
      consultationRepository.findPendingReviewForTenant.mockResolvedValue([{ id: 'c1', status: 'PENDING_REVIEW', updatedAt: new Date(now - 999_000) }]);
      auditRepository.getChainForTenant.mockResolvedValue([
        { action: HarnessAuditAction.GENERATE, consultationId: 'c1', createdAt: pendingSince },
      ]);

      const result = await service.gateQueue(TENANT);

      expect(result.total).toBe(1);
      expect(result.gateSlaSeconds).toBe(100);
      expect(result.gateEscalationSeconds).toBe(50);
      expect(result.policySource).toBe('tenant');

      const item = result.items[0];
      expect(item.consultationId).toBe('c1');
      // Clock comes from the GENERATE event (200s ago), not the consultation's updatedAt (999s ago).
      expect(item.pendingSince).toBe(pendingSince.toISOString());
      expect(item.ageSeconds).toBeGreaterThanOrEqual(199);
      expect(item.generateCount).toBe(1);
      expect(item.regenCount).toBe(0);
      expect(item.slaBreached).toBe(true); // 200s > 100s SLA
      expect(item.escalated).toBe(true); // 200s > 50s escalation
      expect(result.slaBreachedCount).toBe(1);
      expect(result.escalatedCount).toBe(1);
    });

    it('falls back to code-default timers when no policy row exists', async () => {
      policyRepository.findActiveForTenant.mockResolvedValue(null);
      consultationRepository.findPendingReviewForTenant.mockResolvedValue([]);
      auditRepository.getChainForTenant.mockResolvedValue([]);

      const result = await service.gateQueue(TENANT);

      expect(result.total).toBe(0);
      expect(result.policySource).toBe('code-default');
      expect(result.gateSlaSeconds).toBe(86400);
      expect(result.gateEscalationSeconds).toBe(43200);
    });
  });
});
