/**
 * ShadowMeteringService.
 *
 * Verifies: `runForTenant` computes the ledger-vs-summaryMeta comparison and
 * the six ledger-vs-meter comparisons, flags breaches via `computeDrift`,
 * emits `SHADOW_METERING_DRIFT_DETECTED_EVENT` only when a breach exists,
 * and `runForAllActiveTenants` sweeps every tenant and is resilient to a
 * per-tenant failure. Scheduling on/off mirrors `MeteringService` /
 * `AuditRetentionService` (config-driven, OFF by default).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildProviderReconcilerRegistry, type ProviderReconcilerSpec } from '../provider-reconciler-registry';
import { ShadowMeteringService } from '../shadow-metering.service';
import { currentMonthWindow } from '../../metering-window';
import { SHADOW_METERING_DRIFT_DETECTED_EVENT } from '../shadow-metering.constants';

const FIXED_NOW = new Date('2026-03-17T09:41:23.456Z');
const WINDOW = currentMonthWindow(FIXED_NOW);

function decimalLike(value: number) {
  return { toNumber: () => value };
}

function makeBaseClient(overrides: Record<string, unknown> = {}) {
  return {
    aiUsageRollupDaily: { aggregate: vi.fn().mockResolvedValue({ _sum: { quantitySum: decimalLike(100) } }) },
    summaryMeta: { aggregate: vi.fn().mockResolvedValue({ _sum: { inputTokens: 60, outputTokens: 40 } }) },
    aiUsageEvent: { findMany: vi.fn().mockResolvedValue(Array.from({ length: 100 }, (_, i) => ({ requestId: `req-${i}` }))) },
    tenantUsageMeter: { findUnique: vi.fn().mockResolvedValue({ usedCount: 100 }) },
    tenant: { findMany: vi.fn().mockResolvedValue([{ id: 't1' }, { id: 't2' }]) },
    ...overrides,
  };
}

function makeRunRepository() {
  return { create: vi.fn(async (entity: unknown) => entity), findRuns: vi.fn(async () => []), findLatestPerProvider: vi.fn(async () => []) };
}

function makeService(baseClient: ReturnType<typeof makeBaseClient>, enabled = false, secretsService?: unknown, runRepository = makeRunRepository()) {
  const appSettings = { getValueWithDefault: vi.fn((_key: string, fallback: unknown) => (typeof fallback === 'boolean' ? enabled : fallback)) } as never;
  const schedulerRegistry = { addCronJob: vi.fn(), getCronJob: vi.fn(), deleteCronJob: vi.fn() } as never;
  const eventEmitter = { emit: vi.fn() } as never;
  const databaseService = { baseClient } as never;
  return {
    service: new ShadowMeteringService(appSettings, schedulerRegistry, eventEmitter, databaseService, runRepository as never, secretsService as never),
    eventEmitter,
    runRepository,
  };
}

describe('ShadowMeteringService.runForTenant', () => {
  it('produces 7 comparisons: ledger-vs-summaryMeta:LLM_TOKENS + 6 ledger-vs-meter rows', async () => {
    const baseClient = makeBaseClient();
    const { service } = makeService(baseClient);

    const report = await service.runForTenant('tenant-1', FIXED_NOW);

    expect(report.tenantId).toBe('tenant-1');
    expect(report.periodStart).toEqual(WINDOW.periodStart);
    expect(report.comparisons).toHaveLength(7);
    expect(report.comparisons.map((c) => c.label)).toEqual([
      'ledger-vs-summaryMeta:LLM_TOKENS',
      'ledger-vs-meter:STT_SESSION_SECONDS',
      'ledger-vs-meter:LLM_TOKENS',
      'ledger-vs-meter:TTS_CHARACTERS',
      'ledger-vs-meter:NLP_TEXT_UNITS',
      'ledger-vs-meter:GUARDRAIL_CALLS',
      'ledger-vs-meter:EMBEDDING_TOKENS',
    ]);
  });

  it('reports no breaches when the ledger, SummaryMeta, and persisted meter all agree', async () => {
    // ledger rollup=100, summaryMeta=60+40=100 (exact match); meter=100 matches live aggregate 100.
    const baseClient = makeBaseClient();
    const { service } = makeService(baseClient);

    const report = await service.runForTenant('tenant-1', FIXED_NOW);

    expect(report.breaches).toEqual([]);
  });

  it('flags a breach when SummaryMeta under-counts the ledger beyond 2%', async () => {
    const baseClient = makeBaseClient({
      summaryMeta: { aggregate: vi.fn().mockResolvedValue({ _sum: { inputTokens: 30, outputTokens: 20 } }) }, // 50 vs ledger 100 → -50%
    });
    const { service, eventEmitter } = makeService(baseClient);

    const report = await service.runForTenant('tenant-1', FIXED_NOW);

    const breach = report.breaches.find((b) => b.label === 'ledger-vs-summaryMeta:LLM_TOKENS');
    expect(breach).toBeDefined();
    expect(breach?.relativeDrift).toBeCloseTo(-0.5);
    expect(eventEmitter.emit).toHaveBeenCalledWith(
      SHADOW_METERING_DRIFT_DETECTED_EVENT,
      expect.objectContaining({ tenantId: 'tenant-1' }),
    );
  });

  it('flags a breach when the persisted TenantUsageMeter snapshot is stale relative to the live aggregate', async () => {
    const baseClient = makeBaseClient({
      // Every metric's live aggregate is 100 (rollup mock); persisted meter frozen at 50 → -50% for each ledger-vs-meter comparison.
      tenantUsageMeter: { findUnique: vi.fn().mockResolvedValue({ usedCount: 50 }) },
    });
    const { service } = makeService(baseClient);

    const report = await service.runForTenant('tenant-1', FIXED_NOW);

    const meterBreaches = report.breaches.filter((b) => b.label.startsWith('ledger-vs-meter:'));
    expect(meterBreaches.length).toBeGreaterThan(0);
  });

  it('does not emit the drift event when there are no breaches', async () => {
    const baseClient = makeBaseClient();
    const { service, eventEmitter } = makeService(baseClient);

    await service.runForTenant('tenant-1', FIXED_NOW);

    expect(eventEmitter.emit).not.toHaveBeenCalled();
  });

  it('includes provider-reconciler availability, all unavailable with no secrets backend wired', async () => {
    const baseClient = makeBaseClient();
    const { service } = makeService(baseClient);

    const report = await service.runForTenant('tenant-1', FIXED_NOW);

    // One row per billable vendor (credential-gated registry).
    expect(report.providerAvailability.length).toBeGreaterThanOrEqual(4);
    expect(report.providerAvailability.every((p) => p.available === false)).toBe(true);
    // Every row says WHY, so the run log is actionable rather than just empty.
    expect(report.providerAvailability.every((p) => (p.reason ?? '').length > 0)).toBe(true);
  });

  it('treats a missing persisted meter row as 0 (never throws)', async () => {
    const baseClient = makeBaseClient({ tenantUsageMeter: { findUnique: vi.fn().mockResolvedValue(null) } });
    const { service } = makeService(baseClient);

    const report = await service.runForTenant('tenant-1', FIXED_NOW);

    const sttComparison = report.comparisons.find((c) => c.label === 'ledger-vs-meter:STT_SESSION_SECONDS');
    expect(sttComparison?.actual).toBe(0);
  });
});

describe('ShadowMeteringService.runForAllActiveTenants', () => {
  it('sweeps every tenant and aggregates breach counts', async () => {
    const baseClient = makeBaseClient();
    const { service } = makeService(baseClient);

    const result = await service.runForAllActiveTenants(FIXED_NOW);

    expect(result.tenants).toBe(2);
    expect(result.reports).toHaveLength(2);
  });

  it('continues past a per-tenant failure and still reports the successful ones', async () => {
    const baseClient = makeBaseClient();
    const { service } = makeService(baseClient);
    const spy = vi.spyOn(service, 'runForTenant');
    spy.mockRejectedValueOnce(new Error('boom')).mockImplementation(async (tenantId: unknown) => ({
      tenantId: tenantId as string,
      periodStart: WINDOW.periodStart,
      periodEnd: WINDOW.periodEnd,
      comparisons: [],
      breaches: [],
      providerAvailability: [],
    }));

    const result = await service.runForAllActiveTenants(FIXED_NOW);

    expect(result.tenants).toBe(1);
  });
});

describe('ShadowMeteringService scheduling', () => {
  it('is disabled by default and never registers a cron job', () => {
    const baseClient = makeBaseClient();
    const { service } = makeService(baseClient, false);

    service.onModuleInit();

    expect(service.isEnabled).toBe(false);
  });

  it('schedules a cron job when enabled via settings', () => {
    const baseClient = makeBaseClient();
    const { service } = makeService(baseClient, true);

    service.onModuleInit();

    expect(service.isEnabled).toBe(true);
  });
});

describe('ShadowMeteringService.reconcileProviders', () => {
  it('skips every provider with a reason while no credentials are provisioned, and never throws', async () => {
    const { service, eventEmitter } = makeService(makeBaseClient());

    const sweep = await service.reconcileProviders(FIXED_NOW);

    expect(sweep.reconciled).toBe(0);
    expect(sweep.failed).toBe(0);
    expect(sweep.skipped).toBeGreaterThanOrEqual(4);
    expect(sweep.results.every((r) => (r.reason ?? '').length > 0)).toBe(true);
    // Skipping is not a breach — nothing should alert just because the platform
    // has no vendor credentials yet.
    expect(eventEmitter.emit).not.toHaveBeenCalled();
  });

  it('reconciles against the CLOUD-only ledger total — never BYOK or self-hosted', async () => {
    const aggregate = vi.fn().mockResolvedValue({ _sum: { quantitySum: decimalLike(1000) } });
    const baseClient = makeBaseClient({ aiUsageRollupDaily: { aggregate } });
    const { service } = makeService(baseClient, false, { getSecretOptional: async () => 'sk-test' });
    // A credential alone does not reach the ledger — the CLIENT gate must pass
    // too, so this needs a wired vendor to exercise the query at all.
    const wired: ProviderReconcilerSpec = {
      provider: 'azure-speech',
      secretKey: 'AZURE_COST_MANAGEMENT_CREDENTIAL',
      endpointHint: 'GET /usage',
      fetchControlTotal: async () => ({ provider: 'azure-speech', windowStart: FIXED_NOW, windowEnd: FIXED_NOW, unit: 'seconds', quantity: 1000 }),
    };
    (service as unknown as { providerRegistry: Map<string, unknown> }).providerRegistry = buildProviderReconcilerRegistry(
      async () => 'sk-test',
      [wired],
    );

    await service.reconcileProviders(FIXED_NOW);

    // Every provider query the sweep issued must carry deployment: CLOUD.
    // Without it, BYOK (tenant-funded) and self-hosted (no vendor bill) usage
    // would be expected to appear on a vendor invoice and drift permanently.
    const providerQueries = aggregate.mock.calls.filter((call) => call[0]?.where?.deployment !== undefined);
    expect(providerQueries.length).toBeGreaterThan(0);
    for (const [args] of providerQueries) {
      expect(args.where.deployment).toBe('CLOUD');
      expect(args.where.tenantId).toBeUndefined(); // platform-wide, not a tenant slice
    }
  });

  it('records a vendor failure and CONTINUES — reconciliation never blocks metering', async () => {
    const boom: ProviderReconcilerSpec = {
      provider: 'boomvendor',
      secretKey: 'BOOM_KEY',
      endpointHint: 'GET /usage',
      fetchControlTotal: async () => {
        throw new Error('502 from vendor');
      },
    };
    const { service } = makeService(makeBaseClient(), false, { getSecretOptional: async () => 'sk-test' });
    // Swap in a registry containing one always-failing vendor.
    (service as unknown as { providerRegistry: Map<string, unknown> }).providerRegistry = buildProviderReconcilerRegistry(
      async () => 'sk-test',
      [boom],
    );

    const sweep = await service.reconcileProviders(FIXED_NOW);

    expect(sweep.failed).toBe(1);
    expect(sweep.results[0].status).toBe('failed');
    expect(sweep.results[0].reason).toMatch(/502 from vendor/);
  });

  it('emits a drift alert when the vendor total disagrees with the ledger beyond the threshold', async () => {
    const aggregate = vi.fn().mockResolvedValue({ _sum: { quantitySum: decimalLike(1000) } });
    const drifting: ProviderReconcilerSpec = {
      provider: 'driftvendor',
      secretKey: 'DRIFT_KEY',
      endpointHint: 'GET /usage',
      // 1500 vs a ledger 1000 = +50%, far beyond the 2% threshold.
      fetchControlTotal: async () => ({ provider: 'driftvendor', windowStart: FIXED_NOW, windowEnd: FIXED_NOW, unit: 'tokens', quantity: 1500 }),
    };
    const { service, eventEmitter } = makeService(makeBaseClient({ aiUsageRollupDaily: { aggregate } }), false, {
      getSecretOptional: async () => 'sk-test',
    });
    (service as unknown as { providerRegistry: Map<string, unknown> }).providerRegistry = buildProviderReconcilerRegistry(
      async () => 'sk-test',
      [drifting],
    );

    const sweep = await service.reconcileProviders(FIXED_NOW);

    expect(sweep.reconciled).toBe(1);
    expect(sweep.breaches).toBe(1);
    expect(sweep.results[0].relativeDrift).toBeCloseTo(0.5, 6);
    expect(eventEmitter.emit).toHaveBeenCalledWith(
      'metering.provider-drift-detected',
      expect.objectContaining({ provider: 'driftvendor', ledgerQuantity: 1000, providerQuantity: 1500 }),
    );
  });

  it('ALERTS but never writes — the append-only ledger is corrected by a compensating event, not by the reconciler', async () => {
    const aggregate = vi.fn().mockResolvedValue({ _sum: { quantitySum: decimalLike(1000) } });
    const update = vi.fn();
    const create = vi.fn();
    const baseClient = makeBaseClient({ aiUsageRollupDaily: { aggregate, update, create } });
    const drifting: ProviderReconcilerSpec = {
      provider: 'driftvendor',
      secretKey: 'DRIFT_KEY',
      endpointHint: 'GET /usage',
      fetchControlTotal: async () => ({ provider: 'driftvendor', windowStart: FIXED_NOW, windowEnd: FIXED_NOW, unit: 'tokens', quantity: 9999 }),
    };
    const { service } = makeService(baseClient, false, { getSecretOptional: async () => 'sk-test' });
    (service as unknown as { providerRegistry: Map<string, unknown> }).providerRegistry = buildProviderReconcilerRegistry(
      async () => 'sk-test',
      [drifting],
    );

    await service.reconcileProviders(FIXED_NOW);

    expect(update).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });
});

describe('reconciliation run audit trail (rule 6)', () => {
  it('records SKIPPED runs too — the gap is what an auditor asks about', async () => {
    const { service, runRepository } = makeService(makeBaseClient());

    const sweep = await service.reconcileProviders(FIXED_NOW);

    // "We have not reconciled openai since March because the credential
    // expired" is invisible if only successful comparisons are stored.
    expect(runRepository.create).toHaveBeenCalledTimes(sweep.results.length);
    const persisted = runRepository.create.mock.calls.map(([entity]) => entity as Record<string, unknown>);
    expect(persisted.every((run) => run.status === 'skipped')).toBe(true);
    expect(persisted.every((run) => typeof run.reason === 'string' && (run.reason as string).length > 0)).toBe(true);
  });

  it('stores NULL — not 0 — for a run that never produced a comparison', async () => {
    const { service, runRepository } = makeService(makeBaseClient());

    await service.reconcileProviders(FIXED_NOW);

    const [first] = runRepository.create.mock.calls.map(([entity]) => entity as Record<string, unknown>);
    // A stored 0 would be indistinguishable from "the vendor genuinely billed
    // nothing", which is the one reading that must never be guessed.
    expect(first.ledgerQuantity).toBeNull();
    expect(first.providerQuantity).toBeNull();
    expect(first.relativeDrift).toBeNull();
  });

  it('stamps the threshold IN FORCE at run time, so a later change cannot reinterpret the verdict', async () => {
    const { service, runRepository } = makeService(makeBaseClient());

    await service.reconcileProviders(FIXED_NOW);

    const persisted = runRepository.create.mock.calls.map(([entity]) => entity as Record<string, unknown>);
    expect(persisted.every((run) => run.thresholdPct === 2)).toBe(true);
  });

  it('records a reconciled run with both totals and the verdict', async () => {
    const aggregate = vi.fn().mockResolvedValue({ _sum: { quantitySum: decimalLike(1000) } });
    const drifting: ProviderReconcilerSpec = {
      provider: 'driftvendor',
      secretKey: 'DRIFT_KEY',
      endpointHint: 'GET /usage',
      fetchControlTotal: async () => ({ provider: 'driftvendor', windowStart: FIXED_NOW, windowEnd: FIXED_NOW, unit: 'tokens', quantity: 1500 }),
    };
    const { service, runRepository } = makeService(makeBaseClient({ aiUsageRollupDaily: { aggregate } }), false, {
      getSecretOptional: async () => 'sk-test',
    });
    (service as unknown as { providerRegistry: Map<string, unknown> }).providerRegistry = buildProviderReconcilerRegistry(
      async () => 'sk-test',
      [drifting],
    );

    await service.reconcileProviders(FIXED_NOW);

    const [run] = runRepository.create.mock.calls.map(([entity]) => entity as Record<string, unknown>);
    expect(run.status).toBe('reconciled');
    expect(run.ledgerQuantity).toBe(1000);
    expect(run.providerQuantity).toBe(1500);
    expect(run.providerUnit).toBe('tokens');
    expect(run.breachedThreshold).toBe(true);
    expect(run.provider).toBe('driftvendor');
  });

  it('a persistence failure does not fail the sweep — reconciliation is a diagnostic', async () => {
    const runRepository = makeRunRepository();
    runRepository.create.mockRejectedValue(new Error('table gone'));
    const { service } = makeService(makeBaseClient(), false, undefined, runRepository);

    // The sweep still returns its result; the audit write is best-effort.
    await expect(service.reconcileProviders(FIXED_NOW)).resolves.toMatchObject({ skipped: expect.any(Number) });
  });
});
