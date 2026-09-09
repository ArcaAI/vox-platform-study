/**
 * TASK-932 R-1 / R-6 — settings visibility and the platform-admin write path.
 *
 * DEPTH the route-authz matrix cannot express. The matrix knows a route's
 * declared ability; it cannot know that the SAME route answers 200 for one
 * caller and 404 for another because of a DESCRIPTOR's `maxScope` and
 * `globalOnly` — nor that `?scope=system` addresses a row that needs no tenant
 * at all.
 *
 * Two contracts are pinned here:
 *
 *  1. A tenant administrator sees ONLY the keys its own tenant can hold an
 *     opinion on. Everything else is 404 on every key-addressed route, so the
 *     lane cannot be walked as a directory of the platform's configuration by
 *     someone who can read the key names out of the source tree.
 *  2. A platform administrator with NO working tenant can read and write the
 *     platform row. That was the reported defect: the read resolved through
 *     `resolveScopedTenantId`, which demands `?tenantId=` for a super admin, so
 *     `GET registry/:key?scope=system` answered 400 — the drawer could not load,
 *     and therefore nothing could be saved.
 */
import { test, expect, type APIRequestContext } from '@playwright/test';
import { DEFAULT_TENANT_KEY, SEEDED_USERS, loginUser } from '../../../../tests/helpers';

const SETTINGS = '/api/v1/admin/settings';

/** `global-kv`, NOT `globalOnly`, `maxScope: 'tenant'` — a tenant may hold an opinion. */
const TENANT_VISIBLE_KEY = 'rateLimit.maxRequests';
/** `globalOnly` with a tenant-deep maxScope — the PLATFORM decides it. */
const PLATFORM_KEY = 'console.mlflow.enabled';
/** `maxScope: 'system'` — no tenant row could ever exist. */
const SYSTEM_ONLY_KEY = 'consultation.ocr.enabled';
/** `env` tier — locked for EVERY caller, super administrators included. */
const LOCKED_KEY = 'databaseUrl';

/** The reserved platform-configuration tier. Never a customer tenant. */
const SYSTEM_TENANT_ID = '00000000-0000-0000-0000-000000000000';
/** `enable-local-raw-capture` — a seeded, LOCKED, SYSTEM-tenant `GlobalSetting` ROW (seed 11). */
const SYSTEM_ROW_ID = '00000000-0000-0000-0002-000000000001';

async function tenantAdminToken(request: APIRequestContext): Promise<string> {
  const login = await loginUser(request, SEEDED_USERS.admin.username, SEEDED_USERS.admin.password, DEFAULT_TENANT_KEY);
  expect(login, 'the seeded tenant admin must log in').not.toBeNull();
  return login!.token;
}

/** The tenant admin's token AND the tenant it is bound to — the list assertions need both. */
async function tenantAdminSession(request: APIRequestContext): Promise<{ token: string; tenantId: string }> {
  const login = await loginUser(request, SEEDED_USERS.admin.username, SEEDED_USERS.admin.password, DEFAULT_TENANT_KEY);
  expect(login, 'the seeded tenant admin must log in').not.toBeNull();
  return { token: login!.token, tenantId: login!.user.tenantId };
}

async function superAdminToken(request: APIRequestContext): Promise<string> {
  const login = await loginUser(request, SEEDED_USERS.superAdmin.username, SEEDED_USERS.superAdmin.password);
  expect(login, 'the seeded super admin must log in').not.toBeNull();
  return login!.token;
}

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

test.describe('TASK-932 R-1 — a tenant admin sees only its own tenant surface', () => {
  test('the catalog carries no globalOnly and no system-scoped descriptor', async ({ request }) => {
    const response = await request.get(`${SETTINGS}/catalog`, { headers: auth(await tenantAdminToken(request)) });
    expect(response.status()).toBe(200);
    const body = (await response.json()) as { items: Array<{ key: string; globalOnly?: boolean; maxScope: string }>; categories: string[] };

    expect(body.items.length).toBeGreaterThan(0);
    expect(body.items.filter((i) => i.globalOnly)).toEqual([]);
    expect(body.items.filter((i) => i.maxScope === 'system')).toEqual([]);

    // The families that used to leak wholesale.
    for (const category of ['Bootstrap', 'Credentials', 'Service Runtime', 'Feature Availability']) {
      expect(body.categories, `${category} must not reach a tenant admin`).not.toContain(category);
    }
    expect(body.items.some((i) => i.key === TENANT_VISIBLE_KEY)).toBe(true);
  });

  test('every key-addressed route answers 404 for a platform-only key', async ({ request }) => {
    const headers = auth(await tenantAdminToken(request));

    for (const key of [PLATFORM_KEY, SYSTEM_ONLY_KEY]) {
      expect((await request.get(`${SETTINGS}/registry/${key}`, { headers })).status(), `GET registry/${key}`).toBe(404);
      expect((await request.get(`${SETTINGS}/effective?key=${key}`, { headers })).status(), `GET effective ${key}`).toBe(404);
      expect((await request.put(`${SETTINGS}/registry/${key}`, { headers, data: { value: true } })).status(), `PUT ${key}`).toBe(404);
      expect((await request.delete(`${SETTINGS}/registry/${key}?scope=tenant`, { headers })).status(), `DELETE ${key}`).toBe(404);
    }
  });

  test('an unknown key and a hidden key are indistinguishable', async ({ request }) => {
    // The whole point of 404-over-403 here: an admin who can enumerate the
    // registry from the source tree must not be able to confirm a key's
    // existence one request at a time.
    const headers = auth(await tenantAdminToken(request));
    const unknown = await request.get(`${SETTINGS}/registry/task-932.no.such.key`, { headers });
    const hidden = await request.get(`${SETTINGS}/registry/${PLATFORM_KEY}`, { headers });
    expect(unknown.status()).toBe(404);
    expect(hidden.status()).toBe(404);
  });

  test('a tenant-visible key is still fully reachable', async ({ request }) => {
    const headers = auth(await tenantAdminToken(request));
    const response = await request.get(`${SETTINGS}/registry/${TENANT_VISIBLE_KEY}?scope=tenant`, { headers });
    expect(response.status()).toBe(200);
    expect((await response.json()).key).toBe(TENANT_VISIBLE_KEY);
  });

  test('a super admin still sees everything', async ({ request }) => {
    const headers = auth(await superAdminToken(request));
    const catalog = await request.get(`${SETTINGS}/catalog`, { headers });
    const body = (await catalog.json()) as { items: Array<{ key: string }>; categories: string[] };

    expect(body.categories).toContain('Bootstrap');
    expect(body.categories).toContain('Feature Availability');
    for (const key of [PLATFORM_KEY, SYSTEM_ONLY_KEY, LOCKED_KEY]) {
      expect(
        body.items.some((i) => i.key === key),
        key,
      ).toBe(true);
    }
  });
});

test.describe('TASK-932 R-6 — the platform admin can actually write', () => {
  test('scope=system resolves the platform row with NO working tenant and NO ?tenantId', async ({ request }) => {
    // The reported defect answered 400 here ("Platform admins must pass
    // ?tenantId= to scope this request"), which is why the drawer never loaded.
    const headers = auth(await superAdminToken(request));
    const response = await request.get(`${SETTINGS}/registry/${TENANT_VISIBLE_KEY}?scope=system`, { headers });

    expect(response.status()).toBe(200);
    const body = await response.json();
    expect(body.key).toBe(TENANT_VISIBLE_KEY);
    expect(['system', 'code-default']).toContain(body.sourceScope);
  });

  test('an unscoped read with no scope at all resolves SYSTEM rather than 400', async ({ request }) => {
    const headers = auth(await superAdminToken(request));
    expect((await request.get(`${SETTINGS}/effective?key=${TENANT_VISIBLE_KEY}`, { headers })).status()).toBe(200);
  });

  test('reads the platform row, writes it, and reads the new value back', async ({ request }) => {
    const headers = auth(await superAdminToken(request));
    const path = `${SETTINGS}/registry/${TENANT_VISIBLE_KEY}`;

    const before = await request.get(`${path}?scope=system`, { headers });
    expect(before.status()).toBe(200);
    const current = (await before.json()) as { value: unknown; version?: number };
    const next = Number(current.value) === 4242 ? 4243 : 4242;

    // The ETag is the version of the row the write will target — the read and
    // the write must be talking about the SAME row, which is the half that was
    // broken.
    const etag = before.headers()['etag'];
    const write = await request.put(path, {
      headers: { ...headers, ...(etag ? { 'If-Match': etag } : {}) },
      data: { value: next, scope: 'system' },
    });
    expect(write.status(), await write.text()).toBe(200);
    expect((await write.json()).scope).toBe('system');

    const after = await request.get(`${path}?scope=system`, { headers });
    expect(Number((await after.json()).value)).toBe(next);

    // Restore, so a re-run and the console specs see the seeded value.
    const restoreEtag = after.headers()['etag'];
    await request.put(path, {
      headers: { ...headers, ...(restoreEtag ? { 'If-Match': restoreEtag } : {}) },
      data: { value: current.value, scope: 'system' },
    });
  });

  test('a stale If-Match is refused 412 rather than clobbering the row', async ({ request }) => {
    const headers = auth(await superAdminToken(request));
    const path = `${SETTINGS}/registry/${TENANT_VISIBLE_KEY}`;
    const read = await request.get(`${path}?scope=system`, { headers });
    const version = (await read.json()).version ?? 0;

    const response = await request.put(path, {
      headers: { ...headers, 'If-Match': `"${version + 99}"` },
      data: { value: 7777, scope: 'system' },
    });
    expect(response.status()).toBe(412);
  });
});

test.describe('TASK-932 R-6 / D-6 — locked tiers are locked for everyone', () => {
  test('the catalog marks a bootstrap key locked, with a reason', async ({ request }) => {
    const headers = auth(await superAdminToken(request));
    const catalog = await request.get(`${SETTINGS}/catalog`, { headers });
    const items = ((await catalog.json()) as { items: Array<{ key: string; tier: string; locked?: boolean; lockReason?: string }> }).items;

    const locked = items.find((i) => i.key === LOCKED_KEY);
    expect(locked?.locked).toBe(true);
    expect(locked?.lockReason).toBeTruthy();
    // Derived, not listed: EVERY env-tier key is locked, not just the ones
    // someone remembered to enumerate.
    expect(items.filter((i) => i.tier === 'env').every((i) => i.locked === true)).toBe(true);
    // ...and a writable key is NOT marked, or the badge would mean nothing.
    expect(items.find((i) => i.key === TENANT_VISIBLE_KEY)?.locked).toBeUndefined();
  });

  test('a SUPER ADMIN is refused a bootstrap write, and told where it changes', async ({ request }) => {
    const response = await request.put(`${SETTINGS}/registry/${LOCKED_KEY}`, {
      headers: auth(await superAdminToken(request)),
      data: { value: 'postgres://nope', scope: 'system' },
    });
    expect(response.status()).toBe(400);
    const body = await response.text();
    expect(body).toContain('SETTING_TIER_LOCKED');
    expect(body).toMatch(/redeploy/i);
  });
});

test.describe('TASK-932 — reset restores inheritance', () => {
  test('a tenant override is written, then removed, and the key inherits again', async ({ request }) => {
    // The full round trip, because the interesting part is the STATE AFTER: the
    // key must resolve from the platform tier again, not from a copy of it.
    const superHeaders = auth(await superAdminToken(request));
    const tenantHeaders = auth(await tenantAdminToken(request));
    const path = `${SETTINGS}/registry/${TENANT_VISIBLE_KEY}`;

    const before = await request.get(`${path}?scope=tenant`, { headers: tenantHeaders });
    expect(before.status()).toBe(200);
    const beforeEtag = before.headers()['etag'];

    const write = await request.put(path, {
      headers: { ...tenantHeaders, ...(beforeEtag ? { 'If-Match': beforeEtag } : {}) },
      data: { value: 4321, scope: 'tenant' },
    });
    expect(write.status(), await write.text()).toBe(200);

    const overridden = await request.get(`${path}?scope=tenant`, { headers: tenantHeaders });
    expect((await overridden.json()).sourceScope).toBe('tenant');

    const reset = await request.delete(`${path}?scope=tenant`, { headers: tenantHeaders });
    expect(reset.status(), await reset.text()).toBe(200);
    expect((await reset.json()).removed).toBe(true);

    const after = await request.get(`${path}?scope=tenant`, { headers: tenantHeaders });
    expect((await after.json()).sourceScope, 'the tenant must inherit again, not hold a copy').not.toBe('tenant');

    // Idempotent: a "reset every tenant" sweep must not fail on the ones that
    // never had an override.
    const again = await request.delete(`${path}?scope=tenant`, { headers: tenantHeaders });
    expect(again.status()).toBe(200);
    expect((await again.json()).removed).toBe(false);

    // The platform row is untouched by any of it.
    expect((await request.get(`${path}?scope=system`, { headers: superHeaders })).status()).toBe(200);
  });

  test('scope=system is refused: the platform row is the top of the cascade', async ({ request }) => {
    const response = await request.delete(`${SETTINGS}/registry/${TENANT_VISIBLE_KEY}?scope=system`, {
      headers: auth(await superAdminToken(request)),
    });
    expect(response.status()).toBe(400);
    expect(await response.text()).toMatch(/nothing above it to inherit/i);
  });
});

/**
 * TASK-932 R-1 / D-5 — the LEGACY row surface, not the registry.
 *
 * The catalog above is a list of DESCRIPTORS; `admin/settings` is a list of
 * ROWS, and it is served by a different service. `GlobalSetting` is a member of
 * `SYSTEM_SHARED_READ_MODELS`, so a read that names no tenant is widened to
 * `tenantId IN [caller, SYSTEM]` — right for a resolver inheriting a default on
 * absence, wrong for a directory of the platform's own configuration. These
 * cases pin the row surface to the same rule the descriptor surface already
 * obeys, so hiding a key in one place cannot be undone by reading its row in
 * the other.
 *
 * TASK-932 OD-3 (owner decision, 2026-09-09) — the by-id answer on a PLATFORM
 * row is 403, the same as the WRITE lane's (TASK-890 OD-P). It was 404 until
 * this ticket; the reversal is argued in full on the test below.
 *
 * That does NOT harmonise with the descriptor cases higher up this file, and it
 * must not be "fixed" into doing so. They are two different resources:
 *   - `GET registry/:key` is 404 for a platform-only key because the key is not
 *     in that caller's CATALOG at all — the same answer as a key that does not
 *     exist, because for that caller there is no such setting;
 *   - `GET :id` is 403 on a platform ROW because the row plainly exists, is
 *     named in the registry the caller can read, and is simply not theirs to
 *     see. There is nothing left to hide, and only a rule to state.
 */
test.describe('TASK-932 R-1 — the legacy settings ROW list is tenant-pinned', () => {
  test('the legacy row list carries no SYSTEM rows for a tenant admin', async ({ request }) => {
    const admin = await tenantAdminSession(request);
    const response = await request.get(`${SETTINGS}?limit=200`, { headers: auth(admin.token) });
    expect(response.status()).toBe(200);

    const body = (await response.json()) as { data: Array<{ id: string; key: string; namespace?: string | null; tenantId?: string | null }> };
    expect(body.data.length, 'the tenant must still see its own rows').toBeGreaterThan(0);

    for (const item of body.data) {
      expect(item.tenantId, `${item.key} (${item.id}) must belong to the caller's own tenant`).toBe(admin.tenantId);
      expect(item.tenantId).not.toBe(SYSTEM_TENANT_ID);
    }
    // The platform-only registry keys by name, so the assertion still bites if
    // the row shape ever stops carrying `tenantId`. A tenant's OWN
    // `namespace: 'registry'` rows are legitimate (they are its overrides), so
    // the namespace alone is not the test — these KEYS are.
    for (const platformKey of [PLATFORM_KEY, SYSTEM_ONLY_KEY, LOCKED_KEY]) {
      expect(
        body.data.some((i) => i.key === platformKey),
        `${platformKey} is platform configuration and must not reach a tenant admin`,
      ).toBe(false);
    }
  });

  test('a SYSTEM row by id is 403 for a tenant admin and 200 for a super admin (OD-3)', async ({ request }) => {
    const admin = await tenantAdminSession(request);
    const hidden = await request.get(`${SETTINGS}/${SYSTEM_ROW_ID}`, { headers: auth(admin.token) });
    expect(hidden.status(), 'the platform tier is a PRIVILEGE boundary on reads as well as writes').toBe(403);

    // Same request, elevated: the row exists, so the 403 above is a privilege
    // rule and not a broken fixture.
    const visible = await request.get(`${SETTINGS}/${SYSTEM_ROW_ID}`, { headers: auth(await superAdminToken(request)) });
    expect(visible.status()).toBe(200);
    expect((await visible.json()).tenantId).toBe(SYSTEM_TENANT_ID);
  });

  /**
   * TASK-932 OD-3 — the explicit OPPOSITE of what this file asserted before.
   *
   * The original test demanded that a SYSTEM id and an unknown id be
   * byte-identical, on the reasoning that a distinguishable 403 lets a caller
   * confirm rows one request at a time. The owner's call reverses it, and the
   * reason it is safe to reverse is visible in the assertion itself: the
   * platform tier has no existence to protect. Its keys are declared in the
   * settings registry, shipped in the source tree and rendered BY NAME in the
   * catalog — a tenant admin learns nothing from a 403 that `HOPE_SETTINGS_REGISTRY`
   * does not already tell them. What the 404 cost was real: the same row
   * answered 403 to PATCH/DELETE and 404 to GET, so the platform tier was
   * documented as two rules depending on the verb.
   *
   * The oracle that DOES matter is still closed, and this test is what pins it:
   * an id naming no row at all stays a 404, because existence is resolved
   * before privilege at every call site.
   */
  test('a SYSTEM id and an unknown id are DISTINGUISHABLE: 403 vs 404 (OD-3)', async ({ request }) => {
    const admin = await tenantAdminSession(request);
    const unknown = await request.get(`${SETTINGS}/00000000-0000-0000-0009-999999999999`, { headers: auth(admin.token) });
    const system = await request.get(`${SETTINGS}/${SYSTEM_ROW_ID}`, { headers: auth(admin.token) });

    expect(unknown.status(), 'an id that names no row is still a 404 — the 403 must not become an existence oracle').toBe(404);
    expect(system.status(), 'a real platform row is a privilege refusal').toBe(403);
  });

  test('the by-tenant list is 403 for the SYSTEM tenant and 200 for the caller own (OD-3)', async ({ request }) => {
    // `where: { tenantId: SYSTEM }` is ACCEPTED by the shared-read merge (SYSTEM
    // is half the pair it allows), so this route was the whole platform tier
    // behind one path parameter. Another CUSTOMER tenant stays a 404 — that
    // existence IS a secret — which is pinned in the service unit tests where a
    // second tenant id can be named without depending on the seed.
    const admin = await tenantAdminSession(request);
    expect((await request.get(`${SETTINGS}/tenant/${SYSTEM_TENANT_ID}`, { headers: auth(admin.token) })).status()).toBe(403);
    expect((await request.get(`${SETTINGS}/tenant/${admin.tenantId}`, { headers: auth(admin.token) })).status()).toBe(200);
  });

  test('a super admin still lists the SYSTEM tenant rows', async ({ request }) => {
    const response = await request.get(`${SETTINGS}/tenant/${SYSTEM_TENANT_ID}?limit=200`, { headers: auth(await superAdminToken(request)) });
    expect(response.status()).toBe(200);
    const body = (await response.json()) as { data: Array<{ tenantId?: string | null }> };
    expect(body.data.length).toBeGreaterThan(0);
    for (const item of body.data) expect(item.tenantId).toBe(SYSTEM_TENANT_ID);
  });
});

/**
 * TASK-932 — the write lane ADOPTS a seeded row instead of duplicating its key.
 *
 * Reproduced live on the dev stack (2026-09-09, super admin, no working
 * tenant): `rate-limit.enabled` is seeded as a SYSTEM row under the
 * `rate-limit` namespace (`seed/12-rate-limit-settings.ts`), the write lane
 * looked its backing row up under `registry` only, and so
 *
 *   - `GET …?scope=system` answered `version: 0` with the row plainly there
 *     (no ETag to echo), and
 *   - the PUT CREATED a second SYSTEM row for the same key, after which
 *     `AppSettingsService` refused to build its cache at all — *"duplicate
 *     platform key(s) detected — rate-limit.enabled (2 rows). Refuse to
 *     start."* — and every 45s refresh failed until the row was deleted by hand.
 *
 * `AppSettingsService` keys the platform snapshot by `key` alone, so the
 * invariant is ONE row per `(tenantId, key)` — which is what the last assertion
 * here counts. The spec restores `true` so the stack is left as it was found,
 * with rate limiting ON.
 */
// A NUMERIC seeded key in the `rate-limit` namespace: toggling it by one is harmless to a
// parallel suite, unlike `rate-limit.enabled`, which switches the login throttle for everyone.
const SEEDED_ELSEWHERE_KEY = 'rate-limit.tier.relaxed.limit';

test.describe('TASK-932 — a platform row seeded under another namespace is adopted, not duplicated', () => {
  test('the seeded version is reported, the write lands on THAT row, and one SYSTEM row remains', async ({ request }) => {
    const headers = auth(await superAdminToken(request));
    const path = `${SETTINGS}/registry/${SEEDED_ELSEWHERE_KEY}`;

    // No `X-Tenant-Id` anywhere in this test: a platform admin edits the
    // platform row from an unscoped session.
    const before = await request.get(`${path}?scope=system`, { headers });
    expect(before.status(), await before.text()).toBe(200);
    const seeded = (await before.json()) as { value: unknown; version: number };
    expect(seeded.version, 'the seeded SYSTEM row must be visible to the lane, whatever namespace it lives in').toBeGreaterThanOrEqual(1);
    const etag = before.headers()['etag'];
    expect(etag, 'a stored row must render an ETag for the client to echo').toBeTruthy();

    // Toggle RELATIVE to whatever the stack holds: a same-value write is a
    // no-op 400 by design, and this test is about adoption, not the value.
    const flipped = Number(seeded.value) + 1;
    const write = await request.put(path, { headers: { ...headers, 'If-Match': etag! }, data: { value: flipped, scope: 'system' } });
    expect(write.status(), await write.text()).toBe(200);
    const written = (await write.json()) as { value: unknown; version: number };
    expect(written.value).toBe(flipped);
    expect(written.version).toBe(seeded.version + 1);

    // THE ASSERTION THE DEFECT WOULD FAIL: one row, not two.
    const rows = await request.get(`${SETTINGS}/tenant/${SYSTEM_TENANT_ID}?search=${SEEDED_ELSEWHERE_KEY}&limit=100`, { headers });
    expect(rows.status(), await rows.text()).toBe(200);
    const listed = (await rows.json()) as { data: Array<{ key: string; namespace?: string; tenantId?: string | null }> };
    const forKey = listed.data.filter((item) => item.key === SEEDED_ELSEWHERE_KEY);
    expect(forKey, `exactly one SYSTEM row may exist for '${SEEDED_ELSEWHERE_KEY}'`).toHaveLength(1);
    expect(forKey[0]!.namespace, 'the adopted row keeps its own namespace — nothing is migrated').toBe('rate-limit');

    // Leave the stack as we found it (whatever the value was before this test).
    const restore = await request.put(path, {
      headers: { ...headers, 'If-Match': `"${written.version}"` },
      data: { value: Number(seeded.value), scope: 'system' },
    });
    expect(restore.status(), await restore.text()).toBe(200);
    expect((await restore.json()).value).toBe(Number(seeded.value));
  });
});
