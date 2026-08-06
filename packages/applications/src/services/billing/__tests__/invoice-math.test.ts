import Decimal from 'decimal.js';
import { describe, expect, it } from 'vitest';
import { AiCapability, AiUsageUnit, BillingLineKind, TenantPlan } from '@arcaai/domains';

import { parseBillingPeriod } from '../billing-period';
import {
  CurrencyMismatchError,
  DailyUnitQuantity,
  InvoiceLineDraft,
  MissingSellRateError,
  ResolvedSellRate,
  SellRateResolver,
  computeCapabilityOverage,
  computeInvoiceTotals,
  computePlanFeeLines,
} from '../invoice-math';

/**
 * TASK-615 WS-I golden tests — the invoice math itself.
 *
 * Every number in this file is computed BY HAND in the comments next to it.
 * The ONE documented rounding rule: integer micros end to end, HALF-UP at
 * line level (the same rule the COST rater applies per event), so an invoice
 * total always equals the sum of its lines by construction.
 */

const PERIOD = parseBillingPeriod('2026-08'); // 31 days

const day = (d: number): Date => new Date(Date.UTC(2026, 7, d));

function rate(unitPriceMicros: bigint, priceBookId = 'rate-1', currency = 'USD'): ResolvedSellRate {
  return { priceBookId, unitPriceMicros, bookVersion: 'test-book', currency };
}

/** A resolver returning one flat rate for every (unit, day). */
function flatResolver(unitPriceMicros: bigint): SellRateResolver {
  return () => rate(unitPriceMicros);
}

function usage(d: number, unit: AiUsageUnit, quantity: Decimal.Value): DailyUnitQuantity {
  return { day: day(d), unit, quantity: new Decimal(quantity) };
}

// ---------------------------------------------------------------------------
// Plan-fee proration (D15 — daily, day-bucket ownership)
// ---------------------------------------------------------------------------

describe('computePlanFeeLines', () => {
  it('bills exactly the full fee for a single segment covering the whole period', () => {
    const lines = computePlanFeeLines(
      [
        {
          planTier: TenantPlan.PRO,
          from: PERIOD.start,
          to: PERIOD.end,
          feeMicrosPerPeriod: 999_000_000n,
          priceBookId: 'fee-pro',
          bookVersion: 'test-book',
          currency: 'USD',
        },
      ],
      PERIOD,
    );

    expect(lines).toHaveLength(1);
    expect(lines[0].kind).toBe(BillingLineKind.PLAN_FEE);
    // Full month ⇒ EXACTLY the fee — proration must never nibble micros off
    // the ordinary case. 999_000_000 × 31/31 = 999_000_000.
    expect(lines[0].amountMicros).toBe(999_000_000n);
    expect(lines[0].unitPriceMicros).toBe(999_000_000n);
    expect(lines[0].quantity?.toNumber()).toBe(31);
    expect(lines[0].capability).toBeNull();
    expect(lines[0].unit).toBeNull();
  });

  it('prorates a mid-month upgrade daily, HALF-UP per line (golden c — fee part)', () => {
    // STARTER (199.00) upgraded to PRO (999.00) at 2026-08-15T10:00Z.
    // STARTER owns [08-01..08-15) = 14 days: 199e6 × 14/31 = 89,870,967.74… → 89,870,968
    // PRO owns [08-15..09-01) = 17 days:     999e6 × 17/31 = 547,838,709.67… → 547,838,710
    const changeAt = new Date('2026-08-15T10:00:00.000Z');
    const lines = computePlanFeeLines(
      [
        {
          planTier: TenantPlan.STARTER,
          from: PERIOD.start,
          to: changeAt,
          feeMicrosPerPeriod: 199_000_000n,
          priceBookId: 'fee-starter',
          bookVersion: 'test-book',
          currency: 'USD',
        },
        {
          planTier: TenantPlan.PRO,
          from: changeAt,
          to: PERIOD.end,
          feeMicrosPerPeriod: 999_000_000n,
          priceBookId: 'fee-pro',
          bookVersion: 'test-book',
          currency: 'USD',
        },
      ],
      PERIOD,
    );

    expect(lines).toHaveLength(2);
    expect(lines[0].amountMicros).toBe(89_870_968n);
    expect(lines[0].quantity?.toNumber()).toBe(14);
    expect(lines[1].amountMicros).toBe(547_838_710n);
    expect(lines[1].quantity?.toNumber()).toBe(17);
    // Descriptions are bounded labels, never tenant input.
    expect(lines[0].description).toContain('STARTER');
    expect(lines[0].description).toContain('14/31');
  });

  it('drops a zero-day segment instead of emitting a 0-amount line', () => {
    const changeAt = new Date('2026-08-01T08:00:00.000Z'); // same-day change: old plan owns 0 days
    const lines = computePlanFeeLines(
      [
        {
          planTier: TenantPlan.STARTER,
          from: PERIOD.start,
          to: changeAt,
          feeMicrosPerPeriod: 199_000_000n,
          priceBookId: 'fee-starter',
          bookVersion: 'test-book',
          currency: 'USD',
        },
        {
          planTier: TenantPlan.PRO,
          from: changeAt,
          to: PERIOD.end,
          feeMicrosPerPeriod: 999_000_000n,
          priceBookId: 'fee-pro',
          bookVersion: 'test-book',
          currency: 'USD',
        },
      ],
      PERIOD,
    );
    expect(lines).toHaveLength(1);
    expect(lines[0].amountMicros).toBe(999_000_000n); // 31/31 of PRO
  });

  it('keeps a genuinely zero-priced fee line (TRIAL is free by decision, and the line documents it)', () => {
    const lines = computePlanFeeLines(
      [
        {
          planTier: TenantPlan.TRIAL,
          from: PERIOD.start,
          to: PERIOD.end,
          feeMicrosPerPeriod: 0n,
          priceBookId: 'fee-trial',
          bookVersion: 'test-book',
          currency: 'USD',
        },
      ],
      PERIOD,
    );
    expect(lines).toHaveLength(1);
    expect(lines[0].amountMicros).toBe(0n);
  });
});

// ---------------------------------------------------------------------------
// Overage attribution (D11 pooled allowance, D12 rates, split-rate months)
// ---------------------------------------------------------------------------

describe('computeCapabilityOverage', () => {
  it('golden (a): allowance exactly consumed → NO overage line', () => {
    const result = computeCapabilityOverage(
      {
        capability: AiCapability.STT,
        allowance: new Decimal(1200),
        usage: [usage(3, AiUsageUnit.SESSION_SECOND, 700), usage(20, AiUsageUnit.SESSION_SECOND, 500)],
      },
      flatResolver(6n),
    );
    expect(result.lines).toHaveLength(0);
    expect(result.overageQuantity.toNumber()).toBe(0);
    expect(result.totalQuantity.toNumber()).toBe(1200);
  });

  it('golden (b): overage crossing mid-month → correct quantity × rate', () => {
    // Allowance 1000. day1: 600 (cum 600, no overage) · day2: 600 (cum 1200,
    // overage 200) · day3: 300 (cum 1500, overage 300). Total overage 500.
    // 500 × 6 micros = 3000 micros.
    const result = computeCapabilityOverage(
      {
        capability: AiCapability.STT,
        allowance: new Decimal(1000),
        usage: [
          usage(1, AiUsageUnit.SESSION_SECOND, 600),
          usage(2, AiUsageUnit.SESSION_SECOND, 600),
          usage(3, AiUsageUnit.SESSION_SECOND, 300),
        ],
      },
      flatResolver(6n),
    );

    expect(result.lines).toHaveLength(1);
    const line = result.lines[0];
    expect(line.kind).toBe(BillingLineKind.OVERAGE);
    expect(line.capability).toBe(AiCapability.STT);
    expect(line.unit).toBe(AiUsageUnit.SESSION_SECOND);
    expect(line.quantity?.toNumber()).toBe(1500); // full period usage of the unit
    expect(line.includedAllowance?.toNumber()).toBe(1000); // the pooled capability allowance
    expect(line.overageQuantity?.toNumber()).toBe(500);
    expect(line.unitPriceMicros).toBe(6n);
    expect(line.amountMicros).toBe(3000n);
  });

  it('null allowance = unlimited → never any overage line (D11)', () => {
    const result = computeCapabilityOverage(
      {
        capability: AiCapability.TTS,
        allowance: null,
        usage: [usage(1, AiUsageUnit.CHARACTER, 10_000_000)],
      },
      flatResolver(2n),
    );
    expect(result.lines).toHaveLength(0);
    expect(result.totalQuantity.toNumber()).toBe(10_000_000);
  });

  it('zero allowance bills every unit from the first one', () => {
    const result = computeCapabilityOverage(
      {
        capability: AiCapability.TTS,
        allowance: new Decimal(0),
        usage: [usage(1, AiUsageUnit.CHARACTER, 100)],
      },
      flatResolver(2n),
    );
    expect(result.lines).toHaveLength(1);
    expect(result.lines[0].overageQuantity?.toNumber()).toBe(100);
    expect(result.lines[0].amountMicros).toBe(200n);
  });

  it('splits a pooled LLM allowance across token units PRO-RATA within the crossing day', () => {
    // Allowance 1000 pooled over all token kinds (D11 — monthlyLlmTokens).
    // day1: 900 input (cum 900). day2: 300 input + 300 output (dayTotal 600,
    // cum 1500 ⇒ dayOverage 500) split pro-rata: input 250, output 250.
    // Rates: input 2, output 6 ⇒ 500 + 1500 micros.
    const rates = new Map<AiUsageUnit, bigint>([
      [AiUsageUnit.INPUT_TOKEN, 2n],
      [AiUsageUnit.OUTPUT_TOKEN, 6n],
    ]);
    const resolver: SellRateResolver = (unit) => rate(rates.get(unit)!, `rate-${unit}`);

    const result = computeCapabilityOverage(
      {
        capability: AiCapability.LLM,
        allowance: new Decimal(1000),
        usage: [
          usage(1, AiUsageUnit.INPUT_TOKEN, 900),
          usage(2, AiUsageUnit.INPUT_TOKEN, 300),
          usage(2, AiUsageUnit.OUTPUT_TOKEN, 300),
        ],
      },
      resolver,
    );

    expect(result.lines).toHaveLength(2);
    const input = result.lines.find((l) => l.unit === AiUsageUnit.INPUT_TOKEN)!;
    const output = result.lines.find((l) => l.unit === AiUsageUnit.OUTPUT_TOKEN)!;
    expect(input.overageQuantity?.toNumber()).toBe(250);
    expect(input.amountMicros).toBe(500n);
    expect(input.quantity?.toNumber()).toBe(1200); // whole-period input usage
    expect(output.overageQuantity?.toNumber()).toBe(250);
    expect(output.amountMicros).toBe(1500n);
    expect(result.overageQuantity.toNumber()).toBe(500);
  });

  it('pro-rata attribution preserves the overage total exactly on non-divisible splits', () => {
    // dayOverage 100 across three equal unit quantities: 33.333333 + 33.333333
    // + 33.333334 (remainder to the LAST unit in canonical order) = 100 exactly.
    const resolver = flatResolver(1n);
    const result = computeCapabilityOverage(
      {
        capability: AiCapability.LLM,
        allowance: new Decimal(200),
        usage: [
          usage(1, AiUsageUnit.INPUT_TOKEN, 100),
          usage(1, AiUsageUnit.OUTPUT_TOKEN, 100),
          usage(1, AiUsageUnit.REASONING_TOKEN, 100),
        ],
      },
      resolver,
    );
    const sum = result.lines.reduce((acc, l) => acc.plus(l.overageQuantity ?? 0), new Decimal(0));
    expect(sum.toNumber()).toBe(100);
    // Every share is non-negative and 6-dp bounded.
    for (const line of result.lines) {
      expect(line.overageQuantity!.greaterThanOrEqualTo(0)).toBe(true);
      expect(line.overageQuantity!.decimalPlaces()).toBeLessThanOrEqual(6);
    }
  });

  it('golden (i — split-rate): a mid-month SELL reprice rates each day at the row effective THAT day', () => {
    // Allowance 500. day10: 800 ⇒ overage 300 at the OLD rate (6). day20: 700 ⇒
    // overage 700 at the NEW rate (8, effective Aug 16). TWO lines, one per
    // rate row, each independently derivable: 300×6=1800 · 700×8=5600.
    const repriceAt = day(16).getTime();
    const resolver: SellRateResolver = (unit, d) => (d.getTime() >= repriceAt ? rate(8n, 'rate-new') : rate(6n, 'rate-old'));

    const result = computeCapabilityOverage(
      {
        capability: AiCapability.STT,
        allowance: new Decimal(500),
        usage: [usage(10, AiUsageUnit.SESSION_SECOND, 800), usage(20, AiUsageUnit.SESSION_SECOND, 700)],
      },
      resolver,
    );

    expect(result.lines).toHaveLength(2);
    const [oldLine, newLine] = result.lines;
    expect(oldLine.unitPriceMicros).toBe(6n);
    expect(oldLine.overageQuantity?.toNumber()).toBe(300);
    expect(oldLine.amountMicros).toBe(1800n);
    expect(newLine.unitPriceMicros).toBe(8n);
    expect(newLine.overageQuantity?.toNumber()).toBe(700);
    expect(newLine.amountMicros).toBe(5600n);
  });

  it('rounds HALF-UP at line level on fractional quantities', () => {
    // 0.5 audio-second overage × 3 micros = 1.5 → HALF-UP → 2 micros.
    const result = computeCapabilityOverage(
      {
        capability: AiCapability.STT,
        allowance: new Decimal(0),
        usage: [usage(1, AiUsageUnit.SESSION_SECOND, '0.5')],
      },
      flatResolver(3n),
    );
    expect(result.lines[0].amountMicros).toBe(2n);
  });

  it('FAILS CLOSED on a missing SELL rate — an invoice line cannot be "unrated"', () => {
    // The COST rater fails open (an unrated ledger row is repairable); an
    // invoice line is money and MUST resolve. Missing rate ⇒ typed throw.
    expect(() =>
      computeCapabilityOverage(
        {
          capability: AiCapability.NLP,
          allowance: new Decimal(0),
          usage: [usage(1, AiUsageUnit.TEXT_UNIT, 10)],
        },
        () => null,
      ),
    ).toThrow(MissingSellRateError);
  });

  it('rejects mixed currencies across the rate rows of one capability', () => {
    const resolver: SellRateResolver = (unit, d) => (d.getUTCDate() < 15 ? rate(6n, 'a', 'USD') : rate(6n, 'b', 'EUR'));
    expect(() =>
      computeCapabilityOverage(
        {
          capability: AiCapability.STT,
          allowance: new Decimal(0),
          usage: [usage(1, AiUsageUnit.SESSION_SECOND, 10), usage(20, AiUsageUnit.SESSION_SECOND, 10)],
        },
        resolver,
      ),
    ).toThrow(CurrencyMismatchError);
  });

  it('ignores zero-quantity buckets and emits nothing for zero total usage', () => {
    const result = computeCapabilityOverage(
      {
        capability: AiCapability.EMBEDDING,
        allowance: new Decimal(0),
        usage: [usage(1, AiUsageUnit.INPUT_TOKEN, 0)],
      },
      flatResolver(2n),
    );
    expect(result.lines).toHaveLength(0);
    expect(result.totalQuantity.toNumber()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Totals — Σ lines == total BY CONSTRUCTION (D13)
// ---------------------------------------------------------------------------

describe('computeInvoiceTotals', () => {
  const line = (kind: BillingLineKind, amountMicros: bigint): InvoiceLineDraft => ({
    kind,
    capability: null,
    unit: null,
    quantity: null,
    includedAllowance: null,
    overageQuantity: null,
    unitPriceMicros: null,
    amountMicros,
    description: 'test',
  });

  it('subtotal = plan fee + overage; total = subtotal + adjustments (credits negative)', () => {
    const totals = computeInvoiceTotals([
      line(BillingLineKind.PLAN_FEE, 999_000_000n),
      line(BillingLineKind.OVERAGE, 3000n),
      line(BillingLineKind.OVERAGE, 5600n),
      line(BillingLineKind.ADJUSTMENT, -50_000_000n),
      line(BillingLineKind.ADJUSTMENT, 1_000_000n),
    ]);
    expect(totals.subtotalMicros).toBe(999_008_600n);
    expect(totals.totalMicros).toBe(950_008_600n);
  });

  it('is exactly zero on an empty draft', () => {
    expect(computeInvoiceTotals([])).toEqual({ subtotalMicros: 0n, totalMicros: 0n });
  });
});

// ---------------------------------------------------------------------------
// Golden (g) — rounding PROPERTY test over arbitrary generated inputs
// ---------------------------------------------------------------------------

describe('property: Σ line amounts == invoice total, HALF-UP at line level, for arbitrary inputs', () => {
  /** Deterministic PRNG (mulberry32) — a seeded property test is reproducible evidence. */
  function mulberry32(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  it('holds across 250 seeded scenarios', () => {
    const rand = mulberry32(0x615_b111);
    const units = [AiUsageUnit.INPUT_TOKEN, AiUsageUnit.OUTPUT_TOKEN, AiUsageUnit.CACHE_READ_TOKEN];

    for (let iteration = 0; iteration < 250; iteration++) {
      // --- arbitrary usage: up to 12 (day, unit) buckets with 6-dp quantities
      const buckets: DailyUnitQuantity[] = [];
      const bucketCount = 1 + Math.floor(rand() * 12);
      for (let b = 0; b < bucketCount; b++) {
        buckets.push({
          day: day(1 + Math.floor(rand() * 28)),
          unit: units[Math.floor(rand() * units.length)],
          quantity: new Decimal(rand() * 5000).toDecimalPlaces(6),
        });
      }
      const totalUsage = buckets.reduce((acc, b) => acc.plus(b.quantity), new Decimal(0));

      // --- arbitrary allowance: null (unlimited), or 0..~total
      const allowanceRoll = rand();
      const allowance = allowanceRoll < 0.2 ? null : totalUsage.times(rand() * 1.2).toDecimalPlaces(6);

      // --- arbitrary rate card: per-unit price, repriced mid-month half the time
      const priceOf = new Map(units.map((u) => [u, BigInt(1 + Math.floor(rand() * 20))]));
      const repriced = rand() < 0.5;
      const repriceDay = 2 + Math.floor(rand() * 27);
      const resolver: SellRateResolver = (unit, d) => {
        const base = priceOf.get(unit)!;
        if (repriced && d.getUTCDate() >= repriceDay) {
          return rate(base * 2n, `rate-${unit}-new`);
        }
        return rate(base, `rate-${unit}-old`);
      };

      const result = computeCapabilityOverage({ capability: AiCapability.LLM, allowance, usage: buckets }, resolver);

      // P1 — every line amount is EXACTLY the independent HALF-UP recomputation.
      for (const line of result.lines) {
        const expected = BigInt(
          line
            .overageQuantity!.times(new Decimal(line.unitPriceMicros!.toString()))
            .toDecimalPlaces(0, Decimal.ROUND_HALF_UP)
            .toFixed(0),
        );
        expect(line.amountMicros).toBe(expected);
      }

      // P2 — attributed overage quantities sum EXACTLY to max(0, usage − allowance).
      const attributed = result.lines.reduce((acc, l) => acc.plus(l.overageQuantity!), new Decimal(0));
      const expectedOverage = allowance === null ? new Decimal(0) : Decimal.max(0, totalUsage.minus(allowance));
      expect(attributed.equals(expectedOverage)).toBe(true);

      // P3 — Σ line amounts == invoice total, by construction AND by re-sum.
      const adjustments: InvoiceLineDraft[] = rand() < 0.5
        ? [
            {
              kind: BillingLineKind.ADJUSTMENT,
              capability: null,
              unit: null,
              quantity: null,
              includedAllowance: null,
              overageQuantity: null,
              unitPriceMicros: null,
              amountMicros: BigInt(Math.floor(rand() * 2_000_000)) * (rand() < 0.8 ? -1n : 1n),
              description: 'memo',
            },
          ]
        : [];
      const allLines = [...result.lines, ...adjustments];
      const totals = computeInvoiceTotals(allLines);
      const resummed = allLines.reduce((acc, l) => acc + l.amountMicros, 0n);
      expect(totals.totalMicros).toBe(resummed);
    }
  });
});
