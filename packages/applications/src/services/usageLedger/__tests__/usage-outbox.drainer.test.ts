/**
 * UsageOutboxDrainer — rating, the ledger append, and rollup maintenance.
 *
 * This is where double-billing would happen if anything were subtly wrong, so
 * the tests are written against the two failure windows that matter:
 *
 *   1. **Insert succeeded, rollup did not.** The event exists, the aggregate
 *      does not, and a redrain sees the idempotency conflict and skips — the
 *      rollup would be lost forever. Prevented by doing both in ONE transaction.
 *   2. **Everything succeeded, marking DISPATCHED did not.** A redrain re-runs
 *      the whole row; every insert conflicts, no rollup is touched, the row is
 *      marked. Prevented by deriving rollup maintenance from the INSERT
 *      OUTCOME, never from "we processed this row".
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AiCapability, AiCostBasis, AiDeploymentKind, AiUsageOutboxStatus, AiUsageUnit } from '@arcaai/domains';

import { UsageOutboxDrainer } from '../usage-outbox.drainer';
import { USAGE_OUTBOX_PAYLOAD_VERSION } from '../dto';

const TENANT = '50000000-0000-0000-0000-000000000000';
const TX = { __tx: true };

const mockOutboxRepository = { findClaimable: vi.fn(), update: vi.fn() };
const mockEventRepository = { create: vi.fn() };
const mockHourlyRepository = { accumulate: vi.fn() };
const mockDailyRepository = { accumulate: vi.fn() };
const mockPriceBook = { resolveCostPrice: vi.fn() };
const mockUnitOfWork = { runInTransaction: vi.fn() };

function serializedEvent(overrides: Record<string, unknown> = {}) {
  return {
    tenantId: TENANT,
    idempotencyKey: 'llm:req-1:INPUT_TOKEN',
    occurredAt: '2026-08-06T10:15:30.000Z',
    capability: AiCapability.LLM,
    operation: 'generate',
    provider: 'anthropic',
    model: 'claude-sonnet-5',
    deployment: AiDeploymentKind.CLOUD,
    unit: AiUsageUnit.INPUT_TOKEN,
    quantity: '1000',
    costBasis: AiCostBasis.INTERNAL,
    consultationId: 'consult-1',
    doctorId: null,
    departmentId: null,
    requestId: 'req-1',
    sessionId: null,
    attributesJson: null,
    ...overrides,
  };
}

/** A minimal stand-in for AiUsageOutboxEntity with the setters the drainer uses. */
function outboxRow(events: Record<string, unknown>[], overrides: Record<string, unknown> = {}) {
  return {
    id: 'outbox-1',
    tenantId: TENANT,
    payload: { version: USAGE_OUTBOX_PAYLOAD_VERSION, events },
    status: AiUsageOutboxStatus.PENDING,
    attempts: 0,
    availableAt: new Date('2026-08-06T10:16:00.000Z'),
    lastError: null as string | null,
    ...overrides,
  };
}

function buildDrainer() {
  return new UsageOutboxDrainer(
    mockOutboxRepository as never,
    mockEventRepository as never,
    mockHourlyRepository as never,
    mockDailyRepository as never,
    mockPriceBook as never,
    mockUnitOfWork as never,
  );
}

describe('UsageOutboxDrainer — rating', () => {
  let drainer: UsageOutboxDrainer;

  beforeEach(() => {
    vi.clearAllMocks();
    mockUnitOfWork.runInTransaction.mockImplementation(async (work: (tx: unknown) => Promise<unknown>) => work(TX));
    mockEventRepository.create.mockImplementation(async (entity: unknown) => entity);
    mockPriceBook.resolveCostPrice.mockResolvedValue({ priceBookId: 'p1', unitPriceMicros: 3n, bookVersion: 'book-v1', currency: 'USD' });
    drainer = buildDrainer();
  });

  it('rates against the COST plane at occurredAt and stamps price + cost + book version', async () => {
    mockOutboxRepository.findClaimable.mockResolvedValue([outboxRow([serializedEvent()])]);

    await drainer.drainBatch();

    expect(mockPriceBook.resolveCostPrice).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: TENANT,
        capability: AiCapability.LLM,
        unit: AiUsageUnit.INPUT_TOKEN,
        provider: 'anthropic',
        model: 'claude-sonnet-5',
        occurredAt: new Date('2026-08-06T10:15:30.000Z'),
      }),
    );

    const written = mockEventRepository.create.mock.calls[0][0];
    expect(written.unitPriceMicros).toBe(3n);
    expect(written.costMicros).toBe(3000n); // 1000 tokens x 3 micros
    expect(written.priceBookVersion).toBe('book-v1');
  });

  it('stamps a ZERO price as 0, never as unrated', async () => {
    // The seeded STT SESSION_SECOND COGS row is deliberately zero.
    mockPriceBook.resolveCostPrice.mockResolvedValue({ priceBookId: 'p0', unitPriceMicros: 0n, bookVersion: 'book-v1', currency: 'USD' });
    mockOutboxRepository.findClaimable.mockResolvedValue([
      outboxRow([
        serializedEvent({ capability: AiCapability.STT, unit: AiUsageUnit.SESSION_SECOND, provider: 'whisper_cpp', model: null, quantity: '300' }),
      ]),
    ]);

    await drainer.drainBatch();

    const written = mockEventRepository.create.mock.calls[0][0];
    expect(written.unitPriceMicros).toBe(0n);
    expect(written.costMicros).toBe(0n);
    expect(written.priceBookVersion).toBe('book-v1');
  });

  it('records the event UNRATED rather than dropping it when no price resolves', async () => {
    // Rating fails OPEN: a missing rate is repairable by back-rating from the
    // raw ledger; a missing event is not.
    mockPriceBook.resolveCostPrice.mockResolvedValue(null);
    mockOutboxRepository.findClaimable.mockResolvedValue([outboxRow([serializedEvent()])]);

    const report = await drainer.drainBatch();

    const written = mockEventRepository.create.mock.calls[0][0];
    expect(written.unitPriceMicros).toBeNull();
    expect(written.costMicros).toBeNull();
    expect(written.priceBookVersion).toBeNull();
    expect(report.inserted).toBe(1);
  });

  it('keeps fractional quantities exact through the cost multiplication', async () => {
    mockOutboxRepository.findClaimable.mockResolvedValue([
      outboxRow([serializedEvent({ capability: AiCapability.STT, unit: AiUsageUnit.AUDIO_SECOND, quantity: '12.345678' })]),
    ]);

    await drainer.drainBatch();
    // 12.345678 x 3 = 37.037034 -> 37 micros, half-up, no float drift.
    expect(mockEventRepository.create.mock.calls[0][0].costMicros).toBe(37n);
  });
});

describe('UsageOutboxDrainer — ledger append + rollup maintenance', () => {
  let drainer: UsageOutboxDrainer;

  beforeEach(() => {
    vi.clearAllMocks();
    mockUnitOfWork.runInTransaction.mockImplementation(async (work: (tx: unknown) => Promise<unknown>) => work(TX));
    mockEventRepository.create.mockImplementation(async (entity: unknown) => entity);
    mockPriceBook.resolveCostPrice.mockResolvedValue({ priceBookId: 'p1', unitPriceMicros: 3n, bookVersion: 'book-v1', currency: 'USD' });
    drainer = buildDrainer();
  });

  it('appends the event and accumulates BOTH rollups inside ONE transaction', async () => {
    mockOutboxRepository.findClaimable.mockResolvedValue([outboxRow([serializedEvent()])]);

    await drainer.drainBatch();

    expect(mockUnitOfWork.runInTransaction).toHaveBeenCalledTimes(1);
    // Every write carries the SAME tx client — otherwise a crash between them
    // leaves an event with no aggregate and a redrain that will never fix it.
    expect(mockEventRepository.create).toHaveBeenCalledWith(expect.anything(), TX);
    expect(mockHourlyRepository.accumulate).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.anything(), expect.any(String), TX);
    expect(mockDailyRepository.accumulate).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.anything(), expect.any(String), TX);
  });

  it('truncates the rollup buckets to the UTC hour and UTC day of occurredAt', async () => {
    mockOutboxRepository.findClaimable.mockResolvedValue([outboxRow([serializedEvent({ occurredAt: '2026-08-06T10:15:30.500Z' })])]);

    await drainer.drainBatch();

    expect(mockHourlyRepository.accumulate.mock.calls[0][0]).toMatchObject({
      tenantId: TENANT,
      bucketStart: new Date('2026-08-06T10:00:00.000Z'),
      capability: AiCapability.LLM,
      provider: 'anthropic',
      model: 'claude-sonnet-5',
      unit: AiUsageUnit.INPUT_TOKEN,
    });
    expect(mockDailyRepository.accumulate.mock.calls[0][0]).toMatchObject({ bucketStart: new Date('2026-08-06T00:00:00.000Z') });
  });

  it('uses the EMPTY-STRING sentinel for a model-less capability, never null', async () => {
    // A NULL in the unique dimension tuple would let two upserts for the same
    // model-less dimension BOTH insert, silently double-counting.
    mockOutboxRepository.findClaimable.mockResolvedValue([
      outboxRow([serializedEvent({ capability: AiCapability.STT, unit: AiUsageUnit.AUDIO_SECOND, provider: 'whisper_cpp', model: null })]),
    ]);

    await drainer.drainBatch();
    expect(mockHourlyRepository.accumulate.mock.calls[0][0].model).toBe('');
  });

  it('accumulates the rated cost into the rollups', async () => {
    mockOutboxRepository.findClaimable.mockResolvedValue([outboxRow([serializedEvent()])]);
    await drainer.drainBatch();

    const [, quantityDelta, costDelta] = mockHourlyRepository.accumulate.mock.calls[0];
    expect(String(quantityDelta)).toBe('1000');
    expect(costDelta).toBe(3000n);
  });

  it('EXCLUDES BYOK_NOTIONAL cost from the rollups while still stamping it on the event', async () => {
    // Platform-spend reads must not be inflated by tenant-funded calls (D14) —
    // but the tenant still gets to see its notional spend on the raw row.
    mockOutboxRepository.findClaimable.mockResolvedValue([
      outboxRow([serializedEvent({ deployment: AiDeploymentKind.BYOK, costBasis: AiCostBasis.BYOK_NOTIONAL })]),
    ]);

    await drainer.drainBatch();

    expect(mockEventRepository.create.mock.calls[0][0].costMicros).toBe(3000n);
    expect(mockHourlyRepository.accumulate.mock.calls[0][2]).toBe(0n);
    expect(mockDailyRepository.accumulate.mock.calls[0][2]).toBe(0n);
  });

  it('TASK-643 R3: a PLATFORM-FUNDED call contributes its FULL cost to the rollups', async () => {
    // A call served on the platform's own (SYSTEM-tenant) cloud credential is
    // platform vendor spend, so it meters as CLOUD + INTERNAL (OD-2) and its
    // cost must reach the COGS rollups. Asserted alongside its mis-stamp below
    // so the price of getting funding attribution wrong is written down: the
    // SAME call stamped BYOK/BYOK_NOTIONAL contributes NOTHING, silently.
    mockOutboxRepository.findClaimable.mockResolvedValue([
      outboxRow([serializedEvent({ deployment: AiDeploymentKind.CLOUD, costBasis: AiCostBasis.INTERNAL })]),
    ]);

    await drainer.drainBatch();

    expect(mockEventRepository.create.mock.calls[0][0].costMicros).toBe(3000n);
    expect(mockHourlyRepository.accumulate.mock.calls[0][2]).toBe(3000n);
    expect(mockDailyRepository.accumulate.mock.calls[0][2]).toBe(3000n);

    // The mis-stamp this ticket exists to prevent — same call, zero COGS.
    vi.clearAllMocks();
    mockUnitOfWork.runInTransaction.mockImplementation(async (work: (tx: unknown) => Promise<unknown>) => work(TX));
    mockEventRepository.create.mockImplementation(async (entity: unknown) => entity);
    mockPriceBook.resolveCostPrice.mockResolvedValue({ priceBookId: 'p1', unitPriceMicros: 3n, bookVersion: 'book-v1', currency: 'USD' });
    mockOutboxRepository.findClaimable.mockResolvedValue([
      outboxRow([serializedEvent({ deployment: AiDeploymentKind.BYOK, costBasis: AiCostBasis.BYOK_NOTIONAL })]),
    ]);

    await drainer.drainBatch();
    expect(mockHourlyRepository.accumulate.mock.calls[0][2]).toBe(0n);
  });

  it('contributes a ZERO cost delta for an unrated event', async () => {
    mockPriceBook.resolveCostPrice.mockResolvedValue(null);
    mockOutboxRepository.findClaimable.mockResolvedValue([outboxRow([serializedEvent()])]);

    await drainer.drainBatch();
    expect(mockHourlyRepository.accumulate.mock.calls[0][2]).toBe(0n);
  });
});

describe('UsageOutboxDrainer — exactly-once-effective under redelivery', () => {
  let drainer: UsageOutboxDrainer;

  beforeEach(() => {
    vi.clearAllMocks();
    mockUnitOfWork.runInTransaction.mockImplementation(async (work: (tx: unknown) => Promise<unknown>) => work(TX));
    mockPriceBook.resolveCostPrice.mockResolvedValue({ priceBookId: 'p1', unitPriceMicros: 3n, bookVersion: 'book-v1', currency: 'USD' });
    drainer = buildDrainer();
  });

  it('does NOT touch the rollups when the ledger insert hits the idempotency key', async () => {
    // THE anti-double-billing assertion. The original insert already applied
    // its rollup delta inside its own transaction; applying it again here would
    // double every redelivered event.
    mockEventRepository.create.mockRejectedValue({ code: 'P2002', meta: { target: ['idempotencyKey'] } });
    mockOutboxRepository.findClaimable.mockResolvedValue([outboxRow([serializedEvent()])]);

    const report = await drainer.drainBatch();

    expect(mockHourlyRepository.accumulate).not.toHaveBeenCalled();
    expect(mockDailyRepository.accumulate).not.toHaveBeenCalled();
    expect(report).toMatchObject({ inserted: 0, skipped: 1, failed: 0 });
    // The row is still finished — a redelivery is a success, not an error.
    expect(mockOutboxRepository.update).toHaveBeenCalled();
  });

  it('is a full no-op on a complete redrain, then marks the row DISPATCHED', async () => {
    mockEventRepository.create.mockRejectedValue({ code: 'P2002', meta: { target: ['idempotencyKey'] } });
    mockOutboxRepository.findClaimable.mockResolvedValue([
      outboxRow([serializedEvent(), serializedEvent({ idempotencyKey: 'llm:req-1:OUTPUT_TOKEN' })]),
    ]);

    await drainer.drainBatch();

    expect(mockHourlyRepository.accumulate).not.toHaveBeenCalled();
    const marked = mockOutboxRepository.update.mock.calls[0][1];
    expect(marked.status).toBe(AiUsageOutboxStatus.DISPATCHED);
  });

  it('drains the surviving events of a partially-applied row', async () => {
    // The crash-mid-row case: the first event landed on a previous attempt, the
    // second did not. Exactly one insert, exactly one rollup delta.
    mockEventRepository.create
      .mockRejectedValueOnce({ code: 'P2002', meta: { target: ['idempotencyKey'] } })
      .mockImplementationOnce(async (entity: unknown) => entity);
    mockOutboxRepository.findClaimable.mockResolvedValue([
      outboxRow([serializedEvent(), serializedEvent({ idempotencyKey: 'llm:req-1:OUTPUT_TOKEN' })]),
    ]);

    const report = await drainer.drainBatch();

    expect(report).toMatchObject({ inserted: 1, skipped: 1 });
    expect(mockHourlyRepository.accumulate).toHaveBeenCalledTimes(1);
  });

  it('rethrows a NON-idempotency database error so the row retries', async () => {
    // Reporting a connection error as "already recorded" would silently drop
    // usage — the one outcome this table exists to prevent.
    mockEventRepository.create.mockRejectedValue({ code: 'P1001', message: 'cannot reach database' });
    mockOutboxRepository.findClaimable.mockResolvedValue([outboxRow([serializedEvent()])]);

    const report = await drainer.drainBatch();

    expect(report).toMatchObject({ inserted: 0, failed: 1 });
    const retried = mockOutboxRepository.update.mock.calls[0][1];
    expect(retried.status).toBe(AiUsageOutboxStatus.PENDING);
    expect(retried.attempts).toBe(1);
  });
});

describe('UsageOutboxDrainer — retry, backoff and permanent failure', () => {
  let drainer: UsageOutboxDrainer;

  beforeEach(() => {
    vi.clearAllMocks();
    mockUnitOfWork.runInTransaction.mockImplementation(async (work: (tx: unknown) => Promise<unknown>) => work(TX));
    mockPriceBook.resolveCostPrice.mockResolvedValue({ priceBookId: 'p1', unitPriceMicros: 3n, bookVersion: 'book-v1', currency: 'USD' });
    mockEventRepository.create.mockRejectedValue(new Error('boom'));
    drainer = buildDrainer();
  });

  it('pushes availableAt out exponentially on each attempt', async () => {
    const now = new Date('2026-08-06T12:00:00.000Z');
    mockOutboxRepository.findClaimable.mockResolvedValue([outboxRow([serializedEvent()], { attempts: 2 })]);

    await drainer.drainBatch(10, now);

    const retried = mockOutboxRepository.update.mock.calls[0][1];
    expect(retried.attempts).toBe(3);
    // 30s base, doubling: attempt 3 -> 30s * 2^2 = 120s.
    expect(retried.availableAt.getTime()).toBe(now.getTime() + 120_000);
    expect(retried.status).toBe(AiUsageOutboxStatus.PENDING);
  });

  it('caps the backoff so a stuck row is still retried within the hour', async () => {
    const now = new Date('2026-08-06T12:00:00.000Z');
    mockOutboxRepository.findClaimable.mockResolvedValue([outboxRow([serializedEvent()], { attempts: 6 })]);

    await drainer.drainBatch(10, now);
    expect(mockOutboxRepository.update.mock.calls[0][1].availableAt.getTime()).toBe(now.getTime() + 1_800_000);
  });

  it('marks a row FAILED once it exhausts its attempts', async () => {
    mockOutboxRepository.findClaimable.mockResolvedValue([outboxRow([serializedEvent()], { attempts: 7 })]);

    const report = await drainer.drainBatch();

    const failed = mockOutboxRepository.update.mock.calls[0][1];
    expect(failed.status).toBe(AiUsageOutboxStatus.FAILED);
    expect(failed.lastError).toContain('boom');
    expect(report.failed).toBe(1);
  });

  it('bounds lastError — it is a diagnostic, never a payload dump', async () => {
    mockEventRepository.create.mockRejectedValue(new Error('x'.repeat(5000)));
    mockOutboxRepository.findClaimable.mockResolvedValue([outboxRow([serializedEvent()], { attempts: 7 })]);

    await drainer.drainBatch();
    expect(mockOutboxRepository.update.mock.calls[0][1].lastError.length).toBeLessThanOrEqual(500);
  });

  it('FAILS a payload whose version it does not understand — immediately, without retrying', async () => {
    // Re-interpreting an unknown payload shape on a guess is how a money
    // pipeline invents numbers. Retrying it forever is just noise.
    mockOutboxRepository.findClaimable.mockResolvedValue([outboxRow([serializedEvent()], { payload: { version: 99, events: [] } })]);

    const report = await drainer.drainBatch();

    const failed = mockOutboxRepository.update.mock.calls[0][1];
    expect(failed.status).toBe(AiUsageOutboxStatus.FAILED);
    expect(failed.lastError).toMatch(/version/i);
    expect(report.failed).toBe(1);
    expect(mockEventRepository.create).not.toHaveBeenCalled();
  });
});

describe('UsageOutboxDrainer — batch behaviour', () => {
  let drainer: UsageOutboxDrainer;

  beforeEach(() => {
    vi.clearAllMocks();
    mockUnitOfWork.runInTransaction.mockImplementation(async (work: (tx: unknown) => Promise<unknown>) => work(TX));
    mockEventRepository.create.mockImplementation(async (entity: unknown) => entity);
    mockPriceBook.resolveCostPrice.mockResolvedValue({ priceBookId: 'p1', unitPriceMicros: 1n, bookVersion: 'book-v1', currency: 'USD' });
    drainer = buildDrainer();
  });

  it('claims only rows whose backoff has elapsed', async () => {
    const now = new Date('2026-08-06T12:00:00.000Z');
    mockOutboxRepository.findClaimable.mockResolvedValue([]);
    await drainer.drainBatch(25, now);
    expect(mockOutboxRepository.findClaimable).toHaveBeenCalledWith(25, now);
  });

  it('keeps draining after one row fails — one poisoned row must not stall the queue', async () => {
    mockOutboxRepository.findClaimable.mockResolvedValue([
      outboxRow([serializedEvent()], { id: 'bad', payload: { version: 99, events: [] } }),
      outboxRow([serializedEvent()], { id: 'good' }),
    ]);

    const report = await drainer.drainBatch();
    expect(report).toMatchObject({ rows: 2, inserted: 1, failed: 1 });
  });

  it('reports an empty drain without touching anything', async () => {
    mockOutboxRepository.findClaimable.mockResolvedValue([]);
    expect(await drainer.drainBatch()).toEqual({ rows: 0, inserted: 0, skipped: 0, failed: 0 });
    expect(mockOutboxRepository.update).not.toHaveBeenCalled();
  });
});
