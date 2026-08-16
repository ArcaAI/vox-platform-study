/**
 * HarnessObservabilityService unit tests.
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

const auditRepository = { getChainForTenant: vi.fn(), getByConsultation: vi.fn() };
const evalRunRepository = { count: vi.fn(), findAll: vi.fn() };
const evalScoreRepository = { getByEvalRun: vi.fn() };
const consultationRepository = { findPendingReviewForTenant: vi.fn(), findTimedOutForTenant: vi.fn(), findAll: vi.fn() };
const policyRepository = { findActiveForTenant: vi.fn() };
const contextItemRepository = {
  findLatestRawSummary: vi.fn(),
  findLatestModifiedSummary: vi.fn(),
  decryptContentFromEntity: vi.fn(),
};
const secretsService = {};

function makeService(): HarnessObservabilityService {
  return new HarnessObservabilityService(
    auditRepository as never,
    evalRunRepository as never,
    evalScoreRepository as never,
    consultationRepository as never,
    policyRepository as never,
  );
}

/** Service wired with the optional edit-burden dependencies (content repo + secrets). */
function makeServiceWithEditBurden(): HarnessObservabilityService {
  return new HarnessObservabilityService(
    auditRepository as never,
    evalRunRepository as never,
    evalScoreRepository as never,
    consultationRepository as never,
    policyRepository as never,
    secretsService as never,
    contextItemRepository as never,
  );
}

/** Build a valid 3-event chain: c1 GENERATE → c1 GATE_DECISION → c2 GENERATE. */
function buildChain() {
  const base = { tenantId: TENANT, modelName: 'gpt', modelVersion: '1', sensorScores: {}, citations: [] };
  const e1 = HarnessAuditEventFactory.CreateHarnessAuditEvent({
    ...base,
    consultationId: 'c1',
    action: HarnessAuditAction.GENERATE,
    prevHash: GENESIS_PREV_HASH,
  });
  const e2 = HarnessAuditEventFactory.CreateHarnessAuditEvent({
    ...base,
    consultationId: 'c1',
    action: HarnessAuditAction.GATE_DECISION,
    gateDecision: 'APPROVE',
    prevHash: e1.hash,
  });
  const e3 = HarnessAuditEventFactory.CreateHarnessAuditEvent({
    ...base,
    consultationId: 'c2',
    action: HarnessAuditAction.GENERATE,
    prevHash: e2.hash,
  });
  return [e1, e2, e3];
}

/** A valid 3-event chain with explicit (Jan/Feb/Mar 2026) timestamps for range filtering. */
function buildDatedChain() {
  const base = { tenantId: TENANT, modelName: 'gpt', modelVersion: '1', sensorScores: {}, citations: [] };
  const e1 = HarnessAuditEventFactory.CreateHarnessAuditEvent({
    ...base,
    consultationId: 'c1',
    action: HarnessAuditAction.GENERATE,
    prevHash: GENESIS_PREV_HASH,
    createdAt: new Date('2026-01-15T00:00:00.000Z'),
  });
  const e2 = HarnessAuditEventFactory.CreateHarnessAuditEvent({
    ...base,
    consultationId: 'c1',
    action: HarnessAuditAction.GATE_DECISION,
    gateDecision: 'APPROVE',
    prevHash: e1.hash,
    createdAt: new Date('2026-02-15T00:00:00.000Z'),
  });
  const e3 = HarnessAuditEventFactory.CreateHarnessAuditEvent({
    ...base,
    consultationId: 'c2',
    action: HarnessAuditAction.GENERATE,
    prevHash: e2.hash,
    createdAt: new Date('2026-03-15T00:00:00.000Z'),
  });
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

    it('narrows by action while the verdict still covers the full chain', async () => {
      const [e1, e2, e3] = buildChain();
      auditRepository.getChainForTenant.mockResolvedValue([e1, e2, e3]);

      const generates = await service.listAuditEvents(TENANT, { action: HarnessAuditAction.GENERATE });
      expect(generates.total).toBe(2);
      expect(generates.items.map((i) => i.id)).toEqual([e3.id, e1.id]);
      // Verdict is chain-global: still valid even though the page is filtered.
      expect(generates.verification.valid).toBe(true);

      const gateDecisions = await service.listAuditEvents(TENANT, { action: HarnessAuditAction.GATE_DECISION });
      expect(gateDecisions.total).toBe(1);
      expect(gateDecisions.items.map((i) => i.id)).toEqual([e2.id]);
    });

    it('narrows by an inclusive createdAt date range', async () => {
      const [e1, e2, e3] = buildDatedChain();
      auditRepository.getChainForTenant.mockResolvedValue([e1, e2, e3]);

      // from excludes Jan (e1); to excludes Mar (e3) → only Feb (e2).
      const ranged = await service.listAuditEvents(TENANT, {
        from: '2026-02-01T00:00:00.000Z',
        to: '2026-02-28T23:59:59.999Z',
      });
      expect(ranged.total).toBe(1);
      expect(ranged.items.map((i) => i.id)).toEqual([e2.id]);

      // from only: Feb + Mar.
      const fromOnly = await service.listAuditEvents(TENANT, { from: '2026-02-01T00:00:00.000Z' });
      expect(fromOnly.items.map((i) => i.id)).toEqual([e3.id, e2.id]);

      // Boundary is inclusive: a `to` exactly on e3's timestamp keeps e3.
      const inclusiveTo = await service.listAuditEvents(TENANT, { to: '2026-03-15T00:00:00.000Z' });
      expect(inclusiveTo.total).toBe(3);
    });

    it('combines consultation + action filters', async () => {
      const [e1, e2, e3] = buildChain();
      auditRepository.getChainForTenant.mockResolvedValue([e1, e2, e3]);

      const result = await service.listAuditEvents(TENANT, { consultationId: 'c1', action: HarnessAuditAction.GENERATE });
      expect(result.total).toBe(1);
      expect(result.items.map((i) => i.id)).toEqual([e1.id]);
    });

    it('ignores an unparseable date bound rather than filtering everything out', async () => {
      const [e1, e2, e3] = buildChain();
      auditRepository.getChainForTenant.mockResolvedValue([e1, e2, e3]);

      const result = await service.listAuditEvents(TENANT, { from: 'not-a-date' });
      expect(result.total).toBe(3);
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

    // Tail: `triggerType`/`promptVersionNumber` are persisted on
    // `EvalRun` (promotion-gate attribution) but were never surfaced through
    // this read projection — the console badge (MANUAL/PROMOTION/CI) has
    // nothing to render without them.
    it('surfaces triggerType and promptVersionNumber on the list + detail projections', async () => {
      const promotionRun = { ...run, id: 'run-2', triggerType: 'PROMOTION', promptTemplateId: 'pt-1', promptVersionNumber: 3 };
      evalRunRepository.count.mockResolvedValue(1);
      evalRunRepository.findAll.mockResolvedValue([promotionRun]);
      evalScoreRepository.getByEvalRun.mockResolvedValue([]);

      const list = await service.listEvalRuns(TENANT, { page: 1, limit: 20 });
      expect(list.items[0].triggerType).toBe('PROMOTION');
      expect(list.items[0].promptVersionNumber).toBe(3);

      const detail = await service.getEvalRun(TENANT, 'run-2');
      expect(detail.triggerType).toBe('PROMOTION');
      expect(detail.promptVersionNumber).toBe(3);
    });

    it('reports triggerType/promptVersionNumber as null when unset (legacy rows)', async () => {
      evalRunRepository.count.mockResolvedValue(1);
      evalRunRepository.findAll.mockResolvedValue([run]);

      const result = await service.listEvalRuns(TENANT, { page: 1, limit: 20 });
      expect(result.items[0].triggerType).toBeNull();
      expect(result.items[0].promptVersionNumber).toBeNull();
    });

    it('returns a run with its per-case scores', async () => {
      evalRunRepository.findAll.mockResolvedValue([run]);
      evalScoreRepository.getByEvalRun.mockResolvedValue([
        {
          id: 's1',
          tenantId: TENANT,
          evalRunId: 'run-1',
          goldenCaseId: 'gc1',
          metric: 'pdsqi',
          score: 4,
          maxScore: 5,
          rationale: 'ok',
          judgeModel: 'judge',
          details: null,
          createdAt: new Date('2026-01-01T00:30:00Z'),
        },
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
      consultationRepository.findPendingReviewForTenant.mockResolvedValue([
        { id: 'c1', status: 'PENDING_REVIEW', updatedAt: new Date(now - 999_000) },
      ]);
      consultationRepository.findTimedOutForTenant.mockResolvedValue([]);
      auditRepository.getChainForTenant.mockResolvedValue([{ action: HarnessAuditAction.GENERATE, consultationId: 'c1', createdAt: pendingSince }]);

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
      consultationRepository.findTimedOutForTenant.mockResolvedValue([]);
      auditRepository.getChainForTenant.mockResolvedValue([]);

      const result = await service.gateQueue(TENANT);

      expect(result.total).toBe(0);
      expect(result.policySource).toBe('code-default');
      expect(result.gateSlaSeconds).toBe(86400);
      expect(result.gateEscalationSeconds).toBe(43200);
    });

    it('TASK-711: also surfaces TIMED_OUT consultations (already-breached, still rescuable)', async () => {
      const now = Date.now();
      policyRepository.findActiveForTenant.mockResolvedValue(
        HarnessPolicyFactory.CreateHarnessPolicy({ tenantId: TENANT, gateSlaSeconds: 100, gateEscalationSeconds: 50 }),
      );
      consultationRepository.findPendingReviewForTenant.mockResolvedValue([]);
      consultationRepository.findTimedOutForTenant.mockResolvedValue([{ id: 'c-timed-out', status: 'TIMED_OUT', updatedAt: new Date(now - 999_000) }]);
      auditRepository.getChainForTenant.mockResolvedValue([]);

      const result = await service.gateQueue(TENANT);

      expect(result.total).toBe(1);
      expect(result.items[0].consultationId).toBe('c-timed-out');
      expect(result.items[0].status).toBe('TIMED_OUT');
      expect(result.items[0].slaBreached).toBe(true);
      expect(result.items[0].escalated).toBe(true);
    });
  });

  describe('getEditBurden (tenancy fix)', () => {
    const CONSULTATION = 'consult-1';
    const delivered = new Date('2026-07-10T10:00:00.000Z');
    const signed = new Date('2026-07-10T10:30:00.000Z');

    beforeEach(() => {
      // Default: the consultation exists in-tenant. Tests that need the
      // not-found path override this per-case.
      consultationRepository.findAll.mockResolvedValue([{ id: CONSULTATION, tenantId: TENANT }]);
    });

    it('verifies the consultation exists in-tenant via the repository before computing burden', async () => {
      auditRepository.getByConsultation.mockResolvedValue([]);

      const service = makeServiceWithEditBurden();
      await service.getEditBurden(TENANT, CONSULTATION);

      expect(consultationRepository.findAll).toHaveBeenCalledWith({ filters: { tenantId: TENANT, id: CONSULTATION }, limit: 1 });
    });

    it('returns a normal 200 zeroed response for an in-tenant consultation with no recorded activity yet (does NOT throw)', async () => {
      consultationRepository.findAll.mockResolvedValue([{ id: CONSULTATION, tenantId: TENANT }]);
      auditRepository.getByConsultation.mockResolvedValue([]);

      const service = makeServiceWithEditBurden();
      const result = await service.getEditBurden(TENANT, CONSULTATION);

      expect(result.consultationId).toBe(CONSULTATION);
      expect(result.gateDecisionTotal).toBe(0);
      expect(result.deliveredAt).toBeNull();
      expect(result.signedAt).toBeNull();
    });

    it('throws DataNotFoundException for a nonexistent consultationId', async () => {
      consultationRepository.findAll.mockResolvedValue([]);

      const service = makeServiceWithEditBurden();
      await expect(service.getEditBurden(TENANT, 'nonexistent')).rejects.toBeInstanceOf(DataNotFoundException);
      // The audit trail must never be queried once existence fails.
      expect(auditRepository.getByConsultation).not.toHaveBeenCalled();
    });

    it('throws the SAME not-found exception for a consultation belonging to another tenant — no distinguishable signal from "nonexistent"', async () => {
      // The repository call is tenant-filtered (`filters: { tenantId, id }`), so a
      // row that exists but belongs to a different tenant yields the same empty
      // result as a truly nonexistent id — this IS the 404-over-403 mechanism.
      consultationRepository.findAll.mockResolvedValue([]);
      const service = makeServiceWithEditBurden();

      let nonexistentError: unknown;
      try {
        await service.getEditBurden(TENANT, 'nonexistent');
      } catch (error) {
        nonexistentError = error;
      }

      let crossTenantError: unknown;
      try {
        await service.getEditBurden(TENANT, 'belongs-to-another-tenant');
      } catch (error) {
        crossTenantError = error;
      }

      expect(nonexistentError).toBeInstanceOf(DataNotFoundException);
      expect(crossTenantError).toBeInstanceOf(DataNotFoundException);
      // Identical exception class AND persistence error code — cross-tenant is
      // indistinguishable from missing.
      expect((crossTenantError as Error).constructor).toBe((nonexistentError as Error).constructor);
      expect((crossTenantError as DataNotFoundException).code).toBe((nonexistentError as DataNotFoundException).code);
    });

    it('derives edit distance, deferral rate, and time-to-sign from persisted rows', async () => {
      auditRepository.getByConsultation.mockResolvedValue([
        { action: HarnessAuditAction.GENERATE, gateDecision: null, createdAt: delivered },
        { action: HarnessAuditAction.GATE_DECISION, gateDecision: 'PASS', createdAt: delivered },
        { action: HarnessAuditAction.GATE_DECISION, gateDecision: 'REGEN', createdAt: delivered },
        { action: HarnessAuditAction.ATTEST, gateDecision: null, createdAt: signed },
      ]);
      contextItemRepository.findLatestRawSummary.mockResolvedValue({ encryptedContent: Buffer.from('ct'), content: null });
      contextItemRepository.findLatestModifiedSummary.mockResolvedValue({ encryptedContent: Buffer.from('ct'), content: null });
      contextItemRepository.decryptContentFromEntity
        .mockResolvedValueOnce('continue lisinopril 10 mg daily')
        .mockResolvedValueOnce('continue lisinopril 20 mg daily');

      const service = makeServiceWithEditBurden();
      const result = await service.getEditBurden(TENANT, CONSULTATION);

      expect(result.consultationId).toBe(CONSULTATION);
      expect(result.editDistance).toBe(1); // one word changed (10 → 20)
      expect(result.gateDecisionTotal).toBe(2);
      expect(result.deferralCount).toBe(1); // the REGEN
      expect(result.deferralRate).toBeCloseTo(1 / 2);
      expect(result.timeToSignSeconds).toBe(1800); // 30 min
      expect(result.deliveredAt).toBe(delivered.toISOString());
      expect(result.signedAt).toBe(signed.toISOString());
    });

    it('skips edit distance when the content repo is not wired (deferral/time-to-sign still derived)', async () => {
      auditRepository.getByConsultation.mockResolvedValue([
        { action: HarnessAuditAction.GENERATE, gateDecision: null, createdAt: delivered },
        { action: HarnessAuditAction.GATE_DECISION, gateDecision: 'FLAG', createdAt: delivered },
        { action: HarnessAuditAction.ATTEST, gateDecision: null, createdAt: signed },
      ]);

      const service = makeService(); // 5-arg construction: no content repo / secrets
      const result = await service.getEditBurden(TENANT, CONSULTATION);

      expect(result.editDistance).toBeNull();
      expect(result.editDistanceRatio).toBeNull();
      expect(result.deferralRate).toBe(1); // FLAG only
      expect(result.timeToSignSeconds).toBe(1800);
    });

    it('exposes no note content in the response — PHI stays out', async () => {
      auditRepository.getByConsultation.mockResolvedValue([{ action: HarnessAuditAction.GENERATE, gateDecision: null, createdAt: delivered }]);
      contextItemRepository.findLatestRawSummary.mockResolvedValue({ encryptedContent: Buffer.from('ct'), content: null });
      contextItemRepository.findLatestModifiedSummary.mockResolvedValue({ encryptedContent: Buffer.from('ct'), content: null });
      contextItemRepository.decryptContentFromEntity
        .mockResolvedValueOnce('PATIENT SECRET chest pain and dyspnea')
        .mockResolvedValueOnce('PATIENT SECRET chest pain, dyspnea, edited');

      const service = makeServiceWithEditBurden();
      const result = await service.getEditBurden(TENANT, CONSULTATION);

      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain('SECRET');
      expect(serialized).not.toContain('chest');
      expect(result.editDistance).toBeGreaterThan(0);
    });
  });
});
