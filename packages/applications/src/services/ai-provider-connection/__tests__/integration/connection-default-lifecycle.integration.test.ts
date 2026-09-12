/**
 * TASK-958 review fix G1/F1 — the default slot across a DELETE, against a real
 * PostgreSQL database.
 *
 * This one has to be an integration test. The bug is a property of an INDEX:
 * `AiProviderConnection_tenant_service_default_key` is a plain unique on
 * (tenantId, service, defaultForProvider) — not partial, and blind to
 * `resourceStatus` — so a soft-deleted DEFAULT keeps holding its provider's
 * slot while every runtime read filters it out. The reviewer's scenario is
 * exactly that gap between what Postgres sees and what the service sees:
 *
 *   delete the tenant's only `llm/openai` connection, then
 *   `PUT llm/openai-research {provider:'openai'}` with `If-Match: "0"`
 *     → the new row must elect itself default (no live default remains)
 *     → before the fix: P2002 on the tombstone, unmapped, and EVERY new slug
 *       for that provider stayed wedged until the original slug was revived.
 *
 * A unit fixture can model the index (and one does, in
 * `ai-provider-connection.review-fixes.task958.test.ts`), but only the database
 * can prove the model is right.
 *
 * OPT-IN, and deliberately so. `packages/applications/vitest.config.ts` does NOT
 * exclude integration directories the way the root config does, and importing
 * `@arcaai/database` loads `.env.test` — so an UNGATED file here would connect
 * to (and write to) a real database during the ordinary
 * `pnpm --filter @arcaai/applications test` unit gate. `HOPE_INTEG_DB=1` is the
 * same shape as `INTEG_VAULT=1` on `vault-secrets.provider.integration.test.ts`
 * in this package: without it the suite short-circuits and nothing connects.
 *
 * To run it:
 *   1. point `DATABASE_URL`/`DIRECT_URL` at a migrated database — the isolated
 *      test infra (`pnpm infra:test:up` + `pnpm test:db:push`) or a throwaway
 *      shadow DB with the ledger replayed onto it;
 *   2. `HOPE_INTEG_DB=1 pnpm test:integration` (or vitest on this file alone).
 * It owns a throwaway tenant id of its own and deletes its rows around every
 * test, so it never touches seeded data.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
// eslint-disable-next-line no-restricted-imports -- allow-list: integration test fixture, no tenant context is established outside Nest
import { getPlatformAdminPrismaClient_Unscoped, getExtendedPrismaClient, CorePrismaClient } from '@arcaai/database';
import { AiProviderConnectionRepository } from '@arcaai/domains';
import { AiProviderConnectionService } from '../../ai-provider-connection.service';

/** A tenant no seed writes to — this suite owns every row under it. */
const TENANT_ID = '958a0000-0000-4000-8000-000000000958';

/** Opt-in gate — see the header: an ungated file here writes to a live DB during the unit gate. */
const enabled = process.env.HOPE_INTEG_DB === '1' && !!process.env.DATABASE_URL;

describe.skipIf(!enabled)('TASK-958/G1 — the provider default slot survives a delete (integration)', () => {
  let service: AiProviderConnectionService;
  let basePrisma: CorePrismaClient;

  beforeAll(async () => {
    const extended = getExtendedPrismaClient();
    basePrisma = getPlatformAdminPrismaClient_Unscoped();
    await basePrisma.$connect();

    const repository = new AiProviderConnectionRepository({
      getDatabaseService: () => extended,
      startTransaction: async () => {},
      endTransaction: () => {},
    } as never);

    service = new AiProviderConnectionService(
      repository,
      { baseClient: basePrisma } as never,
      { emit: () => true } as never,
      { get: (key: string) => (key === 'user' ? { id: '60000000-0000-0000-0000-000000000000', roles: [] } : key === 'tenantId' ? TENANT_ID : undefined) } as never,
      // No key material is written by this suite, so Transit is never reached.
      { supportsTransit: () => false } as never,
      { isFeatureEnabled: async () => true, assertQuantityQuota: async () => undefined } as never,
    );
  });

  afterAll(async () => {
    await basePrisma.$executeRaw`DELETE FROM core."AiProviderConnection" WHERE "tenantId" = ${TENANT_ID}`;
    await basePrisma.$disconnect();
  });

  beforeEach(async () => {
    await basePrisma.$executeRaw`DELETE FROM core."AiProviderConnection" WHERE "tenantId" = ${TENANT_ID}`;
  });

  const markerOf = async (slug: string): Promise<string | null> => {
    const rows = await basePrisma.$queryRaw<Array<{ defaultForProvider: string | null }>>`
      SELECT "defaultForProvider" FROM core."AiProviderConnection"
      WHERE "tenantId" = ${TENANT_ID} AND service = 'llm' AND slug = ${slug}
    `;
    return rows[0]?.defaultForProvider ?? null;
  };

  it('deleting the only default releases the slot: the TOMBSTONE carries no default marker', async () => {
    await service.upsertRow('llm', 'openai', { expectedVersion: 0 }, TENANT_ID);
    expect(await markerOf('openai')).toBe('openai');

    await service.deleteRow('llm', 'openai', TENANT_ID);

    const [row] = await basePrisma.$queryRaw<Array<{ resourceStatus: string; defaultForProvider: string | null }>>`
      SELECT "resourceStatus", "defaultForProvider" FROM core."AiProviderConnection"
      WHERE "tenantId" = ${TENANT_ID} AND service = 'llm' AND slug = 'openai'
    `;
    expect(row?.resourceStatus, 'the row is soft-deleted, not removed').toBe('DELETED');
    expect(row?.defaultForProvider, 'a dead row must not occupy the provider’s unique default slot').toBeNull();
  });

  it('reviewer #1: after deleting the only `llm/openai` row, a NEW slug for that provider creates and becomes the default', async () => {
    await service.upsertRow('llm', 'openai', { expectedVersion: 0 }, TENANT_ID);
    await service.deleteRow('llm', 'openai', TENANT_ID);

    const created = await service.upsertRow('llm', 'openai-research', { provider: 'openai', name: 'Research', expectedVersion: 0 }, TENANT_ID);

    expect(created).toMatchObject({ slug: 'openai-research', provider: 'openai', isDefault: true });
    expect(await markerOf('openai-research')).toBe('openai');
  });

  it('and the database still refuses a SECOND live default for the same provider', async () => {
    await service.upsertRow('llm', 'openai', { expectedVersion: 0 }, TENANT_ID);
    const sibling = await service.upsertRow('llm', 'openai-research', { provider: 'openai', expectedVersion: 0 }, TENANT_ID);
    expect(sibling.isDefault, 'a live default already exists, so the sibling is not one').toBe(false);

    await expect(
      basePrisma.$executeRaw`
        UPDATE core."AiProviderConnection" SET "defaultForProvider" = 'openai'
        WHERE "tenantId" = ${TENANT_ID} AND service = 'llm' AND slug = 'openai-research'
      `,
      'AiProviderConnection_tenant_service_default_key is what makes "one default per provider" a fact',
    ).rejects.toThrow();
  });

  it('reviving the deleted slug while another default lives makes it a sibling', async () => {
    await service.upsertRow('llm', 'openai', { expectedVersion: 0 }, TENANT_ID);
    await service.deleteRow('llm', 'openai', TENANT_ID);
    await service.upsertRow('llm', 'openai-research', { provider: 'openai', expectedVersion: 0 }, TENANT_ID);

    const revived = await service.upsertRow('llm', 'openai', { provider: 'openai', expectedVersion: 0 }, TENANT_ID);

    expect(revived).toMatchObject({ slug: 'openai', isDefault: false });
    expect(await markerOf('openai')).toBeNull();
    expect(await markerOf('openai-research')).toBe('openai');
  });
});
