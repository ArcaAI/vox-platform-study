import { describe, expect, it, vi } from 'vitest';
import { AiCapability, AiDeploymentKind, AiUsageUnit, BillingInvoiceStatus, BillingLineKind, TenantPlan } from '@arcaai/domains';

/**
 * TASK-615 WS-I DoD evidence — ONE simulated month, end to end.
 *
 * A PRO tenant's August 2026 combining every mechanism at once: full plan fee,
 * STT overage (streaming sessions), LLM overage with the D16 guardrail
 * deduction and a pro-rata multi-unit split, TTS inside its allowance, BYOK
 * notional spend on the DTO, and a prior-period credit memo carried forward.
 * Every number is hand-derived below; the test prints the draft so the run
 * output doubles as the pasted evidence.
 *
 *   STT: 2000 + 2200 = 4200 session-s · allowance 3600 → 600 over × 6µ = 3,600µ
 *   LLM: input 900k(d10) + 400k(d22), output 100k(d22), MINUS 200k guardrail
 *        input (d10) → billable 700k + 500k = 1.2M · allowance 1M → 200k over
 *        crossing on d22, split pro-rata: input 160k × 2µ = 320,000µ ·
 *        output 40k × 6µ = 240,000µ
 *   TTS: 50k chars · allowance 100k → no line
 *   fee: PRO full month = 999,000,000µ
 *   memo issued in August against July's finalized invoice: −10,000,000µ
 *
 *   subtotal = 999,000,000 + 3,600 + 320,000 + 240,000 = 999,563,600
 *   total    = 999,563,600 − 10,000,000                = 989,563,600
 */
import { makeSimulatedWorld } from './simulated-month.world';

describe('SIMULATED MONTH (WS-I DoD evidence)', () => {
  it('produces the correct draft invoice for a composite August', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-02T08:00:00.000Z'));
    const { service } = makeSimulatedWorld();

    const draft = await service.computeDraft('aaaaaaaa-0000-0000-0000-000000000001', '2026-08');

    expect(draft.status).toBe(BillingInvoiceStatus.DRAFT);
    expect(draft.planTier).toBe(TenantPlan.PRO);
    expect(draft.planFeeBasis).toBe('PERIOD_END_PLAN');

    const byKind = (kind: BillingLineKind) => draft.lines.filter((line) => line.kind === kind);
    expect(byKind(BillingLineKind.PLAN_FEE)).toHaveLength(1);
    expect(byKind(BillingLineKind.PLAN_FEE)[0].amountMicros).toBe('999000000');

    const overage = byKind(BillingLineKind.OVERAGE);
    expect(overage).toHaveLength(3);
    const stt = overage.find((line) => line.capability === AiCapability.STT)!;
    expect([stt.unit, stt.quantity, stt.includedAllowance, stt.overageQuantity, stt.unitPriceMicros, stt.amountMicros]).toEqual([
      AiUsageUnit.SESSION_SECOND,
      '4200',
      '3600',
      '600',
      '6',
      '3600',
    ]);
    const llmInput = overage.find((line) => line.unit === AiUsageUnit.INPUT_TOKEN)!;
    expect([llmInput.quantity, llmInput.overageQuantity, llmInput.amountMicros]).toEqual(['1100000', '160000', '320000']);
    const llmOutput = overage.find((line) => line.unit === AiUsageUnit.OUTPUT_TOKEN)!;
    expect([llmOutput.quantity, llmOutput.overageQuantity, llmOutput.amountMicros]).toEqual(['100000', '40000', '240000']);

    const memos = byKind(BillingLineKind.ADJUSTMENT);
    expect(memos).toHaveLength(1);
    expect(memos[0].amountMicros).toBe('-10000000');

    expect(draft.subtotalMicros).toBe('999563600');
    expect(draft.totalMicros).toBe('989563600');
    expect(draft.byokNotionalCostMicros).toBe('555555');

    // Σ lines == total, re-proven on the persisted draft.
    const resummed = draft.lines.reduce((acc, line) => acc + BigInt(line.amountMicros), 0n);
    expect(resummed.toString()).toBe(draft.totalMicros);

    // Human-readable evidence for the ticket README.
    // eslint-disable-next-line no-console -- DoD evidence rendering, test-only
    console.log(
      [
        `DRAFT ${draft.period} · ${draft.status} · plan ${draft.planTier} (${draft.planFeeBasis})`,
        ...draft.lines.map(
          (line) =>
            `  ${line.kind.padEnd(10)} ${(line.capability ?? '—').padEnd(9)} ${(line.unit ?? '').padEnd(15)} ` +
            `qty=${line.quantity ?? '—'} allow=${line.includedAllowance ?? '—'} over=${line.overageQuantity ?? '—'} ` +
            `rate=${line.unitPriceMicros ?? '—'}µ amount=${line.amountMicros}µ`,
        ),
        `  subtotal=${draft.subtotalMicros}µ total=${draft.totalMicros}µ byokNotional=${draft.byokNotionalCostMicros}µ`,
        `  rateCards=[${draft.rateCardVersions.join(', ')}]`,
      ].join('\n'),
    );
  });
});
