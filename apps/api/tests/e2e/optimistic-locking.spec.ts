/**
 * Optimistic-locking e2e.
 *
 * Proves that two concurrent PATCHes against `/api/v1/tenant/me/config`
 * carrying the same `expectedVersion` produce a clean winner/loser pair:
 * one returns 200 with `version + 1`, the other returns 412 Precondition
 * Failed carrying `currentVersion` so the client can replay against the
 * fresh server state. The final stored value is the winner's value.
 *
 * Concurrency model. We deliberately use two distinct Playwright
 * `APIRequestContext` instances (via `playwright.request.newContext()`)
 * so each PATCH lands on its own connection / cookie jar; `Promise.all`
 * fires them in parallel. The same-context shortcut would have serialised
 * on one HTTP connection and turned this into a sequential test that
 * never exercises the race.
 *
 * The 412 mapping lives in `apps/api/src/interceptors/exception.interceptor.ts`
 * (the OCC branch). The CAS write itself is
 * `Repository.updateWithVersion`, wrapped per-batch in
 * `databaseService.baseClient.$transaction(callback)` by `TenantService.updateTenantConfigs`
 * so a mid-batch conflict rolls back every prior row.
 *
 * Environment. Requires the test API at `process.env.API_URL` (default
 * `http://localhost:8868`) and a seeded test database — see
 * `tests/setup/playwright.global-setup.ts`.
 */
import { test, expect, request as playwrightRequest } from '@playwright/test';
import { createTestDataRegistry, loginSeededUsers, cleanupTestData, type TestDataRegistry } from '../../../../tests/helpers';

// Hit the admin-tenants/configs route with super-admin credentials so we
// can target a specific non-GLOBAL tenant. Picking `/tenant/me/config`
// would require a non-super-admin token bound to a non-GLOBAL tenant —
// the test seed's `tenant_admin` is bound to `__GLOBAL__` and the Phase 0
// guard rightly rejects writes to `__GLOBAL__` from non-super-admins.
const TENANT_KEY = 'ARCAAI';
const PATH = `/api/v1/admin/tenants/configs/${TENANT_KEY}`;

interface ConfigRow {
  id: string;
  key: string;
  value: string;
  version: number;
}

test.describe(`Optimistic locking — PATCH /admin/tenants/configs/${TENANT_KEY} (Stream D Phase C)`, () => {
  // We use the super-admin token because the Phase 0 Item 2 guard rejects
  // non-super-admin writes to the `__GLOBAL__` tenant — and `loginSeededUsers`'s
  // tenant_admin happens to be bound to `__GLOBAL__` in the test seed.
  // Using super-admin is fine for proving OCC semantics; the locked-runtime
  // tests (Phase 0 Item 3) cover the role-based denial path separately.
  let superAdminToken: string;
  const registry: TestDataRegistry = createTestDataRegistry();

  test.beforeAll(async ({ request }) => {
    const { superAdminToken: token } = await loginSeededUsers(request);
    expect(token, 'super_admin login failed — check seeded users + auth endpoint').toBeTruthy();
    superAdminToken = token!;
  });

  test.afterAll(async ({ request }) => {
    if (superAdminToken) {
      const { errors } = await cleanupTestData(request, superAdminToken, registry);
      if (errors.length > 0) {
        console.warn('optimistic-locking cleanup errors:', errors);
      }
    }
  });

  test('two concurrent PATCHes with the same expectedVersion: one 200, one 412', async ({ request, playwright }) => {
    // 1. Read the current config — we'll pick a non-locked editable row.
    const getRes = await request.get(PATH, {
      headers: { Authorization: `Bearer ${superAdminToken}` },
    });
    expect(getRes.status(), 'tenant_admin must be able to read /tenant/me/config').toBe(200);
    const body = (await getRes.json()) as { data: ConfigRow[] };

    // Prefer a known-editable, non-locked setting; fall back to any row
    // exposing a numeric `version`. The whole point of OCC is that
    // every row carries `version`, but we add the guard to avoid a
    // spurious test failure if the seed evolves.
    const editable =
      body.data.find((c) => typeof c.version === 'number' && (c.key === 'default-language' || c.key === 'enable-real-time-transcription')) ??
      body.data.find((c) => typeof c.version === 'number');

    expect(
      editable,
      'no editable tenant setting with a numeric `version` is available — the response is missing the Phase C `version` field',
    ).toBeTruthy();
    if (!editable) return; // type-narrow
    const expectedVersion = editable.version;

    // 2. Two PATCHes in parallel against the same expectedVersion, each
    //    on its own APIRequestContext to guarantee distinct connections.
    const ctxA = await playwright.request.newContext({ extraHTTPHeaders: { Authorization: `Bearer ${superAdminToken}` } });
    const ctxB = await playwright.request.newContext({ extraHTTPHeaders: { Authorization: `Bearer ${superAdminToken}` } });
    try {
      const [resA, resB] = await Promise.all([
        ctxA.patch(PATH, { data: [{ id: editable.id, value: 'A', expectedVersion }] }),
        ctxB.patch(PATH, { data: [{ id: editable.id, value: 'B', expectedVersion }] }),
      ]);

      const statuses = [resA.status(), resB.status()].sort((x, y) => x - y);
      expect(statuses, 'expected exactly one winner (200) and one loser (412)').toEqual([200, 412]);

      // 3. The 412 carries OCC metadata so the client can replay.
      const failed = resA.status() === 412 ? resA : resB;
      const failedBody = (await failed.json()) as {
        code: string;
        metadata?: { expectedVersion: number; currentVersion: number };
      };
      expect(failedBody.code).toBe('PERSISTENCE.CONCURRENCY_CONFLICT');
      expect(failedBody.metadata?.expectedVersion).toBe(expectedVersion);
      // The winner bumped `_version` by exactly one — the loser's
      // `currentVersion` therefore must equal `expectedVersion + 1`.
      expect(failedBody.metadata?.currentVersion).toBe(expectedVersion + 1);

      // 4. The winning PATCH's value is what's stored.
      const winningValue = resA.status() === 200 ? 'A' : 'B';
      const verify = await request.get(PATH, {
        headers: { Authorization: `Bearer ${superAdminToken}` },
      });
      expect(verify.status()).toBe(200);
      const after = ((await verify.json()) as { data: ConfigRow[] }).data.find((c) => c.id === editable.id);
      expect(after, 'row vanished mid-test').toBeTruthy();
      expect(after?.value).toBe(winningValue);
      expect(after?.version).toBe(expectedVersion + 1);

      // 5. Restore the row so the test is repeatable (no destructive SQL).
      //    The restore PATCH uses the now-current version.
      const restore = await request.patch(PATH, {
        headers: { Authorization: `Bearer ${superAdminToken}` },
        data: [{ id: editable.id, value: editable.value, expectedVersion: expectedVersion + 1 }],
      });
      expect(restore.status(), 'restore PATCH must succeed so the test is repeatable').toBe(200);
    } finally {
      await ctxA.dispose();
      await ctxB.dispose();
    }
  });

  test('stale expectedVersion returns 412 with currentVersion metadata', async ({ request }) => {
    // Sanity check the 412 mapping in isolation: read, mutate ourselves to
    // bump the version, then issue a PATCH carrying the now-stale version.
    const getRes = await request.get(PATH, { headers: { Authorization: `Bearer ${superAdminToken}` } });
    expect(getRes.status()).toBe(200);
    const body = (await getRes.json()) as { data: ConfigRow[] };
    const target = body.data.find((c) => typeof c.version === 'number');
    expect(target, 'no row with a numeric `version` available').toBeTruthy();
    if (!target) return;

    const staleVersion = target.version;

    // First PATCH: legitimately bumps version from N -> N+1.
    const advance = await request.patch(PATH, {
      headers: { Authorization: `Bearer ${superAdminToken}` },
      data: [{ id: target.id, value: target.value + '-advanced', expectedVersion: staleVersion }],
    });
    expect(advance.status()).toBe(200);

    // Second PATCH: carries the stale version and must fail with 412.
    const conflict = await request.patch(PATH, {
      headers: { Authorization: `Bearer ${superAdminToken}` },
      data: [{ id: target.id, value: 'should-never-write', expectedVersion: staleVersion }],
    });
    expect(conflict.status()).toBe(412);
    const conflictBody = (await conflict.json()) as {
      code: string;
      metadata?: { expectedVersion: number; currentVersion: number };
    };
    expect(conflictBody.code).toBe('PERSISTENCE.CONCURRENCY_CONFLICT');
    expect(conflictBody.metadata?.expectedVersion).toBe(staleVersion);
    expect(conflictBody.metadata?.currentVersion).toBe(staleVersion + 1);

    // Restore the value so this test is repeatable.
    const restore = await request.patch(PATH, {
      headers: { Authorization: `Bearer ${superAdminToken}` },
      data: [{ id: target.id, value: target.value, expectedVersion: staleVersion + 1 }],
    });
    expect(restore.status()).toBe(200);
  });
});

// With `@RequiresIfMatch()` applied to
// the my-tenant config PATCH route, an inbound request without the
// `If-Match` header must return `428 Precondition Required` (RFC 6585).
// The body-field `expectedVersion` is NOT a substitute here — that's the
// service-to-service fallback for routes that don't opt into the header
// contract; once a route opts in, the header is mandatory.
test.describe(`@RequiresIfMatch contract — PATCH /tenant/me/config (Stream D Phase D)`, () => {
  let superAdminToken: string;

  test.beforeAll(async ({ request }) => {
    const { superAdminToken: token } = await loginSeededUsers(request);
    expect(token).toBeTruthy();
    superAdminToken = token!;
  });

  test('PATCH without If-Match returns 428 Precondition Required', async ({ request }) => {
    // Body shape is irrelevant — the 428 fires in the param-decorator
    // pipeline BEFORE the controller body runs. Any authenticated request
    // without `If-Match` to a `@RequiresIfMatch()`-annotated route must
    // 428, regardless of whether `expectedVersion` is in the body.
    const res = await request.patch('/api/v1/tenant/me/config', {
      headers: { Authorization: `Bearer ${superAdminToken}` },
      data: [{ id: 'placeholder-id-doesnt-matter', value: 'x', expectedVersion: 1 }],
    });
    expect(res.status()).toBe(428);

    // The body must carry `code: 'HTTP.PRECONDITION_REQUIRED'` so SDKs
    // can distinguish "you forgot the header" (update the SDK) from a
    // generic 4xx. RFC 6585 lets us communicate this precisely.
    const body = await res.json();
    expect(body.code).toBe('HTTP.PRECONDITION_REQUIRED');
  });

  test('PATCH with valid If-Match passes the header gate (reaches handler)', async ({ request }) => {
    // We're not asserting success here — only that the 428 gate is
    // bypassed when the header is present. Whatever 4xx/2xx happens next
    // (tenant context, locked-row check, OCC conflict) is OUT of scope
    // for D.3 — those are exercised by the C.5/C.6 e2e and the D.3.2
    // header-takes-precedence test below.
    const res = await request.patch('/api/v1/tenant/me/config', {
      headers: {
        Authorization: `Bearer ${superAdminToken}`,
        'If-Match': '"1"',
      },
      data: [{ id: 'placeholder-id-doesnt-matter', value: 'x', expectedVersion: 1 }],
    });
    // Must NOT be 428. (Any other status is fine — what matters here is
    // that the header gate let us through.)
    expect(res.status()).not.toBe(428);
  });

  test('PATCH with malformed If-Match (no quotes) returns 400', async ({ request }) => {
    const res = await request.patch('/api/v1/tenant/me/config', {
      headers: {
        Authorization: `Bearer ${superAdminToken}`,
        'If-Match': '7',
      },
      data: [{ id: 'placeholder-id-doesnt-matter', value: 'x', expectedVersion: 1 }],
    });
    expect(res.status()).toBe(400);
  });

  test('PATCH with weak If-Match (W/"7") returns 400', async ({ request }) => {
    // RFC 7232 §2.3.2: weak comparators are not allowed for `If-Match`.
    // The extractor rejects them as 400.
    const res = await request.patch('/api/v1/tenant/me/config', {
      headers: {
        Authorization: `Bearer ${superAdminToken}`,
        'If-Match': 'W/"7"',
      },
      data: [{ id: 'placeholder-id-doesnt-matter', value: 'x', expectedVersion: 1 }],
    });
    expect(res.status()).toBe(400);
  });
});

// `playwrightRequest` is intentionally imported to keep the type re-export
// in front of any code that uses it for `newContext()`; some bundlers
// tree-shake the second-tier export otherwise.
void playwrightRequest;
