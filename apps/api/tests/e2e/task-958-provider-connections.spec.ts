/**
 * TASK-958 e2e — several connections of ONE provider per tenant.
 *
 * Live-stack requirement: a running gateway (`pnpm test:up:api`) against the
 * seeded test database, as with every spec in this folder.
 *
 * What these prove that the unit tests cannot. The multiplicity rules live in
 * the service, but the thing a tenant admin actually meets is a ROUTE whose
 * `:provider` segment became `:slug` — so the questions are: does the pre-958
 * shape still write the row it always wrote, does a NAMED sibling round-trip
 * through the real pipe (a `provider` field the strict global pipe must accept,
 * an OCC token, a masked read), does another tenant's slug still hide behind a
 * 404, and do the two refusals that protect the default come back as 409/400
 * over real HTTP rather than a 500.
 *
 * §4.6 numbering: (22) legacy-shape regression · (23) sibling create + list ·
 * (24) cross-tenant slug · (26) delete-the-default refusal · (27) platform-tier
 * refusal. (25) — an API key is 403 on this controller — is covered by
 * `task-776-route-authz-matrix.spec.ts` for every route in the manifest and is
 * deliberately NOT hand-written here.
 *
 * (28)-(30) are the G1 review fixes, added after the lanes merged: the DEFAULT
 * slot is RELEASED when its row is deleted (a tombstone used to wedge the whole
 * provider behind an unmapped P2002), a slug may not impersonate another
 * vendor's id or a route segment, and an unsaved connection NAME 404s as a
 * connection rather than as a provider.
 *
 * CLEANUP. Each test that creates a sibling deletes it again, because the suite
 * shares one seeded database with the rest of the e2e run and a stray
 * `openai-research` row would change what the catalogue and the provider list
 * specs see.
 */
import { test, expect, APIRequestContext } from '@playwright/test';
import { DEFAULT_TENANT_KEY, SEEDED_USERS, loginUser } from '../../../../tests/helpers';

const BASE = '/api/v1/admin/providers/llm';
/**
 * TASK-983 R3 runs on STT Sarvam because that is the row the owner reported —
 * and because nothing else in the e2e suite asserts the SYSTEM `stt/sarvam`
 * key state, so bumping its (monotonic, un-restorable) `keyVersion` disturbs
 * no other spec.
 */
const STT_BASE = '/api/v1/admin/providers/stt';
const SYSTEM_TENANT_ID = '00000000-0000-0000-0000-000000000000';
/** The named sibling this suite creates and removes. */
const SIBLING = 'openai-research';

function bearer(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

async function readRow(request: APIRequestContext, token: string, slug: string, tenantId?: string) {
  const qs = tenantId ? `?tenantId=${tenantId}` : '';
  return request.get(`${BASE}/${slug}${qs}`, { headers: bearer(token) });
}

/** Remove a connection this suite created, whatever state the test left it in. */
async function removeIfPresent(request: APIRequestContext, token: string, slug: string): Promise<void> {
  const read = await readRow(request, token, slug);
  if (read.status() !== 200) return;
  const body = (await read.json()) as { version: number };
  if (body.version === 0) return;
  await request.delete(`${BASE}/${slug}`, { headers: bearer(token) });
}

// The tests share ONE mutable sibling slug on the seeded tenant, so they must not
// interleave across workers (`fullyParallel: true`) — same guard as the 33 sibling specs.
test.describe.configure({ mode: 'serial' });

test.describe('TASK-958 — multiple provider connections per tenant', () => {
  let tenantAdminToken: string;
  let superAdminToken: string;
  let foreignTenantId: string;

  test.beforeAll(async ({ request }) => {
    const ta = await loginUser(request, SEEDED_USERS.admin.username, SEEDED_USERS.admin.password, DEFAULT_TENANT_KEY);
    expect(ta, `tenant_admin login (${DEFAULT_TENANT_KEY}) failed`).toBeTruthy();
    tenantAdminToken = ta!.token;

    const sa = await loginUser(request, SEEDED_USERS.superAdmin.username, SEEDED_USERS.superAdmin.password, 'ARCAAI');
    expect(sa, 'super admin login (ARCAAI) failed').toBeTruthy();
    superAdminToken = sa!.token;

    // A tenant that is NOT the one the tenant admin belongs to — read through
    // the super admin, who may address any tier.
    const arcaai = await readRow(request, superAdminToken, 'openai');
    expect(arcaai.status()).toBe(200);
    foreignTenantId = ((await arcaai.json()) as { tenantId: string }).tenantId;
  });

  test.afterEach(async ({ request }) => {
    await removeIfPresent(request, tenantAdminToken, SIBLING);
  });

  /**
   * (22) THE REGRESSION PIN. Every caller that predates this ticket sends the
   * provider id as the path segment and no `provider` in the body. That must
   * still create/update the tenant's DEFAULT connection for that provider — the
   * whole backward-compatibility claim of D-1/D-2 rests on it.
   */
  test('(22) the legacy shape — PUT llm/openai with no `provider` — still writes the DEFAULT row', async ({ request }) => {
    const read = await readRow(request, tenantAdminToken, 'openai');
    expect(read.status()).toBe(200);
    const before = (await read.json()) as { version: number; slug?: string; isDefault?: boolean };
    const etag = read.headers()['etag'] ?? `"${before.version}"`;

    const put = await request.put(`${BASE}/openai`, {
      headers: { ...bearer(tenantAdminToken), 'If-Match': etag },
      data: { enabled: false },
    });
    // 400 stays acceptable where the row's own requirement check refuses the
    // merged body; what must NOT happen is a naming refusal.
    expect([200, 400]).toContain(put.status());
    if (put.status() === 400) {
      const body = (await put.json()) as { code?: string };
      expect(
        ['CONNECTION_SLUG_INVALID', 'CONNECTION_PROVIDER_REQUIRED', 'CONNECTION_MULTIPLICITY_UNSUPPORTED'],
        'the legacy shape must never be refused for NAMING reasons',
      ).not.toContain(body.code);
      return;
    }

    const after = (await put.json()) as { slug: string; provider: string; isDefault: boolean; id: string };
    expect(after.slug).toBe('openai');
    expect(after.provider).toBe('openai');
    expect(after.isDefault).toBe(true);
    expect(after.id).toBeTruthy();
  });

  /**
   * (23) The feature itself: a second account of one vendor, named, listed
   * beside the default with the flag that distinguishes them.
   */
  test('(23) a named sibling is created with `provider`, and the list shows both with the right default', async ({ request }) => {
    const create = await request.put(`${BASE}/${SIBLING}`, {
      headers: { ...bearer(tenantAdminToken), 'If-Match': '"0"' },
      data: { provider: 'openai', name: 'Research account', enabled: false },
    });
    expect(create.status(), await create.text()).toBe(200);

    const created = (await create.json()) as { slug: string; provider: string; name: string | null; isDefault: boolean; id: string };
    expect(created).toMatchObject({ slug: SIBLING, provider: 'openai', name: 'Research account', isDefault: false });
    expect(created.id).toBeTruthy();

    const list = await request.get(BASE, { headers: bearer(tenantAdminToken) });
    expect(list.status()).toBe(200);
    const rows = (await list.json()) as Array<{ slug: string; provider: string; isDefault: boolean }>;
    const openaiGroup = rows.filter((r) => r.provider === 'openai');
    expect(openaiGroup.map((r) => r.slug)).toContain(SIBLING);
    expect(openaiGroup.filter((r) => r.isDefault)).toHaveLength(1);
    // The default leads its own group — the ordering the console renders and the
    // cascade relies on.
    expect(openaiGroup[0]!.isDefault).toBe(true);

    // The key is still never echoed, on the new route shape as on the old.
    expect(await (await readRow(request, tenantAdminToken, SIBLING)).text()).not.toContain('vault:v');
  });

  test('(23b) a slug that names no vendor and carries no `provider` is refused by name', async ({ request }) => {
    const res = await request.put(`${BASE}/not-a-vendor-at-all`, {
      headers: { ...bearer(tenantAdminToken), 'If-Match': '"0"' },
      data: { enabled: false },
    });
    expect(res.status()).toBe(400);
    expect(((await res.json()) as { code?: string }).code).toBe('CONNECTION_PROVIDER_REQUIRED');
  });

  /**
   * (24) The house posture survives the rename: a slug that belongs to another
   * tenant is "not yours", reported as absent — never 403, never that tenant's row.
   */
  test('(24) another tenant’s connection slug is a 404 (or 403 at the scope guard), never data', async ({ request }) => {
    const res = await readRow(request, tenantAdminToken, 'openai', foreignTenantId);
    expect([403, 404]).toContain(res.status());
  });

  /** (26) OQ-6 — the default is never silently promoted away from. */
  test('(26) deleting the DEFAULT while a sibling lives → 409 CONNECTION_IS_DEFAULT', async ({ request }) => {
    const create = await request.put(`${BASE}/${SIBLING}`, {
      headers: { ...bearer(tenantAdminToken), 'If-Match': '"0"' },
      data: { provider: 'openai', enabled: false },
    });
    expect(create.status(), await create.text()).toBe(200);

    const del = await request.delete(`${BASE}/openai`, { headers: bearer(tenantAdminToken) });
    expect(del.status()).toBe(409);
    const body = (await del.json()) as { code?: string; siblingSlugs?: string[] };
    expect(body.code).toBe('CONNECTION_IS_DEFAULT');
    expect(body.siblingSlugs).toContain(SIBLING);

    // …and the sibling deletes cleanly, which is the remedy the error names.
    const delSibling = await request.delete(`${BASE}/${SIBLING}`, { headers: bearer(tenantAdminToken) });
    expect(delSibling.status()).toBe(200);
  });

  /**
   * (28) TASK-958/G1 F1 (correctness review #1) — the DEFAULT survives its own
   * deletion as a RELEASED slot, not as a wedge.
   *
   * The tombstone used to keep `defaultForProvider = provider`, and the unique
   * index behind it counts deleted rows, so after deleting a provider's only
   * connection EVERY new slug for that provider died on an unmapped P2002. The
   * probe runs on `anthropic` rather than `openai` so no other spec's row is
   * touched: it creates what it deletes, and deletes what it creates.
   */
  test('(28) after deleting a provider’s only connection, a NEW slug for it creates and becomes the default', async ({ request }) => {
    const create = await request.put(`${BASE}/anthropic`, {
      headers: { ...bearer(tenantAdminToken), 'If-Match': '"0"' },
      data: { enabled: false },
    });
    expect(create.status(), await create.text()).toBe(200);
    expect((await create.json()) as { isDefault: boolean }).toMatchObject({ isDefault: true });

    const del = await request.delete(`${BASE}/anthropic`, { headers: bearer(tenantAdminToken) });
    expect(del.status(), 'the only connection of a provider deletes without a sibling to block it').toBe(200);

    const reborn = await request.put(`${BASE}/anthropic-research`, {
      headers: { ...bearer(tenantAdminToken), 'If-Match': '"0"' },
      data: { provider: 'anthropic', name: 'Research account', enabled: false },
    });
    expect(reborn.status(), await reborn.text()).toBe(200);
    expect((await reborn.json()) as { slug: string; provider: string; isDefault: boolean }).toMatchObject({
      slug: 'anthropic-research',
      provider: 'anthropic',
      isDefault: true,
    });

    // Leave the tenant as we found it (tombstones only — the shared seeded DB).
    const cleanup = await request.delete(`${BASE}/anthropic-research`, { headers: bearer(tenantAdminToken) });
    expect(cleanup.status()).toBe(200);
  });

  /**
   * (29) TASK-958/G1 F2 (security review, HIGH) — a connection may not be NAMED
   * after a vendor it does not serve. The slug travels to the Python services as
   * `connection_key`, so `PUT llm/sarvam {provider:'openai'}` would mint a row
   * that stands in for the platform `sarvam` credential on the wire.
   */
  test('(29) a slug that impersonates another provider’s id → 400 CONNECTION_SLUG_RESERVED', async ({ request }) => {
    const res = await request.put(`${BASE}/sarvam`, {
      headers: { ...bearer(tenantAdminToken), 'If-Match': '"0"' },
      data: { provider: 'openai', enabled: false },
    });
    expect(res.status()).toBe(400);
    const body = (await res.json()) as { code?: string; reason?: string };
    expect(body.code).toBe('CONNECTION_SLUG_RESERVED');
    expect(body.reason).toBe('provider-id');
  });

  test('(29b) `platform-defaults` is a route segment, not a connection name → 400 CONNECTION_SLUG_RESERVED', async ({ request }) => {
    const res = await request.put(`${BASE}/platform-defaults`, {
      headers: { ...bearer(tenantAdminToken), 'If-Match': '"0"' },
      data: { provider: 'openai', enabled: false },
    });
    expect(res.status()).toBe(400);
    const body = (await res.json()) as { code?: string; reason?: string };
    expect(body.code).toBe('CONNECTION_SLUG_RESERVED');
    expect(body.reason).toBe('route-segment');
  });

  /**
   * (30) TASK-958/G1 F4 (correctness review #7) — reading a connection NAME
   * nobody saved is still a 404, but it says so in terms of the connection. The
   * old message called the slug a provider and sent operators (and the console)
   * looking for a vendor that does not exist.
   */
  test('(30) reading an unsaved sibling slug 404s about the CONNECTION, not about a provider', async ({ request }) => {
    const res = await readRow(request, tenantAdminToken, 'openai-not-saved-at-all');
    expect(res.status()).toBe(404);
    const message = JSON.stringify(await res.json());
    expect(message).toContain('connection');
    expect(message, 'the slug is not a provider and must not be described as one').not.toContain("provider 'openai-not-saved-at-all'");
  });

  /**
   * (31) TASK-983 R3 — a TENANT row does not lock the PLATFORM row of the same
   * provider.
   *
   * The owner reported being unable to change the platform Sarvam key once a
   * tenant admin had configured one for their tenant. Every layer traced clean
   * (`crossTenantLane` writes SYSTEM through the unscoped client, both unique
   * indexes include `tenantId`, `assertWriteAllowed` is role-only) and no test
   * covered this INTERLEAVING, which is why the claim could only be argued
   * about. Now it is pinned: tenant writes first, the platform write still
   * succeeds and bumps its own `keyVersion`, and the tenant's row is not
   * touched by it.
   *
   * Both writes keep `enabled: false` — a disabled row is exempt from
   * `PROVIDER_REQUIREMENTS` (the veto must stay expressible), and a key written
   * to a disabled row still rotates `keyVersion`, which is the half this case
   * is about.
   */
  test('(31) a tenant Sarvam key does not block the platform Sarvam key — and the platform write leaves the tenant row alone', async ({
    request,
  }) => {
    const readSarvam = (token: string, tenantId?: string) =>
      request.get(`${STT_BASE}/sarvam${tenantId ? `?tenantId=${tenantId}` : ''}`, { headers: bearer(token) });

    // 1. The tenant configures its own row — the state the owner was in.
    const tenantBefore = await readSarvam(tenantAdminToken);
    expect(tenantBefore.status()).toBe(200);
    const tenantPrior = (await tenantBefore.json()) as { version: number; keyVersion: number | null };
    const tenantWrite = await request.put(`${STT_BASE}/sarvam`, {
      headers: { ...bearer(tenantAdminToken), 'If-Match': tenantBefore.headers()['etag'] ?? `"${tenantPrior.version}"` },
      data: { apiKey: 'tenant-sarvam-key-task983', baseUrl: 'https://tenant.enterprise.sarvam.example', enabled: false },
    });
    expect(tenantWrite.status(), await tenantWrite.text()).toBe(200);
    const tenantRow = (await tenantWrite.json()) as { version: number; keyVersion: number | null; hasKey: boolean; tenantId: string };
    expect(tenantRow.hasKey).toBe(true);
    expect(tenantRow.tenantId).not.toBe(SYSTEM_TENANT_ID);

    // 2. The platform admin now rotates the SYSTEM key for the SAME provider.
    const systemBefore = await readSarvam(superAdminToken, SYSTEM_TENANT_ID);
    expect(systemBefore.status()).toBe(200);
    const systemPrior = (await systemBefore.json()) as { version: number; keyVersion: number | null };
    const systemWrite = await request.put(`${STT_BASE}/sarvam?tenantId=${SYSTEM_TENANT_ID}`, {
      headers: { ...bearer(superAdminToken), 'If-Match': systemBefore.headers()['etag'] ?? `"${systemPrior.version}"` },
      data: { apiKey: 'platform-sarvam-key-task983', baseUrl: 'https://platform.enterprise.sarvam.example', enabled: false },
    });
    expect(systemWrite.status(), await systemWrite.text()).toBe(200);
    const systemRow = (await systemWrite.json()) as { tenantId: string; keyVersion: number | null; hasKey: boolean };
    expect(systemRow.tenantId).toBe(SYSTEM_TENANT_ID);
    expect(systemRow.hasKey).toBe(true);
    expect(systemRow.keyVersion ?? 0, 'the platform key did not rotate').toBeGreaterThan(systemPrior.keyVersion ?? 0);

    // 3. …and the tenant's own row is exactly as the tenant left it.
    const tenantAfter = await readSarvam(tenantAdminToken);
    expect(tenantAfter.status()).toBe(200);
    const tenantFinal = (await tenantAfter.json()) as { version: number; keyVersion: number | null; baseUrl: string | null; hasKey: boolean };
    expect(tenantFinal.version).toBe(tenantRow.version);
    expect(tenantFinal.keyVersion).toBe(tenantRow.keyVersion);
    expect(tenantFinal.baseUrl).toBe('https://tenant.enterprise.sarvam.example');
    expect(tenantFinal.hasKey).toBe(true);

    // CLEANUP: the tenant row is this test's own creation when the seed had
    // none. The SYSTEM row is seeded and stays — `keyVersion` is monotonic and
    // there is nothing to restore, which is why this runs on a provider no
    // other spec reads.
    if ((tenantPrior.version ?? 0) === 0) {
      await request.delete(`${STT_BASE}/sarvam`, { headers: bearer(tenantAdminToken) });
    }
  });

  /** (27) D-9 — the platform tier is one row per provider, named after it. */
  test('(27) a super admin cannot create a named sibling on the platform tier → 400', async ({ request }) => {
    const res = await request.put(`${BASE}/${SIBLING}?tenantId=${SYSTEM_TENANT_ID}`, {
      headers: { ...bearer(superAdminToken), 'If-Match': '"0"' },
      data: { provider: 'openai', enabled: false },
    });
    expect(res.status()).toBe(400);
    expect(((await res.json()) as { code?: string }).code).toBe('PLATFORM_CONNECTION_PER_PROVIDER');
  });

  test('(27b) the platform default cannot be demoted either', async ({ request }) => {
    const read = await readRow(request, superAdminToken, 'openai', SYSTEM_TENANT_ID);
    expect(read.status()).toBe(200);
    const etag = read.headers()['etag'] ?? `"${((await read.json()) as { version: number }).version}"`;

    const res = await request.put(`${BASE}/openai?tenantId=${SYSTEM_TENANT_ID}`, {
      headers: { ...bearer(superAdminToken), 'If-Match': etag },
      data: { isDefault: false },
    });
    expect(res.status()).toBe(400);
    expect(((await res.json()) as { code?: string }).code).toBe('PLATFORM_CONNECTION_PER_PROVIDER');
  });
});
