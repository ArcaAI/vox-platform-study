/**
 * TASK-958 (tests 2 + 3) — multiplicity, against a real PostgreSQL database.
 *
 * The two properties under test are DATABASE properties and cannot be proven
 * anywhere else:
 *
 *   (2) two connections for the same `(tenant, service, provider)` with
 *       distinct slugs both persist — the constraint that used to refuse this
 *       (`AiProviderConnection_tenantId_service_provider_key`) is gone;
 *   (3) a SECOND row claiming the same provider's default slot is refused by
 *       `AiProviderConnection_tenant_service_default_key` — "one default per
 *       provider" is enforced by Postgres, not by a service-layer read-then-write
 *       that races.
 *
 * It also exercises the three new repository lookups, because their ORDERING
 * ("default first, then oldest") is what the cascade reads and it depends on
 * Postgres sorting NULLs last on an ASC order by.
 *
 * Prerequisites (same as its siblings in this folder):
 *   1. Start test infrastructure: pnpm infra:test:up
 *   2. Push schema: pnpm test:db:push
 *   3. Run tests: pnpm test:integration
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
// eslint-disable-next-line no-restricted-imports -- allow-list: integration test fixture, tenant context not yet established
import { getPlatformAdminPrismaClient_Unscoped, getExtendedPrismaClient, CorePrismaClient } from '@arcaai/database';
import { AiProviderConnectionRepository } from '../repositories/generated/core/AiProviderConnectionRepository';
import { AiProviderConnectionFactory } from '../factories/generated/core/AiProviderConnectionFactory';

const TEST_TENANT_ID = '50000000-0000-0000-0000-000000000000';
const SYSTEM_USER_ID = '60000000-0000-0000-0000-000000000000';

/** Minimal UnitOfWork stub — the `repository-soft-delete` precedent in this folder. */
function createUnitOfWorkStub() {
  const extendedClient = getExtendedPrismaClient();
  return {
    getDatabaseService: () => extendedClient,
    startTransaction: async () => {},
    endTransaction: () => {},
  };
}

describe('TASK-958 AiProviderConnection multiplicity (integration)', () => {
  let repository: AiProviderConnectionRepository;
  let basePrisma: CorePrismaClient;

  const create = (overrides: Record<string, unknown> = {}) =>
    AiProviderConnectionFactory.CreateAiProviderConnection({
      tenantId: TEST_TENANT_ID,
      service: 'llm',
      provider: 'openai',
      enabled: true,
      createdBy: SYSTEM_USER_ID,
      ...overrides,
    } as never);

  beforeAll(async () => {
    repository = new AiProviderConnectionRepository(createUnitOfWorkStub() as never);
    basePrisma = getPlatformAdminPrismaClient_Unscoped();
    await basePrisma.$connect();
  });

  afterAll(async () => {
    await basePrisma.$disconnect();
  });

  beforeEach(async () => {
    await basePrisma.$executeRaw`
      DELETE FROM core."AiProviderConnection" WHERE "tenantId" = ${TEST_TENANT_ID}
    `;
  });

  it('(2) persists two connections for one (tenant, service, provider) with distinct slugs', async () => {
    await repository.create(create());
    await repository.create(create({ slug: 'openai-research', defaultForProvider: null, name: 'Research account' }));

    const rows = await repository.findAllByTenantServiceProvider('llm', 'openai', TEST_TENANT_ID);
    expect(rows.map((r) => r.slug)).toEqual(['openai', 'openai-research']);
    // Ordering is the contract, not an accident: the DEFAULT leads, and it does
    // so because siblings carry NULL and Postgres sorts NULLs last on ASC.
    expect(rows[0]?.isDefault).toBe(true);
    expect(rows[1]?.isDefault).toBe(false);
  });

  it('(3) refuses a SECOND default for the same (tenant, service, provider)', async () => {
    await repository.create(create());

    await expect(repository.create(create({ slug: 'openai-second' }))).rejects.toThrow(
      /AiProviderConnection_tenant_service_default_key|Unique constraint/i,
    );

    const rows = await repository.findAllByTenantServiceProvider('llm', 'openai', TEST_TENANT_ID);
    expect(rows).toHaveLength(1);
  });

  it('refuses a duplicate SLUG within one (tenant, service)', async () => {
    await repository.create(create());
    await expect(repository.create(create({ slug: 'openai', defaultForProvider: null }))).rejects.toThrow(
      /AiProviderConnection_tenant_service_slug_key|Unique constraint/i,
    );
  });

  it('allows the same slug under a DIFFERENT service — the discriminator is part of the identity', async () => {
    await repository.create(create());
    await repository.create(create({ service: 'stt', provider: 'openai' }));

    const llm = await repository.findByTenantServiceSlug('llm', 'openai', TEST_TENANT_ID);
    const stt = await repository.findByTenantServiceSlug('stt', 'openai', TEST_TENANT_ID);
    expect(llm?.service).toBe('llm');
    expect(stt?.service).toBe('stt');
    expect(llm?.id).not.toBe(stt?.id);
  });

  it('resolves the DEFAULT by provider and the SIBLING only by slug', async () => {
    await repository.create(create());
    await repository.create(create({ slug: 'openai-research', defaultForProvider: null }));

    // The provider-NAME cascade sees exactly one row, deterministically.
    const byProvider = await repository.findDefaultByTenantServiceProvider('llm', 'openai', TEST_TENANT_ID);
    expect(byProvider?.slug).toBe('openai');

    // ... and the deprecated alias must agree with it, which is what makes the
    // rename safe for the callers that have not moved yet.
    const viaAlias = await repository.findByTenantServiceProvider('llm', 'openai', TEST_TENANT_ID);
    expect(viaAlias?.id).toBe(byProvider?.id);

    const sibling = await repository.findByTenantServiceSlug('llm', 'openai-research', TEST_TENANT_ID);
    expect(sibling?.isDefault).toBe(false);
  });

  it('a soft-deleted sibling blocks its own SLUG and nothing else', async () => {
    const sibling = await repository.create(create({ slug: 'openai-research', defaultForProvider: null }));
    await repository.softDelete(sibling.id);

    // Live lookups no longer see it ...
    expect(await repository.findByTenantServiceSlug('llm', 'openai-research', TEST_TENANT_ID)).toBeNull();
    // ... but the tombstone still occupies the slug, which is exactly why the
    // create-intent path looks for it before inserting.
    const tombstone = await repository.findDeletedByTenantServiceSlug('llm', 'openai-research', TEST_TENANT_ID);
    expect(tombstone?.id).toBe(sibling.id);

    // And it never stood in the way of the DEFAULT row.
    await expect(repository.create(create())).resolves.toBeTruthy();
  });
});
