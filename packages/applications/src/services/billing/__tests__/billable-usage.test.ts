import Decimal from 'decimal.js';
import { describe, expect, it } from 'vitest';
import { AiCapability, AiUsageUnit } from '@arcaai/domains';

import { BILLABLE_UNITS, NON_BILLABLE_LLM_OPERATIONS, buildBillableUsage } from '../billable-usage';

/**
 * Billable-usage construction (D13/D16).
 *
 * Rollups are the invoice-time source, but they carry no `operation` dimension,
 * and two D-rules are operation-shaped:
 *   - D16: guardrail + harness LLM usage is metered, NEVER billed to tenants.
 *   - OQ1: STT bills streaming on SESSION seconds; AUDIO seconds are billable
 *     only for BATCH jobs (streaming audio-seconds are recorded for repricing).
 *
 * The compensating inputs come from a bounded LEDGER AGGREGATE (SQL sums per
 * day×unit×operation — never row reads). This module is the pure merge.
 */

const day = (d: number): Date => new Date(Date.UTC(2026, 7, d));

describe('BILLABLE_UNITS', () => {
  it('pins the billing denomination of every capability', () => {
    expect(BILLABLE_UNITS[AiCapability.STT]).toEqual([AiUsageUnit.SESSION_SECOND, AiUsageUnit.AUDIO_SECOND]);
    expect(BILLABLE_UNITS[AiCapability.LLM]).toEqual([
      AiUsageUnit.INPUT_TOKEN,
      AiUsageUnit.OUTPUT_TOKEN,
      AiUsageUnit.CACHE_READ_TOKEN,
      AiUsageUnit.CACHE_WRITE_TOKEN,
      AiUsageUnit.REASONING_TOKEN,
    ]);
    expect(BILLABLE_UNITS[AiCapability.TTS]).toEqual([AiUsageUnit.CHARACTER]);
    expect(BILLABLE_UNITS[AiCapability.NLP]).toEqual([AiUsageUnit.TEXT_UNIT]);
    expect(BILLABLE_UNITS[AiCapability.EMBEDDING]).toEqual([AiUsageUnit.INPUT_TOKEN]);
  });

  it('never bills GPU seconds (cost-truth unit) or NLP request counts (shape metric)', () => {
    for (const units of Object.values(BILLABLE_UNITS)) {
      expect(units).not.toContain(AiUsageUnit.GPU_SECOND);
    }
    expect(BILLABLE_UNITS[AiCapability.NLP]).not.toContain(AiUsageUnit.REQUEST);
  });
});

describe('buildBillableUsage — LLM (D16 deduction)', () => {
  it('subtracts guardrail + harness sums per (day, unit) from the rollup pool', () => {
    const usage = buildBillableUsage(
      AiCapability.LLM,
      [
        { day: day(1), unit: AiUsageUnit.INPUT_TOKEN, quantity: new Decimal(1000) },
        { day: day(1), unit: AiUsageUnit.OUTPUT_TOKEN, quantity: new Decimal(400) },
        { day: day(2), unit: AiUsageUnit.INPUT_TOKEN, quantity: new Decimal(500) },
      ],
      {
        // guardrail+harness aggregate: 300 of day-1 input, 400 (ALL) of day-1 output
        subtract: [
          { day: day(1), unit: AiUsageUnit.INPUT_TOKEN, quantity: new Decimal(300) },
          { day: day(1), unit: AiUsageUnit.OUTPUT_TOKEN, quantity: new Decimal(400) },
        ],
      },
    );

    expect(usage).toEqual([
      { day: day(1), unit: AiUsageUnit.INPUT_TOKEN, quantity: new Decimal(700) },
      { day: day(2), unit: AiUsageUnit.INPUT_TOKEN, quantity: new Decimal(500) },
    ]);
  });

  it('clamps a deduction that exceeds the rollup bucket at zero (defensive — must never go negative)', () => {
    const usage = buildBillableUsage(AiCapability.LLM, [{ day: day(1), unit: AiUsageUnit.INPUT_TOKEN, quantity: new Decimal(100) }], {
      subtract: [{ day: day(1), unit: AiUsageUnit.INPUT_TOKEN, quantity: new Decimal(150) }],
    });
    expect(usage).toEqual([]);
  });

  it("ignores rollup buckets outside the capability's billable units", () => {
    const usage = buildBillableUsage(AiCapability.LLM, [
      { day: day(1), unit: AiUsageUnit.GPU_SECOND, quantity: new Decimal(3600) },
      { day: day(1), unit: AiUsageUnit.INPUT_TOKEN, quantity: new Decimal(10) },
    ]);
    expect(usage).toEqual([{ day: day(1), unit: AiUsageUnit.INPUT_TOKEN, quantity: new Decimal(10) }]);
  });
});

describe('buildBillableUsage — STT (OQ1 unit sourcing)', () => {
  it('takes SESSION_SECOND from rollups but REPLACES AUDIO_SECOND with the batch-only aggregate', () => {
    const usage = buildBillableUsage(
      AiCapability.STT,
      [
        { day: day(1), unit: AiUsageUnit.SESSION_SECOND, quantity: new Decimal(600) },
        // Rollup audio-seconds mix streaming (recorded, not billed) and batch —
        // they must NOT flow through as billable.
        { day: day(1), unit: AiUsageUnit.AUDIO_SECOND, quantity: new Decimal(580) },
      ],
      {
        replace: [{ day: day(1), unit: AiUsageUnit.AUDIO_SECOND, quantity: new Decimal(120) }], // transcribe.batch only
      },
    );

    // Canonical unit order (enum declaration order) puts AUDIO_SECOND first.
    expect(usage).toEqual([
      { day: day(1), unit: AiUsageUnit.AUDIO_SECOND, quantity: new Decimal(120) },
      { day: day(1), unit: AiUsageUnit.SESSION_SECOND, quantity: new Decimal(600) },
    ]);
  });

  it('emits no AUDIO_SECOND usage at all when no batch jobs ran', () => {
    const usage = buildBillableUsage(AiCapability.STT, [
      { day: day(1), unit: AiUsageUnit.SESSION_SECOND, quantity: new Decimal(600) },
      { day: day(1), unit: AiUsageUnit.AUDIO_SECOND, quantity: new Decimal(580) },
    ]);
    expect(usage).toEqual([{ day: day(1), unit: AiUsageUnit.SESSION_SECOND, quantity: new Decimal(600) }]);
  });
});

describe('NON_BILLABLE_LLM_OPERATIONS', () => {
  it('names exactly the two D16 exclusions', () => {
    expect([...NON_BILLABLE_LLM_OPERATIONS].sort()).toEqual(['guardrail.validate', 'harness.step']);
  });
});

/**
 * TASK-957 F-1 / TASK-959 — `workflow.step` is billable BY CONSTRUCTION.
 *
 * D-1's recommendation was to introduce the operation and leave the exclusion
 * lists alone, so that tenant-consumed workflow inference becomes billable
 * because nobody excluded it — not because somebody remembered to include it.
 * That makes the exclusion list itself the contract, and this is the test that
 * makes a later "tidy-up" of it a failing test rather than a silent revenue
 * decision.
 */
describe('TASK-959 — the operation exclusion list is the contract', () => {
  it('excludes guardrail and the CONSULTATION harness lane, and nothing else', () => {
    expect([...NON_BILLABLE_LLM_OPERATIONS]).toEqual(['guardrail.validate', 'harness.step']);
  });

  it('does NOT exclude workflow.step — a tenant’s workflow generation is the tenant’s spend', () => {
    expect(NON_BILLABLE_LLM_OPERATIONS).not.toContain('workflow.step');
  });

  it('pools workflow.step LLM tokens into monthlyLlmTokens like any other generation', () => {
    // The rollup carries `operation`, but `BILLABLE_UNITS` is keyed by
    // CAPABILITY: a workflow step's tokens are LLM tokens, so they consume the
    // same pooled allowance a summary's do. Nothing operation-shaped is needed
    // here — the compensation path is what subtracts the excluded operations.
    expect(BILLABLE_UNITS[AiCapability.LLM]).toContain(AiUsageUnit.INPUT_TOKEN);
    expect(BILLABLE_UNITS[AiCapability.LLM]).toContain(AiUsageUnit.REASONING_TOKEN);
  });

  it('keeps the two new capabilities un-invoiced until their SELL rows ship', () => {
    // A billable unit with no SELL rate makes the whole invoice draft throw, so
    // these stay empty until wave 4 ships the rate and the allowance column
    // together. Metered and visible now; invoiced later.
    expect(BILLABLE_UNITS[AiCapability.WORKFLOW]).toEqual([]);
    expect(BILLABLE_UNITS[AiCapability.STORAGE]).toEqual([]);
  });

  it('never bills an occupancy second or a byte as an LLM unit', () => {
    for (const unit of [AiUsageUnit.GPU_SECOND, AiUsageUnit.CPU_SECOND, AiUsageUnit.EGRESS_BYTE, AiUsageUnit.INGRESS_BYTE]) {
      expect(BILLABLE_UNITS[AiCapability.LLM]).not.toContain(unit);
    }
  });
});
