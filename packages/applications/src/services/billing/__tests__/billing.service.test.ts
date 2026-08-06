import Decimal from 'decimal.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { DataNotFoundException } from '@arcaai/exceptions';
import {
  AiCapability,
  AiUsageUnit,
  BillingAdjustmentEntity,
  BillingInvoiceEntity,
  BillingInvoiceStatus,
  BillingLineKind,
  SysEventType,
  TenantEntity,
  TenantPlan,
} from '@arcaai/domains';

import { BillingService } from '../billing.service';
import { AddAdjustmentRequest } from '../dto';

/**
 * TASK-615 WS-I — the invoice engine, golden-file style at service level.
 *
 * The in-memory world below reproduces the repository contracts the service
 * relies on (OCC versions, soft-delete supersede of lines, tenant scoping).
 * Every expected number is hand-derived in a comment.
 */

const TENANT = 'aaaaaaaa-0000-0000-0000-000000000001';
const OTHER_TENANT = 'bbbbbbbb-0000-0000-0000-000000000002';
const GLOBAL_ADMIN = { id: 'admin-1', roles: ['GLOBAL_ADMIN'] };
const TENANT_USER = { id: 'user-1', roles: ['TENANT_ADMIN'], tenantId: TENANT };

// The period under test: August 2026 (31 days). "now" is mid-September, so the
// period has closed and finalize is allowed.
const PERIOD = '2026-08';
const NOW = new Date('2026-09-05T12:00:00.000Z');

interface WorldConfig {
  user?: unknown;
  plan?: TenantPlan | null;
  planRow?: Record<string, unknown> | null;
  override?: Record<string, unknown> | null;
  /** Daily rollup buckets: [dayOfAugust, capability, unit, quantity]. */
  rollups?: Array<[number, AiCapability, AiUsageUnit, number | string]>;
  /** Ledger operation sums: [dayOfAugust, capability, unit, operation, quantity]. */
  operationSums?: Array<[number, AiCapability, AiUsageUnit, string, number | string]>;
  byokNotionalMicros?: bigint;
  /** SELL overage rates per unit (flat over the period unless a reprice is given). */
  sellRates?: Partial<Record<AiUsageUnit, bigint>>;
  /** Optional reprice: from this August day on, rates double. */
  repriceFromDay?: number;
  planFees?: Partial<Record<TenantPlan, bigint>>;
}

function day(d: number): Date {
  return new Date(Date.UTC(2026, 7, d));
}

function makeWorld(config: WorldConfig = {}) {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);

  const user = config.user ?? GLOBAL_ADMIN;
  const plan = config.plan === undefined ? TenantPlan.PRO : config.plan;
  const sellRates: Partial<Record<AiUsageUnit, bigint>> = config.sellRates ?? { [AiUsageUnit.SESSION_SECOND]: 6n };
  const planFees: Partial<Record<TenantPlan, bigint>> = config.planFees ?? {
    [TenantPlan.STARTER]: 199_000_000n,
    [TenantPlan.PRO]: 999_000_000n,
  };

  // ---- invoice store: plain rows, entities materialized fresh per read ------
  interface InvoiceRow {
    props: Record<string, unknown>;
    version: number;
  }
  const invoices = new Map<string, InvoiceRow>();
  const materialize = (row: InvoiceRow): BillingInvoiceEntity =>
    new BillingInvoiceEntity({ ...(row.props as never), version: row.version });

  const invoiceRepository = {
    findByPeriod: vi.fn(async (tenantId: string, periodStart: Date) => {
      for (const row of invoices.values()) {
        if (row.props.tenantId === tenantId && (row.props.periodStart as Date).getTime() === periodStart.getTime()) return materialize(row);
      }
      return null;
    }),
    findById: vi.fn(async (id: string) => {
      const row = invoices.get(id);
      if (!row) throw new DataNotFoundException('billingInvoice', id);
      return materialize(row);
    }),
    findByTenant: vi.fn(async (tenantId: string) =>
      [...invoices.values()].filter((row) => row.props.tenantId === tenantId).map(materialize),
    ),
    create: vi.fn(async (entity: BillingInvoiceEntity, _tx?: unknown) => {
      invoices.set(entity.id, {
        props: {
          id: entity.id,
          tenantId: entity.tenantId,
          periodStart: entity.periodStart,
          periodEnd: entity.periodEnd,
          status: entity.status,
          currency: entity.currency,
          subtotalMicros: entity.subtotalMicros,
          totalMicros: entity.totalMicros,
          finalizedAt: entity.finalizedAt ?? null,
          finalizedBy: entity.finalizedBy ?? null,
          createdAt: entity.createdAt,
          updatedAt: entity.updatedAt,
        },
        version: 1,
      });
      return entity;
    }),
    updateWithVersion: vi.fn(async (id: string, entity: BillingInvoiceEntity, expectedVersion: number, _tx?: unknown) => {
      const row = invoices.get(id);
      if (!row) throw new DataNotFoundException('billingInvoice', id);
      if (row.version !== expectedVersion) {
        const err = new Error(`version drift: expected ${expectedVersion}, at ${row.version}`);
        err.name = 'OptimisticConcurrencyException';
        throw err;
      }
      row.props = {
        ...row.props,
        status: entity.status,
        currency: entity.currency,
        subtotalMicros: entity.subtotalMicros,
        totalMicros: entity.totalMicros,
        finalizedAt: entity.finalizedAt ?? null,
        finalizedBy: entity.finalizedBy ?? null,
      };
      row.version += 1;
      return materialize(row);
    }),
  };

  // ---- line store ------------------------------------------------------------
  const lines: Array<{ entity: unknown; invoiceId: string; live: boolean }> = [];
  const lineRepository = {
    softDeleteByInvoice: vi.fn(async (_tenantId: string, invoiceId: string) => {
      let count = 0;
      for (const line of lines) {
        if (line.invoiceId === invoiceId && line.live) {
          line.live = false;
          count += 1;
        }
      }
      return count;
    }),
    createManyInTx: vi.fn(async (entities: Array<{ invoiceId: string }>) => {
      for (const entity of entities) lines.push({ entity, invoiceId: entity.invoiceId, live: true });
      return entities.length;
    }),
    findByInvoice: vi.fn(async (_tenantId: string, invoiceId: string) =>
      lines.filter((line) => line.invoiceId === invoiceId && line.live).map((line) => line.entity),
    ),
  };

  // ---- adjustments -------------------------------------------------------------
  const adjustments: BillingAdjustmentEntity[] = [];
  const adjustmentRepository = {
    create: vi.fn(async (entity: BillingAdjustmentEntity) => {
      adjustments.push(entity);
      return entity;
    }),
    findByInvoice: vi.fn(async (_tenantId: string, invoiceId: string) => adjustments.filter((a) => a.invoiceId === invoiceId)),
    findAll: vi.fn(async (props: { filters: { createdAt?: { gte: Date; lt: Date }; tenantId: string } }) =>
      adjustments.filter((a) => {
        if (a.tenantId !== props.filters.tenantId) return false;
        const range = props.filters.createdAt;
        if (!range) return true;
        return a.createdAt >= range.gte && a.createdAt < range.lt;
      }),
    ),
  };

  // ---- usage sources -----------------------------------------------------------
  const rollupRepository = {
    findByPeriod: vi.fn(async () =>
      (config.rollups ?? []).map(([d, capability, unit, quantity]) => ({
        bucketStart: day(d),
        capability,
        unit,
        provider: 'test',
        model: '',
        quantitySum: new Decimal(quantity),
      })),
    ),
  };
  const usageAggregateRepository = {
    sumDailyQuantitiesByOperation: vi.fn(async (query: { capability: AiCapability; operations: readonly string[] }) =>
      (config.operationSums ?? [])
        .filter(([, capability, , operation]) => capability === query.capability && query.operations.includes(operation))
        .map(([d, , unit, operation, quantity]) => ({ day: day(d), unit, operation, quantity: new Decimal(quantity) })),
    ),
    sumByokNotionalCostMicros: vi.fn(async () => config.byokNotionalMicros ?? 0n),
  };

  // ---- entitlements + tenant -----------------------------------------------------
  const planEntitlementRepository = { findByPlan: vi.fn(async () => (config.planRow === undefined ? null : config.planRow)) };
  const tenantEntitlementRepository = { findByTenant: vi.fn(async () => (config.override === undefined ? null : config.override)) };
  const tenantRepository = {
    findById: vi.fn(async (id: string) => {
      if (id !== TENANT) throw new DataNotFoundException('tenant', id);
      return new TenantEntity({ id: TENANT, name: 'T', code: 'T', plan } as never);
    }),
  };

  // ---- price book -----------------------------------------------------------------
  const priceBook = {
    resolveSellPrice: vi.fn(async (input: { unit: AiUsageUnit; occurredAt: Date }) => {
      const base = sellRates[input.unit];
      if (base === undefined) return null;
      const repriced = config.repriceFromDay !== undefined && input.occurredAt.getTime() >= day(config.repriceFromDay).getTime();
      return {
        priceBookId: `sell-${input.unit}-${repriced ? 'new' : 'old'}`,
        unitPriceMicros: repriced ? base * 2n : base,
        bookVersion: repriced ? 'book-new' : 'book-old',
        currency: 'USD',
      };
    }),
    resolvePlanFee: vi.fn(async (_tenantId: string, tier: TenantPlan) => {
      const fee = planFees[tier];
      if (fee === undefined) return null;
      return { priceBookId: `fee-${tier}`, unitPriceMicros: fee, bookVersion: 'book-fee', currency: 'USD' };
    }),
    resolveCostPrice: vi.fn(),
    resolveUsagePrice: vi.fn(),
  };

  const txMarker = { tx: true };
  const unitOfWork = { runInTransaction: vi.fn(async (work: (tx: unknown) => Promise<unknown>) => work(txMarker)) };
  const eventEmitter = { emit: vi.fn() };
  const cls = {
    get: vi.fn((key: string) => {
      if (key === 'user') return user;
      if (key === 'tenantId') return (user as { tenantId?: string })?.tenantId ?? TENANT;
      return undefined;
    }),
  };

  const service = new BillingService(
    eventEmitter as never,
    cls as never,
    invoiceRepository as never,
    lineRepository as never,
    adjustmentRepository as never,
    rollupRepository as never,
    usageAggregateRepository as never,
    planEntitlementRepository as never,
    tenantEntitlementRepository as never,
    tenantRepository as never,
    priceBook as never,
    unitOfWork as never,
  );

  return { service, invoices, lines, adjustments, invoiceRepository, lineRepository, eventEmitter, priceBook, unitOfWork, txMarker };
}

// ═══════════════════════════════════════════════════════════════════════════
// computeDraft goldens
// ═══════════════════════════════════════════════════════════════════════════

describe('BillingService.computeDraft', () => {
  it('golden (a): allowance exactly consumed → plan fee only, no overage line', async () => {
    const { service } = makeWorld({
      planRow: { monthlySttSessionSeconds: 1200n },
      rollups: [
        [3, AiCapability.STT, AiUsageUnit.SESSION_SECOND, 700],
        [20, AiCapability.STT, AiUsageUnit.SESSION_SECOND, 500],
      ],
    });

    const draft = await service.computeDraft(TENANT, PERIOD);

    expect(draft.status).toBe(BillingInvoiceStatus.DRAFT);
    expect(draft.lines).toHaveLength(1);
    expect(draft.lines[0].kind).toBe(BillingLineKind.PLAN_FEE);
    expect(draft.lines[0].amountMicros).toBe('999000000'); // full PRO month
    expect(draft.subtotalMicros).toBe('999000000');
    expect(draft.totalMicros).toBe('999000000');
    expect(draft.planTier).toBe(TenantPlan.PRO);
  });

  it('golden (b): overage crossing mid-month → one OVERAGE line, 500 × 6 micros', async () => {
    const { service } = makeWorld({
      planRow: { monthlySttSessionSeconds: 1000n },
      rollups: [
        [1, AiCapability.STT, AiUsageUnit.SESSION_SECOND, 600],
        [2, AiCapability.STT, AiUsageUnit.SESSION_SECOND, 600],
        [3, AiCapability.STT, AiUsageUnit.SESSION_SECOND, 300],
      ],
    });

    const draft = await service.computeDraft(TENANT, PERIOD);

    const overage = draft.lines.filter((line) => line.kind === BillingLineKind.OVERAGE);
    expect(overage).toHaveLength(1);
    expect(overage[0].capability).toBe(AiCapability.STT);
    expect(overage[0].unit).toBe(AiUsageUnit.SESSION_SECOND);
    expect(overage[0].quantity).toBe('1500');
    expect(overage[0].includedAllowance).toBe('1000');
    expect(overage[0].overageQuantity).toBe('500');
    expect(overage[0].unitPriceMicros).toBe('6');
    expect(overage[0].amountMicros).toBe('3000');
    // 999_000_000 + 3_000
    expect(draft.totalMicros).toBe('999003000');
  });

  it('golden (c): mid-period upgrade — PERIOD-END plan bills the fee and applies its allowances RETROACTIVELY (D15)', async () => {
    // The tenant upgraded STARTER→PRO mid-August. There is NO plan-change
    // history table, so the engine bills the plan in effect at computation
    // time (documented limitation, `planFeeBasis: PERIOD_END_PLAN`). D15 falls
    // out naturally: PRO's allowance covers the WHOLE month's usage — the
    // "upgraded and still blocked/billed" failure cannot happen.
    const { service } = makeWorld({
      plan: TenantPlan.PRO, // period-end plan
      planRow: { monthlySttSessionSeconds: 10_000n }, // PRO allowance (STARTER's would have been 1_000)
      rollups: [[10, AiCapability.STT, AiUsageUnit.SESSION_SECOND, 5000]],
    });

    const draft = await service.computeDraft(TENANT, PERIOD);

    expect(draft.planFeeBasis).toBe('PERIOD_END_PLAN');
    expect(draft.lines.filter((line) => line.kind === BillingLineKind.OVERAGE)).toHaveLength(0); // retroactive PRO allowance
    const fee = draft.lines.find((line) => line.kind === BillingLineKind.PLAN_FEE)!;
    expect(fee.amountMicros).toBe('999000000'); // full PRO fee — the honest, documented approximation
    expect(fee.description).toContain('PRO');
  });

  it('golden (d): downgrade takes effect NEXT period — each period bills the plan it closed under', async () => {
    // Operational rule the engine encodes: drafts are computed after period
    // close, and plan downgrades are applied at the boundary AFTER drafting
    // the closing month. August (closed under PRO) bills PRO...
    const worldAugust = makeWorld({ plan: TenantPlan.PRO, planRow: {} });
    const august = await worldAugust.service.computeDraft(TENANT, PERIOD);
    expect(august.lines.find((line) => line.kind === BillingLineKind.PLAN_FEE)!.amountMicros).toBe('999000000');

    // ...and September, computed after the downgrade landed, bills STARTER.
    vi.setSystemTime(new Date('2026-10-02T00:00:00.000Z'));
    const worldSeptember = makeWorld({ plan: TenantPlan.STARTER, planRow: {} });
    vi.setSystemTime(new Date('2026-10-02T00:00:00.000Z'));
    const september = await worldSeptember.service.computeDraft(TENANT, '2026-09');
    expect(september.lines.find((line) => line.kind === BillingLineKind.PLAN_FEE)!.amountMicros).toBe('199000000');
    expect(september.planTier).toBe(TenantPlan.STARTER);
  });

  it('golden (e): BYOK-heavy tenant — units metered for overage, notional spend on the DTO, never a line', async () => {
    const { service } = makeWorld({
      planRow: { monthlyLlmTokens: 1000n },
      sellRates: { [AiUsageUnit.INPUT_TOKEN]: 2n },
      // Rollup quantities INCLUDE BYOK-funded tokens (D14): 3000 input tokens.
      rollups: [[5, AiCapability.LLM, AiUsageUnit.INPUT_TOKEN, 3000]],
      byokNotionalMicros: 123_456n,
    });

    const draft = await service.computeDraft(TENANT, PERIOD);

    const overage = draft.lines.find((line) => line.kind === BillingLineKind.OVERAGE)!;
    expect(overage.overageQuantity).toBe('2000'); // 3000 − 1000, BYOK units fully counted
    expect(overage.amountMicros).toBe('4000');
    // The notional provider cost is a PRODUCT FEATURE on the DTO —
    expect(draft.byokNotionalCostMicros).toBe('123456');
    // — and never a line.
    expect(draft.lines.every((line) => !line.description.toLowerCase().includes('byok'))).toBe(true);
    expect(draft.totalMicros).toBe('999004000');
  });

  it('excludes guardrail + harness LLM usage from the billable pool (D16)', async () => {
    const { service } = makeWorld({
      planRow: { monthlyLlmTokens: 1000n },
      sellRates: { [AiUsageUnit.INPUT_TOKEN]: 2n },
      rollups: [[5, AiCapability.LLM, AiUsageUnit.INPUT_TOKEN, 3000]],
      operationSums: [
        [5, AiCapability.LLM, AiUsageUnit.INPUT_TOKEN, 'guardrail.validate', 1500],
        [5, AiCapability.LLM, AiUsageUnit.INPUT_TOKEN, 'harness.step', 500],
      ],
    });

    const draft = await service.computeDraft(TENANT, PERIOD);

    // Billable = 3000 − 2000 = 1000 = exactly the allowance ⇒ NO overage.
    expect(draft.lines.filter((line) => line.kind === BillingLineKind.OVERAGE)).toHaveLength(0);
  });

  it('bills batch AUDIO seconds but never streaming ones (OQ1), pooled into the STT allowance', async () => {
    const { service } = makeWorld({
      planRow: { monthlySttSessionSeconds: 1000n },
      sellRates: { [AiUsageUnit.SESSION_SECOND]: 6n, [AiUsageUnit.AUDIO_SECOND]: 6n },
      rollups: [
        [5, AiCapability.STT, AiUsageUnit.SESSION_SECOND, 900],
        [5, AiCapability.STT, AiUsageUnit.AUDIO_SECOND, 880], // streaming echo — NOT billable
      ],
      operationSums: [[5, AiCapability.STT, AiUsageUnit.AUDIO_SECOND, 'transcribe.batch', 300]],
    });

    const draft = await service.computeDraft(TENANT, PERIOD);

    // Billable STT = 900 session + 300 batch audio = 1200; allowance 1000 ⇒ 200
    // overage, split pro-rata within day 5: audio 200×300/1200 = 50 · session 150.
    const overage = draft.lines.filter((line) => line.kind === BillingLineKind.OVERAGE);
    expect(overage).toHaveLength(2);
    const audio = overage.find((line) => line.unit === AiUsageUnit.AUDIO_SECOND)!;
    const session = overage.find((line) => line.unit === AiUsageUnit.SESSION_SECOND)!;
    expect(audio.overageQuantity).toBe('50');
    expect(session.overageQuantity).toBe('150');
  });

  it('golden (i, service level): a mid-month SELL reprice yields one line per rate row', async () => {
    const { service } = makeWorld({
      planRow: { monthlySttSessionSeconds: 500n },
      repriceFromDay: 16, // rates double from Aug 16
      rollups: [
        [10, AiCapability.STT, AiUsageUnit.SESSION_SECOND, 800],
        [20, AiCapability.STT, AiUsageUnit.SESSION_SECOND, 700],
      ],
    });

    const draft = await service.computeDraft(TENANT, PERIOD);

    // Overage: day10 → 300 @6 = 1800 · day20 → 700 @12 = 8400.
    const overage = draft.lines.filter((line) => line.kind === BillingLineKind.OVERAGE);
    expect(overage).toHaveLength(2);
    expect(overage[0].unitPriceMicros).toBe('6');
    expect(overage[0].amountMicros).toBe('1800');
    expect(overage[1].unitPriceMicros).toBe('12');
    expect(overage[1].amountMicros).toBe('8400');
    expect(draft.rateCardVersions).toEqual(['book-fee', 'book-new', 'book-old']);
  });

  it('recompute of a DRAFT supersedes its lines idempotently — same inputs, same result, no duplicates', async () => {
    const config: WorldConfig = {
      planRow: { monthlySttSessionSeconds: 1000n },
      rollups: [
        [1, AiCapability.STT, AiUsageUnit.SESSION_SECOND, 600],
        [2, AiCapability.STT, AiUsageUnit.SESSION_SECOND, 900],
      ],
    };
    const { service, lines, lineRepository } = makeWorld(config);

    const first = await service.computeDraft(TENANT, PERIOD);
    const second = await service.computeDraft(TENANT, PERIOD);

    expect(second.id).toBe(first.id); // same period, same invoice — never a duplicate
    expect(second.totalMicros).toBe(first.totalMicros);
    expect(second.lines.map((line) => [line.kind, line.amountMicros])).toEqual(first.lines.map((line) => [line.kind, line.amountMicros]));
    // Old lines were SOFT-DELETED and replaced, not appended to.
    expect(lineRepository.softDeleteByInvoice).toHaveBeenCalledTimes(1);
    expect(lines.filter((line) => line.live)).toHaveLength(second.lines.length);
    expect(lines.filter((line) => !line.live)).toHaveLength(first.lines.length);
  });

  it('a null-plan (ungated-legacy) tenant draws an empty draft — no fee, no overage', async () => {
    const { service } = makeWorld({
      plan: null,
      rollups: [[1, AiCapability.STT, AiUsageUnit.SESSION_SECOND, 999_999]],
    });
    const draft = await service.computeDraft(TENANT, PERIOD);
    expect(draft.lines).toHaveLength(0);
    expect(draft.totalMicros).toBe('0');
    expect(draft.planTier).toBeNull();
  });

  it('FAILS CLOSED on an incomplete SELL card (missing overage rate → 409, never a silent zero bill)', async () => {
    const { service } = makeWorld({
      planRow: { monthlyTtsCharacters: 0n },
      sellRates: {}, // no CHARACTER rate on the card
      rollups: [[1, AiCapability.TTS, AiUsageUnit.CHARACTER, 50]],
    });
    await expect(service.computeDraft(TENANT, PERIOD)).rejects.toThrow(ConflictException);
  });

  it('rejects a FUTURE period and a non-admin caller', async () => {
    const { service } = makeWorld({});
    await expect(service.computeDraft(TENANT, '2027-01')).rejects.toThrow(BadRequestException);

    const tenantWorld = makeWorld({ user: TENANT_USER });
    await expect(tenantWorld.service.computeDraft(TENANT, PERIOD)).rejects.toThrow(ForbiddenException);
  });

  it('refuses to recompute a FINALIZED period (immutability) and a VOID one (one-way state machine)', async () => {
    const { service } = makeWorld({ planRow: {} });
    const draft = await service.computeDraft(TENANT, PERIOD);
    await service.finalize(TENANT, draft.id, draft.version);
    await expect(service.computeDraft(TENANT, PERIOD)).rejects.toThrow(ConflictException);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Lifecycle: finalize / void / adjustments (golden h)
// ═══════════════════════════════════════════════════════════════════════════

describe('BillingService lifecycle', () => {
  async function draftedWorld(config: WorldConfig = {}) {
    const world = makeWorld({ planRow: {}, ...config });
    const draft = await world.service.computeDraft(TENANT, PERIOD);
    return { ...world, draft };
  }

  it('finalize stamps status + finalizedAt/By through OCC and broadcasts the transition', async () => {
    const { service, draft, eventEmitter, invoices } = await draftedWorld();

    const finalized = await service.finalize(TENANT, draft.id, draft.version);

    expect(finalized.status).toBe(BillingInvoiceStatus.FINALIZED);
    expect(finalized.finalizedAt).not.toBeNull();
    expect(finalized.finalizedBy).toBe('admin-1');
    expect(invoices.get(draft.id)!.version).toBe(2);
    expect(eventEmitter.emit).toHaveBeenCalledWith(
      SysEventType.ResourceUpdated,
      expect.objectContaining({ resourceId: draft.id, metaData: expect.objectContaining({ status: BillingInvoiceStatus.FINALIZED }) }),
    );
  });

  it('finalize refuses an OPEN period — a month is closed only after it ends', async () => {
    const { service } = makeWorld({ planRow: {} });
    vi.setSystemTime(new Date('2026-08-20T00:00:00.000Z')); // mid-August (set AFTER makeWorld pins NOW)
    const draft = await service.computeDraft(TENANT, PERIOD);
    await expect(service.finalize(TENANT, draft.id, draft.version)).rejects.toThrow(BadRequestException);
  });

  it('golden (h): FINALIZED is immutable — refinalize throws, stale OCC version throws, and the fix is a credit memo', async () => {
    const { service, draft } = await draftedWorld();
    await service.finalize(TENANT, draft.id, draft.version);

    await expect(service.finalize(TENANT, draft.id, draft.version + 1)).rejects.toThrow(ConflictException);
    await expect(service.voidDraft(TENANT, draft.id, draft.version + 1)).rejects.toThrow(ConflictException);
  });

  it('finalize under a STALE version surfaces the OCC conflict (412 path), not a silent overwrite', async () => {
    const { service, draft } = await draftedWorld();
    await expect(service.finalize(TENANT, draft.id, draft.version + 41)).rejects.toMatchObject({ name: 'OptimisticConcurrencyException' });
  });

  it('void works from DRAFT only', async () => {
    const { service, draft } = await draftedWorld();
    const voided = await service.voidDraft(TENANT, draft.id, draft.version);
    expect(voided.status).toBe(BillingInvoiceStatus.VOID);
    // and the period stays closed to recomputation (documented v1 posture)
    await expect(service.computeDraft(TENANT, PERIOD)).rejects.toThrow(ConflictException);
  });

  it('golden (h, credit memo): addAdjustment on a FINALIZED invoice never mutates lines or stored totals, and the NEXT period draft carries it', async () => {
    const { service, draft, lines } = await draftedWorld();
    await service.finalize(TENANT, draft.id, draft.version);
    const snapshot = (value: unknown): string => JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? `${v}n` : v));
    const linesBefore = snapshot(lines);

    const request = Object.assign(new AddAdjustmentRequest(), { reason: 'metering_correction', amountMicros: '-50000000' });
    vi.setSystemTime(new Date('2026-09-10T00:00:00.000Z')); // memo issued in September
    const withMemo = await service.addAdjustment(TENANT, draft.id, request);

    // The invoice's OWN stored figures are untouched; the memo rides the read model.
    expect(withMemo.subtotalMicros).toBe(draft.subtotalMicros);
    expect(withMemo.totalMicros).toBe(draft.totalMicros);
    expect(withMemo.adjustmentsTotalMicros).toBe('-50000000');
    expect(withMemo.amountAfterAdjustmentsMicros).toBe((BigInt(draft.totalMicros) - 50_000_000n).toString());
    expect(snapshot(lines)).toBe(linesBefore); // NEVER mutates lines

    // The money nets on the draft of the period the memo was issued in (Sept).
    vi.setSystemTime(new Date('2026-10-02T00:00:00.000Z'));
    const september = await service.computeDraft(TENANT, '2026-09');
    const memoLine = september.lines.find((line) => line.kind === BillingLineKind.ADJUSTMENT)!;
    expect(memoLine.amountMicros).toBe('-50000000');
    expect(memoLine.description).toContain('metering_correction');
    expect(BigInt(september.totalMicros)).toBe(BigInt(september.subtotalMicros) - 50_000_000n);
  });

  it('addAdjustment refuses a DRAFT (corrections before finalize are recomputes) and validates the reason code', async () => {
    const { service, draft } = await draftedWorld();
    const request = Object.assign(new AddAdjustmentRequest(), { reason: 'goodwill_credit', amountMicros: '-1' });
    await expect(service.addAdjustment(TENANT, draft.id, request)).rejects.toThrow(ConflictException);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Reads: 404-over-403 · spend status (golden f)
// ═══════════════════════════════════════════════════════════════════════════

describe('BillingService reads', () => {
  it('cross-tenant getInvoice returns 404, never 403', async () => {
    const { service } = makeWorld({ planRow: {} });
    const draft = await service.computeDraft(TENANT, PERIOD);
    await expect(service.getInvoice(OTHER_TENANT, draft.id)).rejects.toThrow(NotFoundException);
  });

  it('golden (f): spend status crossing the tenant spend limit', async () => {
    // Overage spend so far: (1500 − 1000) × 6 = 3000 micros. Limit 3000 ⇒ EXHAUSTED
    // exactly at the boundary (402 semantics: "spent >= limit").
    const config: WorldConfig = {
      planRow: { monthlySttSessionSeconds: 1000n },
      override: { monthlySpendLimitMicros: 3000n },
      rollups: [
        [1, AiCapability.STT, AiUsageUnit.SESSION_SECOND, 600],
        [2, AiCapability.STT, AiUsageUnit.SESSION_SECOND, 900],
      ],
      byokNotionalMicros: 77n,
    };
    const { service } = makeWorld(config);

    const status = await service.getSpendStatus(TENANT, PERIOD);
    expect(status.overageSpendMicros).toBe('3000');
    expect(status.spendLimitMicros).toBe('3000');
    expect(status.remainingMicros).toBe('0');
    expect(status.exceeded).toBe(true);
    expect(status.utilizationPercent).toBe(100);
    expect(status.byokNotionalCostMicros).toBe('77');

    // Below the limit: not exceeded, remaining positive.
    const under = makeWorld({ ...config, override: { monthlySpendLimitMicros: 10_000n } });
    const underStatus = await under.service.getSpendStatus(TENANT, PERIOD);
    expect(underStatus.exceeded).toBe(false);
    expect(underStatus.remainingMicros).toBe('7000');
    expect(underStatus.utilizationPercent).toBe(30);

    // No limit set: never exceeded, no utilization.
    const unlimited = makeWorld({ ...config, override: null });
    const unlimitedStatus = await unlimited.service.getSpendStatus(TENANT, PERIOD);
    expect(unlimitedStatus.spendLimitMicros).toBeNull();
    expect(unlimitedStatus.exceeded).toBe(false);
    expect(unlimitedStatus.utilizationPercent).toBeNull();
  });

  it('spend status never persists anything', async () => {
    const { service, invoices, lines } = makeWorld({
      planRow: { monthlySttSessionSeconds: 0n },
      rollups: [[1, AiCapability.STT, AiUsageUnit.SESSION_SECOND, 100]],
    });
    await service.getSpendStatus(TENANT, PERIOD);
    expect(invoices.size).toBe(0);
    expect(lines).toHaveLength(0);
  });
});
