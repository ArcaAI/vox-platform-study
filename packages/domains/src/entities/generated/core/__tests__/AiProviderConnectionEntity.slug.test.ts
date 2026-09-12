/**
 * TASK-958 — connection identity moved from `(tenant, service, provider)` to
 * `(tenant, service, slug)`, and "which row is the default" became a column.
 *
 * The three things that are easy to get wrong here, and that this suite locks:
 *
 *  - a pre-TASK-958 factory call (no slug, no `defaultForProvider`) must keep
 *    producing exactly the row it produced before — the tenant's DEFAULT
 *    connection, addressed by the provider name. That equivalence is the whole
 *    reason the migration backfilled `slug = provider`;
 *  - `isDefault` is DERIVED from `defaultForProvider`, never stored, and the
 *    column carries the provider id (not a boolean) so the unique index can
 *    enforce one default per provider;
 *  - slug shape and the `defaultForProvider === provider` rule are STRUCTURAL
 *    invariants — a bad slug mints unroutable BYO model slugs and an
 *    unaddressable route, so it must not reach persistence.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect } from 'vitest';
import { AiProviderConnectionFactory } from '../../../../factories/generated/core/AiProviderConnectionFactory';
import { AiProviderConnectionEntity } from '../AiProviderConnectionEntity';

const create = (overrides: Record<string, unknown> = {}) =>
  AiProviderConnectionFactory.CreateAiProviderConnection({
    tenantId: '50000000-0000-0000-0000-000000000000',
    service: 'llm',
    provider: 'openai',
    ...overrides,
  } as any);

describe('AiProviderConnectionFactory — slug / name / defaultForProvider', () => {
  it('defaults an omitted slug to the provider and makes the row the DEFAULT', () => {
    const row = create();
    expect(row.slug).toBe('openai');
    expect(row.defaultForProvider).toBe('openai');
    expect(row.isDefault).toBe(true);
    expect(row.name).toBeNull();
  });

  it('creates a NAMED sibling when a slug and an explicit null default are given', () => {
    const row = create({ slug: 'openai-research', defaultForProvider: null, name: 'Research account' });
    expect(row.slug).toBe('openai-research');
    expect(row.provider).toBe('openai');
    expect(row.defaultForProvider).toBeNull();
    expect(row.isDefault).toBe(false);
    expect(row.name).toBe('Research account');
  });

  it('distinguishes an OMITTED defaultForProvider from an explicit null', () => {
    // `?? provider` would collapse the two and make every sibling a default,
    // which the database then refuses on the second insert — a confusing 500
    // where the caller meant "not the default".
    expect(create({ slug: 'openai-two' }).isDefault).toBe(true);
    expect(create({ slug: 'openai-two', defaultForProvider: null }).isDefault).toBe(false);
  });
});

describe('AiProviderConnectionEntity — change tracking', () => {
  it('routes the three new setters through setProperty', () => {
    const row = create();
    (row as any).clearChanges?.();
    row.name = 'Renamed';
    row.defaultForProvider = null;
    expect(Object.keys(row.changes as Record<string, unknown>)).toEqual(expect.arrayContaining(['name', 'defaultForProvider']));
  });
});

describe('AiProviderConnectionEntity.validate — structural invariants', () => {
  it.each([
    ['openai', true],
    ['openai-research', true],
    ['a1', true],
    ['a'.repeat(63), true],
    ['', false],
    ['a', false], // one char — the pattern requires at least two
    ['Openai', false], // uppercase
    ['-openai', false], // leading hyphen
    ['openai_research', false], // underscore
    ['openai research', false], // space
    ['openai/research', false], // path separator — would break the route
    ['a'.repeat(64), false],
  ])('slug %p is accepted: %s', (slug, ok) => {
    const row = create({ slug, defaultForProvider: null });
    if (ok) expect(() => row.validate()).not.toThrow();
    else expect(() => row.validate()).toThrow(/Slug must be/);
  });

  it('refuses a defaultForProvider that is not the row\'s own provider', () => {
    // A row parked in another provider's default slot would be resolved by the
    // cascade for a vendor it cannot serve.
    const row = create({ slug: 'openai-research', defaultForProvider: 'azure' });
    expect(() => row.validate()).toThrow(/defaultForProvider must equal provider/);
  });

  it('accepts the two legitimate defaultForProvider values', () => {
    expect(() => create().validate()).not.toThrow();
    expect(() => create({ slug: 'openai-research', defaultForProvider: null }).validate()).not.toThrow();
  });

  it('exposes the slug pattern the application layer validates against', () => {
    // Lane B1 reuses this rather than re-typing the regex; two copies drift.
    expect(AiProviderConnectionEntity.SLUG_PATTERN.source).toBe('^[a-z0-9][a-z0-9-]{1,62}$');
  });
});
