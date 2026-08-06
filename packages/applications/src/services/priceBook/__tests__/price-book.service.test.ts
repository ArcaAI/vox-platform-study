/**
 * PriceBookService — the repository-facing half of rating.
 *
 * Two behaviours here are money-critical and neither is obvious from the
 * schema: rating keys off `occurredAt` (not `recordedAt`), and a tenant that
 * has a card of its own is priced off that card rather than the platform's.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AiCapability, AiPriceBookPlane, AiUsageUnit, SYSTEM_TENANT_ID, TenantPlan } from '@arcaai/domains';

import { PriceBookService } from '../price-book.service';

const TENANT = '50000000-0000-0000-0000-000000000000';

const mockRepository = {
  findEffectiveCandidates: vi.fn(),
  findEffectivePlanFee: vi.fn(),
};

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: '018f0000-0000-7000-8000-000000000001',
    tenantId: SYSTEM_TENANT_ID,
    provider: null,
    model: null,
    contextBand: null,
    planTier: null,
    unitPriceMicros: 3n,
    bookVersion: '2026-08-06-placeholder-v1',
    currency: 'USD',
    effectiveFrom: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

describe('PriceBookService.resolveCostPrice', () => {
  let service: PriceBookService;

  beforeEach(() => {
    vi.clearAllMocks();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    service = new PriceBookService(mockRepository as any);
  });

  it('resolves against the row effective at occurredAt, NOT at recordedAt', async () => {
    // A backfilled or abort-path event is observed long after it happened.
    // Pricing it at today's rate silently re-rates history.
    const occurredAt = new Date('2026-03-15T10:00:00Z');
    mockRepository.findEffectiveCandidates.mockResolvedValue([row({ provider: 'openai', unitPriceMicros: 5n })]);

    const resolved = await service.resolveCostPrice({
      tenantId: SYSTEM_TENANT_ID,
      capability: AiCapability.LLM,
      unit: AiUsageUnit.INPUT_TOKEN,
      provider: 'openai',
      occurredAt,
    });

    expect(resolved).toEqual({
      priceBookId: '018f0000-0000-7000-8000-000000000001',
      unitPriceMicros: 5n,
      bookVersion: '2026-08-06-placeholder-v1',
      currency: 'USD',
    });
    expect(mockRepository.findEffectiveCandidates).toHaveBeenCalledWith(expect.objectContaining({ at: occurredAt, plane: AiPriceBookPlane.COST }));
  });

  it('does NOT pre-filter provider/model in the query — precedence is decided in one place', async () => {
    // Filtering `provider = 'openai'` in SQL would drop the catch-all rows the
    // seed relies on, and would move half the precedence rule into a where clause.
    mockRepository.findEffectiveCandidates.mockResolvedValue([]);

    await service.resolveCostPrice({
      tenantId: SYSTEM_TENANT_ID,
      capability: AiCapability.STT,
      unit: AiUsageUnit.AUDIO_SECOND,
      provider: 'whisper_cpp',
      occurredAt: new Date(),
    });

    const query = mockRepository.findEffectiveCandidates.mock.calls[0][0];
    expect(query.provider).toBeUndefined();
    expect(query.model).toBeUndefined();
    expect(query.contextBand).toBeUndefined();
  });

  it('prices a tenant off its OWN card when it has a matching row (negotiated rate)', async () => {
    mockRepository.findEffectiveCandidates.mockImplementation(async (query: { tenantId: string }) =>
      query.tenantId === TENANT
        ? [row({ id: 'tenant-row', tenantId: TENANT, unitPriceMicros: 2n })]
        : [row({ provider: 'anthropic', unitPriceMicros: 15n })],
    );

    const resolved = await service.resolveCostPrice({
      tenantId: TENANT,
      capability: AiCapability.LLM,
      unit: AiUsageUnit.INPUT_TOKEN,
      provider: 'anthropic',
      occurredAt: new Date(),
    });

    // The tenant's blanket rate wins even though the SYSTEM row is more
    // specific — a negotiated card is an override, not a suggestion.
    expect(resolved?.unitPriceMicros).toBe(2n);
    expect(mockRepository.findEffectiveCandidates).toHaveBeenCalledTimes(1);
  });

  it('falls back to the SYSTEM platform card when no tenant row matches', async () => {
    mockRepository.findEffectiveCandidates.mockImplementation(async (query: { tenantId: string }) =>
      // The tenant has a card, but only for a different provider.
      query.tenantId === TENANT
        ? [row({ id: 'tenant-openai', tenantId: TENANT, provider: 'openai', unitPriceMicros: 1n })]
        : [row({ provider: 'anthropic', unitPriceMicros: 15n })],
    );

    const resolved = await service.resolveCostPrice({
      tenantId: TENANT,
      capability: AiCapability.LLM,
      unit: AiUsageUnit.INPUT_TOKEN,
      provider: 'anthropic',
      occurredAt: new Date(),
    });

    expect(resolved?.unitPriceMicros).toBe(15n);
    expect(mockRepository.findEffectiveCandidates).toHaveBeenCalledTimes(2);
    expect(mockRepository.findEffectiveCandidates.mock.calls[1][0].tenantId).toBe(SYSTEM_TENANT_ID);
  });

  it('queries once when the caller IS the SYSTEM tenant', async () => {
    mockRepository.findEffectiveCandidates.mockResolvedValue([row()]);
    await service.resolveCostPrice({
      tenantId: SYSTEM_TENANT_ID,
      capability: AiCapability.NLP,
      unit: AiUsageUnit.REQUEST,
      provider: 'gliner',
      occurredAt: new Date(),
    });
    expect(mockRepository.findEffectiveCandidates).toHaveBeenCalledTimes(1);
  });

  it('returns a ZERO price as a real result — never conflated with "unpriced"', async () => {
    // The seeded STT SESSION_SECOND COGS row and the NLP REQUEST row are both
    // deliberately zero. `?? null` on a falsy price would unrate them forever.
    mockRepository.findEffectiveCandidates.mockResolvedValue([row({ unitPriceMicros: 0n })]);

    const resolved = await service.resolveCostPrice({
      tenantId: SYSTEM_TENANT_ID,
      capability: AiCapability.STT,
      unit: AiUsageUnit.SESSION_SECOND,
      provider: 'whisper_cpp',
      occurredAt: new Date(),
    });

    expect(resolved).not.toBeNull();
    expect(resolved?.unitPriceMicros).toBe(0n);
    expect(resolved?.bookVersion).toBe('2026-08-06-placeholder-v1');
  });

  it('returns null when nothing resolves — rating fails OPEN so metering survives', async () => {
    mockRepository.findEffectiveCandidates.mockResolvedValue([]);
    const resolved = await service.resolveCostPrice({
      tenantId: SYSTEM_TENANT_ID,
      capability: AiCapability.TTS,
      unit: AiUsageUnit.CHARACTER,
      provider: 'brand-new-vendor',
      occurredAt: new Date(),
    });
    expect(resolved).toBeNull();
  });
});

describe('PriceBookService.resolveSellPrice / resolvePlanFee', () => {
  let service: PriceBookService;

  beforeEach(() => {
    vi.clearAllMocks();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    service = new PriceBookService(mockRepository as any);
  });

  it('reads the SELL plane and passes the plan tier through to ranking', async () => {
    mockRepository.findEffectiveCandidates.mockResolvedValue([
      row({ id: 'tier-agnostic', unitPriceMicros: 10n }),
      row({ id: 'enterprise', planTier: TenantPlan.ENTERPRISE, unitPriceMicros: 8n }),
    ]);

    const resolved = await service.resolveSellPrice({
      tenantId: SYSTEM_TENANT_ID,
      capability: AiCapability.STT,
      unit: AiUsageUnit.SESSION_SECOND,
      provider: null,
      planTier: TenantPlan.ENTERPRISE,
      occurredAt: new Date(),
    });

    expect(mockRepository.findEffectiveCandidates.mock.calls[0][0].plane).toBe(AiPriceBookPlane.SELL);
    expect(resolved?.unitPriceMicros).toBe(8n);
  });

  it('resolvePlanFee delegates to the single-row PLAN_FEE lookup', async () => {
    const at = new Date('2026-08-01T00:00:00Z');
    mockRepository.findEffectivePlanFee.mockResolvedValue(row({ id: 'fee', planTier: TenantPlan.PRO, unitPriceMicros: 499_000_000n }));

    const fee = await service.resolvePlanFee(SYSTEM_TENANT_ID, TenantPlan.PRO, at);

    expect(mockRepository.findEffectivePlanFee).toHaveBeenCalledWith(SYSTEM_TENANT_ID, TenantPlan.PRO, at);
    expect(fee?.unitPriceMicros).toBe(499_000_000n);
  });

  it('resolvePlanFee falls back to the SYSTEM card for a tenant with no fee row of its own', async () => {
    mockRepository.findEffectivePlanFee.mockImplementation(async (tenantId: string) =>
      tenantId === SYSTEM_TENANT_ID ? row({ id: 'system-fee', unitPriceMicros: 99n }) : null,
    );

    const fee = await service.resolvePlanFee(TENANT, TenantPlan.STARTER, new Date());
    expect(fee?.unitPriceMicros).toBe(99n);
    expect(mockRepository.findEffectivePlanFee).toHaveBeenCalledTimes(2);
  });

  it('resolvePlanFee returns null when neither card carries the tier', async () => {
    mockRepository.findEffectivePlanFee.mockResolvedValue(null);
    expect(await service.resolvePlanFee(TENANT, TenantPlan.TRIAL, new Date())).toBeNull();
  });
});
