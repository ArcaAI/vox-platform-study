/**
 * TASK-999 (D-2(c)) — the LIVE lane's tokens are still BILLABLE after the operation split.
 *
 * ============================================================================
 * THE MOST IMPORTANT TEST IN THIS LANE, AND WHY
 * ============================================================================
 * Splitting the live flush out of `generate` into `generate.live` moved a real, high-volume
 * stream of revenue onto a brand-new rollup dimension value. The `LLM_TOKENS` meter — the one
 * a tenant's plan ceiling gates and the one the invoice reads — filters that dimension with an
 * EXCLUSION list (`operation: { notIn: [...] }`), not an inclusion list. That is the whole
 * safety property: a new operation KEEPS counting by default, and it stops counting only if
 * somebody deliberately adds it to `NON_BILLABLE_LLM_OPERATIONS`.
 *
 * The failure this pins is silent in every other way. Adding `generate.live` to that list — a
 * plausible thing for a future reader to do while "tidying up the COGS-only operations" — would
 * not fail a build, would not fail a type check, and would not produce a single error anywhere.
 * It would simply stop billing every partial summary on the platform, and the first person to
 * notice would be whoever reconciles an invoice a month later.
 *
 * So the assertion is on the exclusion list ITSELF, read off the query the meter actually
 * issues, and it is exact rather than a `not.toContain`: a list that has grown a third member
 * is a decision somebody owes an explanation for.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AiCapability, AiUsageUnit } from '@arcaai/domains';

import { MeteringService } from '../metering.service';
import { currentMonthWindow } from '../metering-window';

const FIXED_NOW = new Date('2026-09-22T09:41:23.456Z');
const WINDOW = currentMonthWindow(FIXED_NOW);

const decimalLike = (value: number) => ({ toNumber: () => value });

/** Answer each rollup aggregate from a predicate over its own `where`, so the test reads as the query does. */
function rollupAnswering(answer: (where: Record<string, never>) => number) {
  return vi.fn((args: { where: Record<string, never> }) => Promise.resolve({ _sum: { quantitySum: decimalLike(answer(args.where)) } }));
}

function makeService(rollupAggregate: ReturnType<typeof rollupAnswering>) {
  const baseClient = {
    consultation: { count: vi.fn().mockResolvedValue(0) },
    audioRecording: { aggregate: vi.fn().mockResolvedValue({ _sum: { duration: 0 } }) },
    summaryMeta: { count: vi.fn().mockResolvedValue(0) },
    workflowRun: { count: vi.fn().mockResolvedValue(0) },
    aiUsageRollupDaily: { aggregate: rollupAggregate, findFirst: vi.fn().mockResolvedValue(null) },
    aiUsageEvent: { findMany: vi.fn().mockResolvedValue([]) },
    tenant: { findMany: vi.fn().mockResolvedValue([]) },
    tenantUsageMeter: { upsert: vi.fn().mockResolvedValue({}) },
  };
  const appSettings = { getValueWithDefault: vi.fn((_k: string, fallback: unknown) => fallback) } as never;
  const scheduler = { addCronJob: vi.fn(), getCronJob: vi.fn(), deleteCronJob: vi.fn() } as never;
  return new MeteringService(appSettings, scheduler, { baseClient } as never);
}

/** The billable-token query: LLM capability, the five token units. */
const isLlmTokenQuery = (where: Record<string, never>) =>
  where.capability === AiCapability.LLM &&
  Array.isArray((where.unit as { in?: unknown[] })?.in) &&
  ((where.unit as { in: unknown[] }).in as unknown[]).includes(AiUsageUnit.INPUT_TOKEN);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('LLM_TOKENS — `generate.live` is billable (TASK-999 D-2(c))', () => {
  it('does NOT exclude `generate.live` from the billable LLM token meter', async () => {
    // RED before the change: `generate.live` did not exist, so this query and this assertion
    // had no subject at all. It is written now so the value can never be quietly demoted.
    const aggregate = rollupAnswering((where) => (isLlmTokenQuery(where) ? 12_345 : 0));

    await makeService(aggregate).getCurrentUsage('tenant-1', FIXED_NOW);

    const where = aggregate.mock.calls.map(([args]) => args.where).find(isLlmTokenQuery)!;
    const excluded = (where.operation as { notIn: string[] }).notIn;

    expect(excluded, 'generate.live must never join the COGS-only exclusion list — it is a tenant-billable generation exactly as `generate` is, and excluding it would silently stop billing every partial summary on the platform').not.toContain(
      'generate.live',
    );
    // Exact, not a superset check: the two COGS-only operations are guardrail (platform-mandated
    // safety) and harness (internal agentic COGS). A third member is a billing decision.
    expect(excluded).toEqual(['guardrail.validate', 'harness.step']);
  });

  it('counts live-flush tokens in the same sum as every other generation', async () => {
    // The exclusion filter is the ONLY thing standing between a `generate.live` row and the
    // meter, so with it clean the tokens simply arrive — there is no operation allow-list to
    // also teach about the new value.
    const aggregate = rollupAnswering((where) => (isLlmTokenQuery(where) ? 12_345 : 0));

    const usage = await makeService(aggregate).getCurrentUsage('tenant-1', FIXED_NOW);

    expect(usage.llmTokens).toBe(12_345);
    const where = aggregate.mock.calls.map(([args]) => args.where).find(isLlmTokenQuery)!;
    expect(where.bucketStart).toEqual({ gte: WINDOW.periodStart, lt: WINDOW.periodEnd });
  });
});
