/**
 * AgentTrajectoryService unit tests.
 *
 *  - recordSteps: IDEMPOTENT batch insert (createMany + skipDuplicates), NO
 *    sys-event, and per-consultation republish to `consultation:trajectory:{id}`.
 *  - recordSteps: tenant scoping (single-tenant batch; CLS-context match).
 *  - recordSteps: usage-ledger emission (TASK-615 WS-F) — co-emits ledger rows
 *    for LLM_CALL steps, converges retries on the same idempotency key, and
 *    never lets an emission failure fail trajectory persistence.
 *  - listSteps: ordered by seq asc, keyset-paginated, 404-over-403 cross-tenant.
 *  - listSessions: distinct sessions with counts + first/last timestamps.
 *  - pruneOlderThan: HARD-deletes only aged rows (fake timers) and returns count.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NotFoundException, BadRequestException } from '@nestjs/common';
import {
  AgentSessionKind,
  AgentStepStatus,
  AgentStepType,
  AgentTrajectoryStepEntity,
  AgentTrajectoryStepFactory,
  AiUsageUnit,
} from '@arcaai/domains';
import { AgentTrajectoryService } from '../agent-trajectory.service';
import { CreateAgentTrajectoryStepInput } from '../dto';

const TENANT = 'tenant-1';
const OTHER_TENANT = 'tenant-2';
const CID = 'consultation-1';
const SESSION = 'session-1';

function buildDeps(opts: { clsTenant?: string | null; unitOfWorkService?: unknown } = {}) {
  const repository = {
    createMany: vi.fn().mockResolvedValue({ count: 0 }),
    findAll: vi.fn().mockResolvedValue([]),
    listSessionSummaries: vi.fn().mockResolvedValue([]),
    delete: vi.fn().mockResolvedValue(undefined),
  };
  const eventEmitter = { emit: vi.fn() };
  const clsService = {
    get: vi.fn().mockImplementation((key: string) => (key === 'tenantId' ? (opts.clsTenant ?? undefined) : undefined)),
  };
  const cacheService = { publish: vi.fn().mockResolvedValue(undefined) };
  const usageLedgerService = { recordUsage: vi.fn().mockResolvedValue({ outboxIds: ['outbox-1'], events: 1 }) };

  const service = new AgentTrajectoryService(
    repository as never,
    eventEmitter as never,
    clsService as never,
    cacheService as never,
    usageLedgerService as never,
    opts.unitOfWorkService as never,
  );
  return { service, repository, eventEmitter, clsService, cacheService, usageLedgerService };
}

function makeStepInput(overrides: Partial<CreateAgentTrajectoryStepInput> = {}): CreateAgentTrajectoryStepInput {
  return {
    tenantId: TENANT,
    consultationId: CID,
    sessionKind: AgentSessionKind.LIVE_DOC,
    sessionId: SESSION,
    runId: '',
    seq: 0,
    stepType: AgentStepType.LLM_CALL,
    name: 'flush',
    status: AgentStepStatus.OK,
    startedAt: new Date('2026-07-19T10:00:00.000Z'),
    ...overrides,
  };
}

function makeStepEntity(overrides: Partial<Parameters<typeof AgentTrajectoryStepFactory.CreateStep>[0]> = {}): AgentTrajectoryStepEntity {
  return AgentTrajectoryStepFactory.CreateStep({
    tenantId: TENANT,
    consultationId: CID,
    sessionKind: AgentSessionKind.LIVE_DOC,
    sessionId: SESSION,
    runId: '',
    seq: 0,
    stepType: AgentStepType.LLM_CALL,
    name: 'flush',
    status: AgentStepStatus.OK,
    startedAt: new Date('2026-07-19T10:00:00.000Z'),
    ...overrides,
  });
}

describe('AgentTrajectoryService', () => {
  beforeEach(() => vi.clearAllMocks());

  describe('recordSteps — idempotency', () => {
    it('persists one batch via createMany with skipDuplicates and republishes per consultation', async () => {
      const { service, repository, cacheService } = buildDeps();
      repository.createMany.mockResolvedValue({ count: 2 });

      const batch = [makeStepInput({ seq: 0, name: 'flush' }), makeStepInput({ seq: 1, name: 'publish', stepType: AgentStepType.PHASE })];
      await service.recordSteps(batch);

      // ONE batch insert (not per-row create), with skipDuplicates === true.
      expect(repository.createMany).toHaveBeenCalledTimes(1);
      expect(repository.createMany).toHaveBeenCalledWith(expect.any(Array), true);
      expect(repository.createMany.mock.calls[0][0]).toHaveLength(2);

      // Republished each consultation-bearing step to the trajectory channel.
      expect(cacheService.publish).toHaveBeenCalledTimes(2);
      expect(cacheService.publish).toHaveBeenCalledWith(`consultation:trajectory:${CID}`, expect.any(String));
    });

    it('re-delivered duplicate batch no-ops (createMany reports 0 inserted → no republish)', async () => {
      const { service, repository, cacheService } = buildDeps();
      repository.createMany.mockResolvedValueOnce({ count: 2 }).mockResolvedValueOnce({ count: 0 });

      const batch = [makeStepInput({ seq: 0 }), makeStepInput({ seq: 1 })];
      await service.recordSteps(batch);
      await service.recordSteps(batch); // identical re-delivery

      expect(repository.createMany).toHaveBeenCalledTimes(2);
      // Second call inserted nothing (skipDuplicates) → no second-round republish.
      expect(cacheService.publish).toHaveBeenCalledTimes(2);
    });

    it('never emits a sys-event on write (telemetry exemption)', async () => {
      const { service, repository, eventEmitter } = buildDeps();
      repository.createMany.mockResolvedValue({ count: 1 });
      await service.recordSteps([makeStepInput()]);
      expect(eventEmitter.emit).not.toHaveBeenCalled();
    });

    it('empty batch is a no-op', async () => {
      const { service, repository } = buildDeps();
      await service.recordSteps([]);
      expect(repository.createMany).not.toHaveBeenCalled();
    });
  });

  describe('recordSteps — tenant scoping', () => {
    it('rejects a mixed-tenant batch (404-over-403)', async () => {
      const { service, repository } = buildDeps();
      const batch = [makeStepInput({ tenantId: TENANT }), makeStepInput({ tenantId: OTHER_TENANT, seq: 1 })];
      await expect(service.recordSteps(batch)).rejects.toBeInstanceOf(NotFoundException);
      expect(repository.createMany).not.toHaveBeenCalled();
    });

    it('rejects a step missing tenantId', async () => {
      const { service } = buildDeps();
      await expect(service.recordSteps([makeStepInput({ tenantId: '' })])).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects a step whose tenant differs from the request (CLS) tenant', async () => {
      const { service, repository } = buildDeps({ clsTenant: OTHER_TENANT });
      await expect(service.recordSteps([makeStepInput({ tenantId: TENANT })])).rejects.toBeInstanceOf(NotFoundException);
      expect(repository.createMany).not.toHaveBeenCalled();
    });
  });

  describe('recordSteps — usage-ledger emission (TASK-615 WS-F)', () => {
    const LLM_STATS = { prompt_tokens: 100, predicted_tokens: 40, provider: 'lm-studio', model: 'phi-4' };

    it('co-emits INPUT_TOKEN/OUTPUT_TOKEN rows for a persisted LLM_CALL step', async () => {
      const { service, repository, usageLedgerService } = buildDeps();
      repository.createMany.mockResolvedValue({ count: 1 });

      await service.recordSteps([makeStepInput({ stepType: AgentStepType.LLM_CALL, stats: LLM_STATS, seq: 5, runId: 'run-1' })]);

      expect(usageLedgerService.recordUsage).toHaveBeenCalledTimes(1);
      const [input] = usageLedgerService.recordUsage.mock.calls[0];
      expect(input.common).toMatchObject({
        tenantId: TENANT,
        idempotencyKey: `harness:step:${SESSION}:run-1:5`,
        capability: 'LLM',
        operation: 'harness.step',
        provider: 'lm-studio',
        model: 'phi-4',
      });
      expect(input.units).toEqual(
        expect.arrayContaining([
          { unit: AiUsageUnit.INPUT_TOKEN, quantity: 100 },
          { unit: AiUsageUnit.OUTPUT_TOKEN, quantity: 40 },
        ]),
      );
    });

    it('a retried/re-delivered batch (same session/run/seq) emits the SAME idempotency key both times', async () => {
      const { service, repository, usageLedgerService } = buildDeps();
      repository.createMany.mockResolvedValue({ count: 1 });

      const batch = [makeStepInput({ stepType: AgentStepType.LLM_CALL, stats: LLM_STATS, seq: 7, runId: 'run-2' })];
      await service.recordSteps(batch);
      await service.recordSteps(batch); // Temporal activity retry re-POSTing the identical step

      expect(usageLedgerService.recordUsage).toHaveBeenCalledTimes(2);
      const firstKey = usageLedgerService.recordUsage.mock.calls[0][0].common.idempotencyKey;
      const secondKey = usageLedgerService.recordUsage.mock.calls[1][0].common.idempotencyKey;
      expect(firstKey).toBe(secondKey);
      expect(firstKey).toBe(`harness:step:${SESSION}:run-2:7`);
    });

    it('never emits for a non-LLM_CALL step', async () => {
      const { service, repository, usageLedgerService } = buildDeps();
      repository.createMany.mockResolvedValue({ count: 1 });
      await service.recordSteps([makeStepInput({ stepType: AgentStepType.PHASE, stats: LLM_STATS })]);
      expect(usageLedgerService.recordUsage).not.toHaveBeenCalled();
    });

    it('never emits for an LLM_CALL step with no stats', async () => {
      const { service, repository, usageLedgerService } = buildDeps();
      repository.createMany.mockResolvedValue({ count: 1 });
      await service.recordSteps([makeStepInput({ stepType: AgentStepType.LLM_CALL, stats: undefined })]);
      expect(usageLedgerService.recordUsage).not.toHaveBeenCalled();
    });

    it('an emission failure never fails trajectory persistence (best-effort, like the live-view republish)', async () => {
      const { service, repository, usageLedgerService, cacheService } = buildDeps();
      repository.createMany.mockResolvedValue({ count: 1 });
      usageLedgerService.recordUsage.mockRejectedValue(new Error('outbox write failed'));

      await expect(service.recordSteps([makeStepInput({ stepType: AgentStepType.LLM_CALL, stats: LLM_STATS })])).resolves.toBeUndefined();
      // The rest of recordSteps still ran (republish included).
      expect(cacheService.publish).toHaveBeenCalledTimes(1);
    });

    it('constructs without a usage-ledger service (test-fixture ergonomics) and simply skips emission', async () => {
      const repository = {
        createMany: vi.fn().mockResolvedValue({ count: 1 }),
        findAll: vi.fn().mockResolvedValue([]),
        listSessionSummaries: vi.fn().mockResolvedValue([]),
        delete: vi.fn().mockResolvedValue(undefined),
      };
      const eventEmitter = { emit: vi.fn() };
      const clsService = { get: vi.fn().mockReturnValue(undefined) };
      const service = new AgentTrajectoryService(repository as never, eventEmitter as never, clsService as never);

      await expect(service.recordSteps([makeStepInput({ stepType: AgentStepType.LLM_CALL, stats: LLM_STATS })])).resolves.toBeUndefined();
    });
  });

  // TASK-615 WS-D2 (item 4b) — upgrade from the WS-F "sanctioned no-tx
  // fallback" now that `Repository.createMany` accepts a `tx` client. When
  // the unit-of-work is wired, step persistence and usage emission share ONE
  // transaction; when it is not wired (legacy fixtures), behavior is
  // byte-identical to the pre-upgrade sequential calls.
  describe('recordSteps — createMany + usage emission share one transaction (TASK-615 WS-D2)', () => {
    const LLM_STATS = { prompt_tokens: 100, predicted_tokens: 40, provider: 'lm-studio', model: 'phi-4' };
    const TX = { __brand: 'tx' } as const;

    function buildDepsWithUow() {
      const unitOfWorkService = { runInTransaction: vi.fn(async (work: (tx: unknown) => Promise<unknown>) => work(TX)) };
      return { ...buildDeps({ unitOfWorkService }), unitOfWorkService };
    }

    it('routes createMany through the SAME tx the unit-of-work opened', async () => {
      const { service, repository, unitOfWorkService } = buildDepsWithUow();
      repository.createMany.mockResolvedValue({ count: 1 });

      await service.recordSteps([makeStepInput({ seq: 0 })]);

      expect(unitOfWorkService.runInTransaction).toHaveBeenCalledTimes(1);
      expect(repository.createMany).toHaveBeenCalledWith(expect.any(Array), true, TX);
    });

    it('routes the usage-ledger emission through the SAME tx as the step persistence', async () => {
      const { service, repository, usageLedgerService, unitOfWorkService } = buildDepsWithUow();
      repository.createMany.mockResolvedValue({ count: 1 });

      await service.recordSteps([makeStepInput({ stepType: AgentStepType.LLM_CALL, stats: LLM_STATS, seq: 9, runId: 'run-9' })]);

      expect(unitOfWorkService.runInTransaction).toHaveBeenCalledTimes(1);
      expect(usageLedgerService.recordUsage).toHaveBeenCalledTimes(1);
      const [, tx] = usageLedgerService.recordUsage.mock.calls[0];
      expect(tx).toBe(TX);
    });

    it('a metering failure inside the transaction is still swallowed — the transaction resolves and the batch commits', async () => {
      const { service, repository, usageLedgerService, cacheService, unitOfWorkService } = buildDepsWithUow();
      repository.createMany.mockResolvedValue({ count: 1 });
      usageLedgerService.recordUsage.mockRejectedValue(new Error('outbox write failed'));

      await expect(
        service.recordSteps([makeStepInput({ stepType: AgentStepType.LLM_CALL, stats: LLM_STATS })]),
      ).resolves.toBeUndefined();

      // runInTransaction's callback resolved normally (the per-row catch in
      // emitUsage absorbed the rejection) — republish still ran afterward.
      expect(cacheService.publish).toHaveBeenCalledTimes(1);
    });

    it('without a wired unit-of-work: falls back to the pre-upgrade sequential (no-tx) calls, unchanged', async () => {
      // buildDeps() with no unitOfWorkService override leaves it undefined —
      // the exact arity the pre-existing idempotency tests above assert on.
      const { service, repository, usageLedgerService } = buildDeps();
      repository.createMany.mockResolvedValue({ count: 1 });

      await service.recordSteps([makeStepInput({ stepType: AgentStepType.LLM_CALL, stats: LLM_STATS })]);

      expect(repository.createMany).toHaveBeenCalledWith(expect.any(Array), true);
      const [, tx] = usageLedgerService.recordUsage.mock.calls[0];
      expect(tx).toBeUndefined();
    });
  });

  describe('listSteps — ordered + keyset pagination', () => {
    it('returns steps ordered by seq asc for the session', async () => {
      const { service, repository } = buildDeps();
      const rows = [makeStepEntity({ seq: 0 }), makeStepEntity({ seq: 1 }), makeStepEntity({ seq: 2 })];
      repository.findAll.mockResolvedValue(rows);

      const page = await service.listSteps(TENANT, SESSION, { limit: 10 });

      expect(repository.findAll).toHaveBeenCalledWith(
        expect.objectContaining({ where: { tenantId: TENANT, sessionId: SESSION }, sort: [{ seq: 'asc' }, { id: 'asc' }] }),
      );
      expect(page.items.map((i) => i.seq)).toEqual([0, 1, 2]);
      expect(page.hasMore).toBe(false);
      expect(page.nextCursor).toBeNull();
    });

    it('emits a nextCursor when a full page is returned (hasMore)', async () => {
      const { service, repository } = buildDeps();
      // limit 2 → over-fetch 3; 3 returned ⇒ hasMore, page trimmed to 2.
      repository.findAll.mockResolvedValue([makeStepEntity({ seq: 0 }), makeStepEntity({ seq: 1 }), makeStepEntity({ seq: 2 })]);

      const page = await service.listSteps(TENANT, SESSION, { limit: 2 });

      expect(repository.findAll).toHaveBeenCalledWith(expect.objectContaining({ limit: 3 }));
      expect(page.items).toHaveLength(2);
      expect(page.hasMore).toBe(true);
      expect(page.nextCursor).toBeTypeOf('string');
    });

    it('404-over-403 when the first page is empty (cross-tenant / nonexistent session)', async () => {
      const { service, repository } = buildDeps();
      repository.findAll.mockResolvedValue([]);
      await expect(service.listSteps(TENANT, 'session-owned-by-other-tenant')).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('listSessions — distinct sessions', () => {
    it('maps DB session summaries (no full findAll of steps) with newest lastStepAt first', async () => {
      const { service, repository } = buildDeps();
      repository.listSessionSummaries.mockResolvedValue([
        {
          sessionId: 'older',
          runId: '',
          sessionKind: 'LIVE_DOC',
          consultationId: CID,
          stepCount: 1,
          firstStepAt: new Date('2026-07-19T09:00:00.000Z'),
          lastStepAt: new Date('2026-07-19T09:00:01.000Z'),
        },
        {
          sessionId: SESSION,
          runId: '',
          sessionKind: 'LIVE_DOC',
          consultationId: CID,
          stepCount: 2,
          firstStepAt: new Date('2026-07-19T10:00:00.000Z'),
          lastStepAt: new Date('2026-07-19T10:00:06.000Z'),
        },
      ]);

      const result = await service.listSessions(TENANT, {});
      expect(repository.listSessionSummaries).toHaveBeenCalledTimes(1);
      expect(repository.findAll).not.toHaveBeenCalled();
      expect(result.total).toBe(2);
      // Newest activity first.
      expect(result.items.map((s) => s.sessionId)).toEqual([SESSION, 'older']);
      expect(result.items[0]).toMatchObject({
        sessionId: SESSION,
        runId: '',
        sessionKind: 'LIVE_DOC',
        consultationId: CID,
        stepCount: 2,
        firstStepAt: '2026-07-19T10:00:00.000Z',
        lastStepAt: '2026-07-19T10:00:06.000Z',
      });
    });

    it('scopes the query to the tenant and applies consultation + kind filters', async () => {
      const { service, repository } = buildDeps();
      repository.listSessionSummaries.mockResolvedValue([]);
      await service.listSessions(TENANT, { consultationId: CID, kind: AgentSessionKind.SUMMARY_JOB });
      expect(repository.listSessionSummaries).toHaveBeenCalledWith(TENANT, {
        consultationId: CID,
        sessionKind: AgentSessionKind.SUMMARY_JOB,
      });
      expect(repository.findAll).not.toHaveBeenCalled();
    });

    it('forwards from/to as a createdAt range on the summary query', async () => {
      const { service, repository } = buildDeps();
      repository.listSessionSummaries.mockResolvedValue([]);
      await service.listSessions(TENANT, {
        from: '2026-07-01T00:00:00.000Z',
        to: '2026-07-19T23:59:59.000Z',
      });
      expect(repository.listSessionSummaries).toHaveBeenCalledWith(TENANT, {
        createdAt: {
          gte: new Date('2026-07-01T00:00:00.000Z'),
          lte: new Date('2026-07-19T23:59:59.000Z'),
        },
      });
    });
  });

  describe('pruneOlderThan — hard retention', () => {
    it('hard-deletes only rows older than now - days and returns the count', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-07-19T00:00:00.000Z'));
      try {
        const { service, repository } = buildDeps();
        const aged = [makeStepEntity({ seq: 0 }), makeStepEntity({ seq: 1 })];
        repository.findAll.mockResolvedValue(aged);

        const deleted = await service.pruneOlderThan(30);

        const cutoff = new Date('2026-06-19T00:00:00.000Z'); // 30 days before the faked now
        expect(repository.findAll).toHaveBeenCalledWith(expect.objectContaining({ where: { createdAt: { lt: cutoff } } }));
        // Deletes each aged row (AgentTrajectoryStep repo only — the sole hard-delete path).
        expect(repository.delete).toHaveBeenCalledTimes(2);
        expect(deleted).toBe(2);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('aggregateGenerationStats — follow-up', () => {
    it('rolls LLM_CALL stats (snake_case AD-1) into GenerationAggregate panels', async () => {
      const { service, repository } = buildDeps();
      repository.findAll.mockResolvedValue([
        makeStepEntity({
          seq: 0,
          stats: { ttft_ms: 120, tokens_per_second: 40, stop_reason: 'stop' },
        }),
        makeStepEntity({
          seq: 1,
          stats: { ttft_ms: 200, tokens_per_second: 60, stop_reason: 'length' },
        }),
        // Non-LLM steps must never be queried; if they sneak in, ignore missing stats.
        makeStepEntity({ seq: 2, stepType: AgentStepType.PHASE, stats: undefined }),
      ]);

      const result = await service.aggregateGenerationStats(TENANT, {
        from: '2026-07-12T00:00:00.000Z',
        to: '2026-07-19T23:59:59.000Z',
      });

      expect(result).toEqual({
        sampleCount: 2,
        ttftMedianMs: 160,
        ttftP95Ms: expect.any(Number),
        tokensPerSecondAvg: 50,
        stopReasons: [
          { reason: 'length', count: 1 },
          { reason: 'stop', count: 1 },
        ],
        // Token/$ fields are ADDITIVE and null here: these fixtures
        // carry no token counts, so the pre-B4 semantics are unchanged.
        promptTokensTotal: null,
        completionTokensTotal: null,
        totalTokens: null,
        estimatedCost: null,
        currency: null,
      });
      expect(result.ttftP95Ms).toBeGreaterThanOrEqual(160);
    });

    it('scopes findAll to tenant + LLM_CALL + createdAt window (default last 7d) with hard row cap', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-07-19T12:00:00.000Z'));
      try {
        const { service, repository } = buildDeps();
        repository.findAll.mockResolvedValue([]);

        await service.aggregateGenerationStats(TENANT, { consultationId: CID });

        expect(repository.findAll).toHaveBeenCalledWith(
          expect.objectContaining({
            page: 1,
            limit: 5000,
            where: {
              tenantId: TENANT,
              stepType: AgentStepType.LLM_CALL,
              consultationId: CID,
              createdAt: {
                gte: new Date('2026-07-12T12:00:00.000Z'),
                lte: new Date('2026-07-19T12:00:00.000Z'),
              },
            },
          }),
        );
        // Must not fall back to an unbounded session summary scan.
        expect(repository.listSessionSummaries).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    it('forwards explicit from/to as createdAt bounds (no default window when both provided)', async () => {
      const { service, repository } = buildDeps();
      repository.findAll.mockResolvedValue([]);

      await service.aggregateGenerationStats(TENANT, {
        from: '2026-07-01T00:00:00.000Z',
        to: '2026-07-10T00:00:00.000Z',
      });

      expect(repository.findAll).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            createdAt: {
              gte: new Date('2026-07-01T00:00:00.000Z'),
              lte: new Date('2026-07-10T00:00:00.000Z'),
            },
          }),
        }),
      );
    });

    it('returns empty aggregate when no LLM_CALL rows carry parseable stats', async () => {
      const { service, repository } = buildDeps();
      repository.findAll.mockResolvedValue([makeStepEntity({ seq: 0, stats: undefined })]);

      await expect(service.aggregateGenerationStats(TENANT, {})).resolves.toEqual({
        sampleCount: 0,
        ttftMedianMs: null,
        ttftP95Ms: null,
        tokensPerSecondAvg: null,
        stopReasons: [],
        // Token/$ fields are ADDITIVE and null here: these fixtures
        // carry no token counts, so the pre-B4 semantics are unchanged.
        promptTokensTotal: null,
        completionTokensTotal: null,
        totalTokens: null,
        estimatedCost: null,
        currency: null,
      });
    });
  });
});
