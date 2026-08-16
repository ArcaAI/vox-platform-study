// Unit tests for the TASK-732 Phase 1 Task 2 instrumentation script
// (scripts/harness-migration-readiness-report.ts). The live Postgres round-trip is exercised
// manually/in the ticket README (see readiness-checklist.md / go-no-go-thresholds.md); here we
// lock down parseArgs and the two rate-computation functions against an in-memory fake client —
// NO live DB.
import { describe, it, expect } from 'vitest';
import { parseArgs, computeMissingNoteRate, computeHarmProxy, type ReadinessReportClient } from '../harness-migration-readiness-report';

describe('parseArgs', () => {
  it('defaults to a 90-day window, 15-minute SLA, all tenants', () => {
    expect(parseArgs([])).toEqual({ sinceDays: 90, slaMinutes: 15 });
  });

  it('honors --since-days, --sla-minutes, --tenant-id, --json', () => {
    expect(parseArgs(['--since-days', '30', '--sla-minutes', '20', '--tenant-id', 'tenant-1', '--json', 'out.json'])).toEqual({
      sinceDays: 30,
      slaMinutes: 20,
      tenantId: 'tenant-1',
      jsonPath: 'out.json',
    });
  });

  it('rejects a non-positive --since-days', () => {
    expect(() => parseArgs(['--since-days', '0'])).toThrow(/--since-days/);
    expect(() => parseArgs(['--since-days', 'abc'])).toThrow(/--since-days/);
  });

  it('rejects a non-positive --sla-minutes', () => {
    expect(() => parseArgs(['--sla-minutes', '-5'])).toThrow(/--sla-minutes/);
  });
});

/** In-memory fake satisfying ReadinessReportClient, for the rate-computation tests. */
function createFakeClient(seed: {
  stopEvents?: Array<{ resourceId: string | null; createdAt: Date }>;
  rawSummaries?: Array<{ consultationId: string; createdAt: Date }>;
  summaryMetaEvaluated?: number;
  summaryMetaFlagged?: number;
  signedCount?: number;
  annotatedCount?: number;
}): ReadinessReportClient {
  const stopEvents = seed.stopEvents ?? [];
  const rawSummaries = seed.rawSummaries ?? [];
  return {
    auditLog: {
      findMany: async () => stopEvents,
    },
    contextItem: {
      findMany: async (args: unknown) => {
        const where = (args as { where: { consultationId: string; createdAt: { gte: Date; lte: Date } } }).where;
        return rawSummaries.filter(
          (r) => r.consultationId === where.consultationId && r.createdAt >= where.createdAt.gte && r.createdAt <= where.createdAt.lte,
        );
      },
    },
    summaryMeta: {
      count: async (args: unknown) => {
        const where = (args as { where: { gateDecision?: unknown } }).where;
        if (where.gateDecision === 'FLAG') return seed.summaryMetaFlagged ?? 0;
        return seed.summaryMetaEvaluated ?? 0;
      },
    },
    harnessAuditEvent: {
      count: async (args: unknown) => {
        const where = (args as { where: { action: string } }).where;
        if (where.action === 'SIGNED_BEFORE_ASSURANCE') return seed.annotatedCount ?? 0;
        if (where.action === 'ATTEST') return seed.signedCount ?? 0;
        return 0;
      },
    },
  };
}

describe('computeMissingNoteRate', () => {
  const since = new Date('2026-01-01T00:00:00Z');
  const opts = { sinceDays: 90, slaMinutes: 15 };

  it('returns a null rate with a zero denominator (no capture-stop events)', async () => {
    const client = createFakeClient({});
    const result = await computeMissingNoteRate(client, opts, since);
    expect(result).toEqual({
      denominatorCaptureStopEvents: 0,
      numeratorMissingWithinSla: 0,
      rate: null,
      slaMinutes: 15,
      missingConsultationIds: [],
    });
  });

  it('counts a capture-stop as covered when a RAW_SUMMARY lands within the SLA window', async () => {
    const stopAt = new Date('2026-01-05T10:00:00Z');
    const draftAt = new Date('2026-01-05T10:05:00Z'); // 5 min later, inside the 15-min SLA
    const client = createFakeClient({
      stopEvents: [{ resourceId: 'consult-1', createdAt: stopAt }],
      rawSummaries: [{ consultationId: 'consult-1', createdAt: draftAt }],
    });
    const result = await computeMissingNoteRate(client, opts, since);
    expect(result.denominatorCaptureStopEvents).toBe(1);
    expect(result.numeratorMissingWithinSla).toBe(0);
    expect(result.rate).toBe(0);
    expect(result.missingConsultationIds).toEqual([]);
  });

  it('counts a capture-stop as missing when no RAW_SUMMARY lands within the SLA window', async () => {
    const stopAt = new Date('2026-01-05T10:00:00Z');
    const draftAt = new Date('2026-01-05T10:20:00Z'); // 20 min later, OUTSIDE the 15-min SLA
    const client = createFakeClient({
      stopEvents: [{ resourceId: 'consult-1', createdAt: stopAt }],
      rawSummaries: [{ consultationId: 'consult-1', createdAt: draftAt }],
    });
    const result = await computeMissingNoteRate(client, opts, since);
    expect(result.numeratorMissingWithinSla).toBe(1);
    expect(result.rate).toBe(1);
    expect(result.missingConsultationIds).toEqual(['consult-1']);
  });

  it('computes a fractional rate across a mixed batch and skips a null resourceId', async () => {
    const t0 = new Date('2026-01-05T10:00:00Z');
    const client = createFakeClient({
      stopEvents: [
        { resourceId: 'consult-covered', createdAt: t0 },
        { resourceId: 'consult-missing', createdAt: t0 },
        { resourceId: null, createdAt: t0 }, // malformed AuditLog row — skipped, not counted either way
      ],
      rawSummaries: [{ consultationId: 'consult-covered', createdAt: new Date(t0.getTime() + 60_000) }],
    });
    const result = await computeMissingNoteRate(client, opts, since);
    expect(result.denominatorCaptureStopEvents).toBe(3);
    expect(result.numeratorMissingWithinSla).toBe(1);
    expect(result.rate).toBeCloseTo(1 / 3);
    expect(result.missingConsultationIds).toEqual(['consult-missing']);
  });
});

describe('computeHarmProxy', () => {
  const since = new Date('2026-01-01T00:00:00Z');
  const opts = { sinceDays: 90, slaMinutes: 15 };

  it('returns null rates with zero denominators', async () => {
    const client = createFakeClient({});
    const result = await computeHarmProxy(client, opts, since);
    expect(result.gateDecisionFlag.rate).toBeNull();
    expect(result.signedBeforeAssurance.rate).toBeNull();
  });

  it('computes the gateDecision FLAG rate', async () => {
    const client = createFakeClient({ summaryMetaEvaluated: 10, summaryMetaFlagged: 3 });
    const result = await computeHarmProxy(client, opts, since);
    expect(result.gateDecisionFlag).toEqual({ denominatorEvaluated: 10, numeratorFlagged: 3, rate: 0.3 });
  });

  it('computes the SIGNED_BEFORE_ASSURANCE annotation rate over signed (ATTEST) events', async () => {
    const client = createFakeClient({ signedCount: 20, annotatedCount: 5 });
    const result = await computeHarmProxy(client, opts, since);
    expect(result.signedBeforeAssurance).toEqual({ denominatorSigned: 20, numeratorAnnotated: 5, rate: 0.25 });
  });
});
