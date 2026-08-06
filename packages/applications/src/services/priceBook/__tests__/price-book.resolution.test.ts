/**
 * Price resolution precedence — the pure ranking half.
 *
 * This is CONTRACT, not an implementation detail: which row prices an event
 * decides what a tenant is charged, and WS-I's invoice engine reads the same
 * function. Every rule below is asserted explicitly rather than left to emerge
 * from a query's ORDER BY, because an ORDER BY cannot be reviewed by the person
 * approving the rate card.
 */

import { describe, expect, it } from 'vitest';
import { TenantPlan } from '@arcaai/domains';

import { computeCostMicros, selectMostSpecificPrice, type PriceCandidate } from '../price-book.resolution';

const SYSTEM = '00000000-0000-0000-0000-000000000000';

function candidate(overrides: Partial<PriceCandidate> & Pick<PriceCandidate, 'id'>): PriceCandidate {
  return {
    tenantId: SYSTEM,
    provider: null,
    model: null,
    contextBand: null,
    planTier: null,
    unitPriceMicros: 1n,
    bookVersion: 'book-v1',
    currency: 'USD',
    effectiveFrom: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

describe('selectMostSpecificPrice — most-specific-wins', () => {
  it('prefers (provider + model) over (provider) over the capability catch-all', () => {
    const catchAll = candidate({ id: 'c', unitPriceMicros: 1n });
    const providerWide = candidate({ id: 'b', provider: 'anthropic', unitPriceMicros: 2n });
    const exact = candidate({ id: 'a', provider: 'anthropic', model: 'claude-sonnet-5', unitPriceMicros: 3n });

    // Shuffled input: the ranking must not depend on arrival order.
    const query = { provider: 'anthropic', model: 'claude-sonnet-5', contextBand: null, planTier: null, tenantId: SYSTEM };
    expect(selectMostSpecificPrice([catchAll, exact, providerWide], query)?.id).toBe('a');
    expect(selectMostSpecificPrice([providerWide, catchAll], query)?.id).toBe('b');
    expect(selectMostSpecificPrice([catchAll], query)?.id).toBe('c');
  });

  it('EXCLUDES a row whose provider or model names something else', () => {
    const otherProvider = candidate({ id: 'x', provider: 'openai' });
    const otherModel = candidate({ id: 'y', provider: 'anthropic', model: 'claude-haiku-5' });
    const query = { provider: 'anthropic', model: 'claude-sonnet-5', contextBand: null, planTier: null, tenantId: SYSTEM };

    expect(selectMostSpecificPrice([otherProvider, otherModel], query)).toBeNull();
  });

  it('a NULL dimension is a wildcard, not a mismatch', () => {
    // This is what makes the seeded `provider: null` self-hosted catch-all rows
    // work at all — they must match whichever engine id WS-C/WS-E settle on.
    const query = { provider: 'whisper_cpp', model: null, contextBand: null, planTier: null, tenantId: SYSTEM };
    expect(selectMostSpecificPrice([candidate({ id: 'catch' })], query)?.id).toBe('catch');
  });

  it('a resolved price of ZERO is a valid answer, never "no price"', () => {
    // Two seeded rows are deliberately zero (STT SESSION_SECOND COGS, NLP
    // REQUEST). Treating 0 as falsy would leave those rows unrated forever.
    const free = candidate({ id: 'free', provider: 'whisper_cpp', unitPriceMicros: 0n });
    const query = { provider: 'whisper_cpp', model: null, contextBand: null, planTier: null, tenantId: SYSTEM };
    const winner = selectMostSpecificPrice([free], query);
    expect(winner).not.toBeNull();
    expect(winner?.unitPriceMicros).toBe(0n);
  });

  it('prefers a matching contextBand over a band-agnostic row, and excludes a different band', () => {
    const agnostic = candidate({ id: 'any', provider: 'anthropic', unitPriceMicros: 3n });
    const longCtx = candidate({ id: 'long', provider: 'anthropic', contextBand: '128k+', unitPriceMicros: 6n });
    const shortCtx = candidate({ id: 'short', provider: 'anthropic', contextBand: '0-128k', unitPriceMicros: 3n });

    const query = { provider: 'anthropic', model: null, contextBand: '128k+', planTier: null, tenantId: SYSTEM };
    expect(selectMostSpecificPrice([agnostic, longCtx, shortCtx], query)?.id).toBe('long');

    // No band on the query: only the band-agnostic row may apply.
    const noBand = { provider: 'anthropic', model: null, contextBand: null, planTier: null, tenantId: SYSTEM };
    expect(selectMostSpecificPrice([agnostic, longCtx, shortCtx], noBand)?.id).toBe('any');
  });

  it('prefers a tier-specific SELL row over the tier-agnostic default, and excludes another tier', () => {
    const tierAgnostic = candidate({ id: 'default', unitPriceMicros: 10n });
    const enterprise = candidate({ id: 'ent', planTier: TenantPlan.ENTERPRISE, unitPriceMicros: 8n });
    const trial = candidate({ id: 'trial', planTier: TenantPlan.TRIAL, unitPriceMicros: 20n });

    const query = { provider: null, model: null, contextBand: null, planTier: TenantPlan.ENTERPRISE, tenantId: SYSTEM };
    expect(selectMostSpecificPrice([tierAgnostic, enterprise, trial], query)?.id).toBe('ent');
  });

  it('provider specificity outranks contextBand and planTier specificity', () => {
    const providerRow = candidate({ id: 'provider', provider: 'anthropic', unitPriceMicros: 5n });
    const bandOnlyRow = candidate({ id: 'band', contextBand: '128k+', planTier: TenantPlan.ENTERPRISE, unitPriceMicros: 9n });

    const query = { provider: 'anthropic', model: null, contextBand: '128k+', planTier: TenantPlan.ENTERPRISE, tenantId: SYSTEM };
    expect(selectMostSpecificPrice([bandOnlyRow, providerRow], query)?.id).toBe('provider');
  });

  it('breaks a specificity tie by the LATEST effectiveFrom (the supersede)', () => {
    const old = candidate({ id: 'old', provider: 'openai', effectiveFrom: new Date('2026-01-01T00:00:00Z'), unitPriceMicros: 1n });
    const current = candidate({ id: 'new', provider: 'openai', effectiveFrom: new Date('2026-06-01T00:00:00Z'), unitPriceMicros: 2n });

    const query = { provider: 'openai', model: null, contextBand: null, planTier: null, tenantId: SYSTEM };
    expect(selectMostSpecificPrice([current, old], query)?.id).toBe('new');
    expect(selectMostSpecificPrice([old, current], query)?.id).toBe('new');
  });

  it('breaks an effectiveFrom tie by insertion order (UUIDv7 id descending) — deterministic, never arbitrary', () => {
    // Two rows opened at the same instant is an operator mistake, not a design.
    // The resolution must still be REPRODUCIBLE: an invoice recomputed next
    // month has to pick the same row it picked this month.
    const first = candidate({ id: '018f0000-0000-7000-8000-000000000001', provider: 'openai', unitPriceMicros: 1n });
    const second = candidate({ id: '018f0000-0000-7000-8000-000000000002', provider: 'openai', unitPriceMicros: 2n });

    const query = { provider: 'openai', model: null, contextBand: null, planTier: null, tenantId: SYSTEM };
    expect(selectMostSpecificPrice([first, second], query)?.id).toBe(second.id);
    expect(selectMostSpecificPrice([second, first], query)?.id).toBe(second.id);
  });

  it('returns null for an empty candidate set', () => {
    expect(selectMostSpecificPrice([], { provider: 'openai', model: null, contextBand: null, planTier: null, tenantId: SYSTEM })).toBeNull();
  });
});

describe('computeCostMicros', () => {
  it('multiplies quantity by the unit price in integer micros', () => {
    expect(computeCostMicros(1000, 3n)).toBe(3000n);
    expect(computeCostMicros('2.5', 4n)).toBe(10n);
  });

  it('rounds HALF-UP at the micro — one documented rule, applied everywhere', () => {
    // 0.5 micro must not depend on JS float banker's rounding.
    expect(computeCostMicros('0.5', 1n)).toBe(1n);
    expect(computeCostMicros('1.5', 1n)).toBe(2n);
    expect(computeCostMicros('2.5', 1n)).toBe(3n);
    expect(computeCostMicros('0.4999', 1n)).toBe(0n);
  });

  it('keeps fractional audio seconds exact — no float drift', () => {
    // 12.345678 s at 3 micros/s. Float arithmetic gives 37.037034000000004.
    expect(computeCostMicros('12.345678', 3n)).toBe(37n);
  });

  it('a zero price yields a zero cost, not a null', () => {
    expect(computeCostMicros(3600, 0n)).toBe(0n);
  });

  it('a zero quantity yields zero', () => {
    expect(computeCostMicros(0, 999n)).toBe(0n);
  });

  it('handles very large quantities without precision loss', () => {
    // 10 billion tokens at 15 micros — beyond Number.MAX_SAFE_INTEGER once multiplied.
    expect(computeCostMicros('10000000000', 15n)).toBe(150000000000n);
  });
});
