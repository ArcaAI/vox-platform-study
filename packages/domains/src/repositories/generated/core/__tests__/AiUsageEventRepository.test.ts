/**
 * AiUsageEventRepository — append-only usage-ledger repository shape.
 *
 * The ledger is the money-critical table: every metered provider call lands
 * here exactly once. Two contracts are pinned by this suite.
 *
 *  1. IDEMPOTENT APPEND. `idempotencyKey` is UNIQUE in the schema, so a retried
 *     emission (outbox redelivery, gateway retry, a resumed stream) races into
 *     a P2002 rather than double-billing the tenant. `createIfAbsent` turns that
 *     race into a NO-OP that returns the row that won, flagged `created: false`
 *     — the caller can neither tell nor care which attempt persisted it.
 *     Anything OTHER than a P2002 must surface: swallowing a connection error
 *     as "already recorded" would silently drop usage.
 *
 *  2. TENANT-SCOPED READS. Every finder carries an explicit `tenantId` filter on
 *     top of the shared tenant-scope `$extends`, matching the
 *     AgentTrajectoryStep precedent for tenant-scoped ops telemetry.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AiUsageEventRepository } from '../AiUsageEventRepository';
import { AiUsageEventFactory } from '../../../../factories';
import { AiCapability, AiUsageUnit, AiDeploymentKind, AiCostBasis } from '../../../../enums';

const OCCURRED_AT = new Date('2026-08-06T10:00:00.000Z');

const row = (overrides: Record<string, unknown> = {}) => ({
  id: 'evt-1',
  tenantId: 'tenant-1',
  idempotencyKey: 'req-1::LLM::INPUT_TOKEN',
  occurredAt: OCCURRED_AT,
  recordedAt: new Date('2026-08-06T10:00:01.000Z'),
  capability: AiCapability.LLM,
  operation: 'generate',
  provider: 'ollama',
  model: 'qwen3-8b',
  deployment: AiDeploymentKind.SELF_HOSTED,
  unit: AiUsageUnit.INPUT_TOKEN,
  quantity: 1234,
  consultationId: null,
  doctorId: null,
  departmentId: null,
  requestId: 'req-1',
  sessionId: null,
  unitPriceMicros: null,
  priceBookVersion: null,
  costMicros: null,
  costBasis: AiCostBasis.INTERNAL,
  attributesJson: null,
  version: 1,
  createdAt: OCCURRED_AT,
  updatedAt: OCCURRED_AT,
  createdBy: null,
  updatedBy: null,
  metaData: null,
  ...overrides,
});

const newEntity = () =>
  AiUsageEventFactory.CreateAiUsageEvent({
    tenantId: 'tenant-1',
    idempotencyKey: 'req-1::LLM::INPUT_TOKEN',
    occurredAt: OCCURRED_AT,
    capability: AiCapability.LLM,
    operation: 'generate',
    provider: 'ollama',
    model: 'qwen3-8b',
    deployment: AiDeploymentKind.SELF_HOSTED,
    unit: AiUsageUnit.INPUT_TOKEN,
    quantity: 1234,
    requestId: 'req-1',
  });

const p2002 = (target: string[]) => Object.assign(new Error('Unique constraint failed'), { code: 'P2002', meta: { target } });

describe('AiUsageEventRepository', () => {
  let create: ReturnType<typeof vi.fn>;
  let findFirst: ReturnType<typeof vi.fn>;
  let findMany: ReturnType<typeof vi.fn>;
  let repo: AiUsageEventRepository;

  beforeEach(() => {
    create = vi.fn();
    findFirst = vi.fn();
    findMany = vi.fn();
    const delegate = { create, findFirst, findMany };
    const unitOfWork = { getDatabaseService: () => ({ aiUsageEvent: delegate }) };
    repo = new AiUsageEventRepository(unitOfWork as never);
  });

  describe('createIfAbsent — idempotent append', () => {
    it('appends the event and reports created: true on the first write', async () => {
      create.mockResolvedValue(row());

      const result = await repo.createIfAbsent(newEntity());

      expect(result.created).toBe(true);
      expect(result.entity.idempotencyKey).toBe('req-1::LLM::INPUT_TOKEN');
      expect(result.entity.unit).toBe(AiUsageUnit.INPUT_TOKEN);
      expect(create).toHaveBeenCalledTimes(1);
    });

    it('never writes `_version` on the insert path (the DB owns the OCC token)', async () => {
      create.mockResolvedValue(row());

      await repo.createIfAbsent(newEntity());

      expect(create.mock.calls[0][0].data).not.toHaveProperty('version');
    });

    it('is a NO-OP on an idempotency-key conflict and returns the winning row', async () => {
      create.mockRejectedValue(p2002(['idempotencyKey']));
      findFirst.mockResolvedValue(row({ id: 'evt-winner' }));

      const result = await repo.createIfAbsent(newEntity());

      expect(result.created).toBe(false);
      expect(result.entity.id).toBe('evt-winner');
      // The re-read must be pinned to the tenant AND the key, never the key alone.
      expect(findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            tenantId: 'tenant-1',
            idempotencyKey: 'req-1::LLM::INPUT_TOKEN',
          }),
        }),
      );
    });

    it('rethrows a P2002 raised on any OTHER unique constraint', async () => {
      create.mockRejectedValue(p2002(['id']));

      await expect(repo.createIfAbsent(newEntity())).rejects.toMatchObject({ code: 'P2002' });
      expect(findFirst).not.toHaveBeenCalled();
    });

    it('rethrows non-P2002 failures instead of reporting a false "already recorded"', async () => {
      create.mockRejectedValue(Object.assign(new Error('connection reset'), { code: 'P1001' }));

      await expect(repo.createIfAbsent(newEntity())).rejects.toThrow('connection reset');
      expect(findFirst).not.toHaveBeenCalled();
    });

    it('routes the append through a supplied transaction client (outbox co-write)', async () => {
      const txCreate = vi.fn().mockResolvedValue(row());
      const tx = { aiUsageEvent: { create: txCreate } };

      const result = await repo.createIfAbsent(newEntity(), tx as any);

      expect(txCreate).toHaveBeenCalledTimes(1);
      expect(create).not.toHaveBeenCalled();
      expect(result.created).toBe(true);
    });
  });

  describe('findByIdempotencyKey', () => {
    it('pins the read to the tenant + key', async () => {
      findFirst.mockResolvedValue(row());

      const entity = await repo.findByIdempotencyKey('tenant-1', 'req-1::LLM::INPUT_TOKEN');

      expect(findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ tenantId: 'tenant-1', idempotencyKey: 'req-1::LLM::INPUT_TOKEN' }),
        }),
      );
      expect(entity?.requestId).toBe('req-1');
    });

    it('returns null on a miss rather than throwing', async () => {
      findFirst.mockResolvedValue(null);
      await expect(repo.findByIdempotencyKey('tenant-1', 'nope')).resolves.toBeNull();
    });
  });

  describe('findByRequestId', () => {
    it('returns every unit row sharing one requestId, ordered by occurrence', async () => {
      findMany.mockResolvedValue([row(), row({ id: 'evt-2', unit: AiUsageUnit.OUTPUT_TOKEN, idempotencyKey: 'req-1::LLM::OUTPUT_TOKEN' })]);

      const events = await repo.findByRequestId('tenant-1', 'req-1');

      expect(findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ tenantId: 'tenant-1', requestId: 'req-1' }),
          orderBy: [{ occurredAt: 'asc' }],
        }),
      );
      expect(events.map((e) => e.unit)).toEqual([AiUsageUnit.INPUT_TOKEN, AiUsageUnit.OUTPUT_TOKEN]);
    });
  });

  describe('append-only posture', () => {
    it('softDelete throws — the ledger has no resourceStatus column', async () => {
      expect(repo.supportsSoftDelete).toBe(false);
      await expect(repo.softDelete('evt-1')).rejects.toThrow(/softDelete is not supported/);
    });

    it('restore throws for the same reason', async () => {
      await expect(repo.restore('evt-1')).rejects.toThrow(/restore is not supported/);
    });
  });
});
