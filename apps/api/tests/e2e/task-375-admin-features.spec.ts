/**
 * Admin-feature backend contract verification.
 *
 * Exercises the server side of the three admin features shipped this session,
 * against the live API (`pnpm test:e2e`, or a dev stack via
 * `SKIP_DB_PRECHECK=true API_URL=http://localhost:8868`). Each flow is a real
 * HTTP round-trip with the seeded `super_admin` (cross-tenant operator).
 *
 *  1. D8 grid-layout persistence — `PATCH /user/me/settings/ui.data-grid/:key`
 *     persists a layout under the `ui.data-grid` namespace and a re-PATCH
 *     upserts the SAME row (no duplicate). Also pins the wire contract that the
 *     admin grid adapter must satisfy: `value` is a JSON **string** — an object
 *     value 400s ("value must be a string"). This is the exact regression that
 *     silently broke D8 from the admin (adapter sent the raw object).
 *
 *  2. Users server-side sort/filter/search — `GET /admin/users` accepts the
 *     shared `PaginatedQuery` CSV params (`sort`, `filters`, `search`) WITHOUT
 *     a 400, and returns correctly ordered / filtered / searched / offset-paged
 *     data. Guards the `@IsOptional()` fix on `PaginatedQuery.{sort,filters}`
 *     (they previously lacked a class-validator decorator, so the strict
 *     `forbidNonWhitelisted` pipe rejected them).
 *
 *  3. Media + thumbnails — `GET /consultations/:id/context` resolves presigned
 *     `url` (+ `mimeType`, and `thumbnailUrl` for images) for attachments.
 *     This route is TENANT-SCOPED, so it is read as the consultation's
 *     tenant-bound owner (NOT the cross-tenant super_admin, who has no tenant
 *     binding and is rejected 400 "Tenant ID is required"). Defaults to the
 *     seeded media fixture (consultation 90000000-…-376), which is folded into
 *     the test-DB seed (`test:db:seed` + the CI prepare-test-db job), so it runs
 *     without manual env. Override with `E2E_CONSULTATION_ID`, or set it to an
 *     EMPTY string to skip when no media fixture/storage is present. The
 *     owner login is env-overridable too:
 *     `E2E_MEDIA_OWNER_USERNAME` / `E2E_MEDIA_OWNER_PASSWORD` /
 *     `E2E_MEDIA_OWNER_TENANT_KEY` (defaults: seeded doctor / __GLOBAL__).
 */
import { test, expect, type APIRequestContext } from '@playwright/test';
import { SEEDED_USERS, DEFAULT_TENANT_KEY, loginUser } from '../../../../tests/helpers';

interface PaginatedUsers {
  data: Array<{ id: string; username: string; createdAt: string; isServiceAccount?: boolean }>;
  count: number;
  limit: number;
  page: number;
}

interface UserSetting {
  namespace?: string;
  key: string;
  value: unknown;
}

interface ContextItem {
  id: string;
  type: string;
  mediaId?: string;
  url?: string;
  mimeType?: string;
  thumbnailUrl?: string;
  isAttachment?: boolean;
}

const GRID_NAMESPACE = 'ui.data-grid';
const GRID_KEY = 'e2e-task375'; // dedicated key — idempotent upsert, no cleanup endpoint exists

// The additive media seed (folded into the test-DB seed) creates this
// Global-tenant consultation with image/pdf/audio/mixed ATTACHMENT context items.
// Used as the default when E2E_CONSULTATION_ID is not set.
const DEFAULT_MEDIA_CONSULTATION_ID = '90000000-0000-0000-0000-000000000376';

// The media test reads as the
// consultation's TENANT-BOUND owner. When E2E_CONSULTATION_ID points at a
// different tenant's consultation, override the owner credentials via env;
// they default to the seeded fixture's owner (`doctor` in __GLOBAL__).
const MEDIA_OWNER = {
  username: process.env.E2E_MEDIA_OWNER_USERNAME || SEEDED_USERS.doctor.username,
  password: process.env.E2E_MEDIA_OWNER_PASSWORD || SEEDED_USERS.doctor.password,
  tenantKey: process.env.E2E_MEDIA_OWNER_TENANT_KEY || DEFAULT_TENANT_KEY,
};

const authGet = (request: APIRequestContext, path: string, token: string, params?: Record<string, string>) =>
  request.get(path, { headers: { Authorization: `Bearer ${token}` }, params });

test.describe('TASK-375 — admin features (D8 persistence, Users sort/filter/search, media)', () => {
  let token: string;

  test.beforeAll(async ({ request }) => {
    // Cross-tenant operator: super_admin logs in WITHOUT a tenantKey.
    const sa = await loginUser(request, SEEDED_USERS.superAdmin.username, SEEDED_USERS.superAdmin.password);
    expect(sa, 'super_admin login failed — is the stack seeded?').toBeTruthy();
    token = sa!.token;
  });

  // --- 1. D8 grid-layout persistence (server-side) ---------------------------

  test('D8: PATCH ui.data-grid persists a JSON-string layout and GET reflects it', async ({ request }) => {
    const layout = JSON.stringify({ density: 'compact', order: ['username', 'email'], sizing: { username: 240 } });

    const patch = await request.patch(`/api/v1/user/me/settings/${GRID_NAMESPACE}/${GRID_KEY}`, {
      headers: { Authorization: `Bearer ${token}` },
      data: { value: layout },
    });
    expect(patch.status(), 'PATCH ui.data-grid (string value)').toBe(200);

    const get = await authGet(request, '/api/v1/user/me/settings', token);
    expect(get.status()).toBe(200);
    const settings = (await get.json()) as UserSetting[];
    const entry = settings.find((s) => s.namespace === GRID_NAMESPACE && s.key === GRID_KEY);
    expect(entry, 'persisted ui.data-grid entry').toBeTruthy();
    expect(entry!.value).toBe(layout);
  });

  test('D8: re-PATCH upserts the same setting (no duplicate row)', async ({ request }) => {
    const next = JSON.stringify({ density: 'comfortable', order: ['email', 'username'] });
    const patch = await request.patch(`/api/v1/user/me/settings/${GRID_NAMESPACE}/${GRID_KEY}`, {
      headers: { Authorization: `Bearer ${token}` },
      data: { value: next },
    });
    expect(patch.status()).toBe(200);

    const get = await authGet(request, '/api/v1/user/me/settings', token);
    const settings = (await get.json()) as UserSetting[];
    const matches = settings.filter((s) => s.namespace === GRID_NAMESPACE && s.key === GRID_KEY);
    expect(matches.length, 'exactly one row per (namespace,key) — upsert not insert').toBe(1);
    expect(matches[0].value).toBe(next);
  });

  test('D8 contract: an OBJECT value is rejected (admin adapter MUST serialize)', async ({ request }) => {
    // The settings `value` is `@IsString()` + validated via JSON.parse. The
    // admin grid adapter therefore JSON.stringify()s the layout; sending the
    // raw object 400s — the defect that broke D8 saves end-to-end.
    const patch = await request.patch(`/api/v1/user/me/settings/${GRID_NAMESPACE}/${GRID_KEY}`, {
      headers: { Authorization: `Bearer ${token}` },
      data: { value: { density: 'compact' } },
    });
    expect(patch.status(), 'object value must be rejected').toBe(400);
  });

  // --- 2. Users server-side sort / filter / search / offset ------------------

  test('Users: sort=username:asc|desc are accepted (no 400) and direction is honored', async ({ request }) => {
    const asc = await authGet(request, '/api/v1/admin/users', token, { limit: '50', sort: 'username:asc' });
    const desc = await authGet(request, '/api/v1/admin/users', token, { limit: '50', sort: 'username:desc' });
    expect(asc.status(), 'sort=username:asc must NOT 400 (PaginatedQuery.sort @IsOptional)').toBe(200);
    expect(desc.status()).toBe(200);

    const ascNames = ((await asc.json()) as PaginatedUsers).data.map((u) => u.username);
    const descNames = ((await desc.json()) as PaginatedUsers).data.map((u) => u.username);

    // Collation-agnostic: assert the server APPLIED an order and HONORED the
    // direction (desc is the exact reverse of asc). We deliberately do NOT
    // re-sort with JS localeCompare — Postgres' collation differs from
    // ECMAScript's (e.g. it orders `doctor2` after `doctor_surgery`), so a
    // client-side re-sort would be comparing two different algorithms.
    expect(ascNames.length).toBeGreaterThan(1);
    expect(descNames, 'desc is the exact reverse of asc — server applied a consistent order').toEqual([...ascNames].reverse());
  });

  test('Users: search returns only matching usernames', async ({ request }) => {
    const res = await authGet(request, '/api/v1/admin/users', token, { limit: '50', search: 'doctor' });
    expect(res.status()).toBe(200);
    const body = (await res.json()) as PaginatedUsers;
    expect(body.data.length, 'search=doctor matches seeded doctor_* users').toBeGreaterThan(0);
    for (const u of body.data) {
      expect(u.username.toLowerCase()).toContain('doctor');
    }
  });

  test('Users: filters (field[op]:value) are accepted and narrow the result set', async ({ request }) => {
    const all = await authGet(request, '/api/v1/admin/users', token, { limit: '200' });
    const filtered = await authGet(request, '/api/v1/admin/users', token, {
      limit: '200',
      filters: 'username[contains]:doctor',
    });
    expect(filtered.status(), 'filters=... must NOT 400 (PaginatedQuery.filters @IsOptional)').toBe(200);

    const allCount = ((await all.json()) as PaginatedUsers).count;
    const filteredBody = (await filtered.json()) as PaginatedUsers;
    expect(filteredBody.count, 'filter narrows the set').toBeLessThan(allCount);
    for (const u of filteredBody.data) {
      expect(u.username.toLowerCase()).toContain('doctor');
    }
  });

  // DEFECT-F1 (backend): a boolean-column filter must be coerced from its
  // string CSV value to the column's type. Pre-fix, `isServiceAccount[equals]:true`
  // reached Prisma as `{ equals: 'true' }` (a string) and 400d on the Bool
  // column. The UserService now declares `isServiceAccount` as a boolean
  // filter field so `withFormatted{Paginated,Count}Props` coerce it.
  test('F1: boolean column filter isServiceAccount[equals]:true|false returns 200 and narrows', async ({ request }) => {
    const all = await authGet(request, '/api/v1/admin/users', token, { limit: '200' });
    expect(all.status()).toBe(200);
    const allBody = (await all.json()) as PaginatedUsers;

    const onlyService = await authGet(request, '/api/v1/admin/users', token, {
      limit: '200',
      filters: 'isServiceAccount[equals]:true',
    });
    expect(onlyService.status(), 'boolean filter must NOT 400 — string->bool coercion (DEFECT-F1)').toBe(200);
    const serviceBody = (await onlyService.json()) as PaginatedUsers;

    const onlyHuman = await authGet(request, '/api/v1/admin/users', token, {
      limit: '200',
      filters: 'isServiceAccount[equals]:false',
    });
    expect(onlyHuman.status()).toBe(200);
    const humanBody = (await onlyHuman.json()) as PaginatedUsers;

    // Filtering happened IN THE DATABASE: every returned row matches the predicate.
    for (const u of serviceBody.data) expect(u.isServiceAccount, `${u.username} is a service account`).toBe(true);
    for (const u of humanBody.data) expect(Boolean(u.isServiceAccount), `${u.username} is NOT a service account`).toBe(false);

    // Narrows: each disjoint half is smaller than the unfiltered set, and the
    // two halves partition the whole (count_true + count_false === total).
    expect(serviceBody.count, 'seed ships >= 1 service account (service_account, __system__)').toBeGreaterThan(0);
    expect(serviceBody.count, 'service-account filter narrows vs unfiltered').toBeLessThan(allBody.count);
    expect(humanBody.count).toBeLessThan(allBody.count);
    expect(serviceBody.count + humanBody.count, 'true/false partition the full set').toBe(allBody.count);
  });

  test('Users: offset paging advances (server is 1-indexed: page>=2 is a new slice)', async ({ request }) => {
    const full = (
      (await (await authGet(request, '/api/v1/admin/users', token, { limit: '200', sort: 'username:asc' })).json()) as PaginatedUsers
    ).data.map((u) => u.username);
    test.skip(full.length < 4, 'need >= 4 users to assert paging');

    const L = 2;
    const p1 = (
      (await (await authGet(request, '/api/v1/admin/users', token, { limit: String(L), page: '1', sort: 'username:asc' })).json()) as PaginatedUsers
    ).data.map((u) => u.username);
    const p2 = (
      (await (await authGet(request, '/api/v1/admin/users', token, { limit: String(L), page: '2', sort: 'username:asc' })).json()) as PaginatedUsers
    ).data.map((u) => u.username);

    // Backend skip = max(0, (page-1)*limit). page=1 -> rows[0..L-1]; page=2 -> rows[L..2L-1].
    expect(p1, 'page 1 (1-indexed) is the first slice').toEqual(full.slice(0, L));
    expect(p2, 'page 2 is the SECOND slice (disjoint from page 1)').toEqual(full.slice(L, 2 * L));
    expect(
      p1.some((u) => p2.includes(u)),
      'pages do not overlap',
    ).toBe(false);
  });

  // DEFECT-P1 (frontend): the admin grid's pagination is 0-based, but the
  // backend is 1-based (skip = max(0,(page-1)*limit)). Sent verbatim, grid
  // page 0 and page 1 both clamp to skip=0 and return the SAME rows. The
  // `toUserListQuery` mapper now sends backendPage = gridPage + 1. This test
  // reproduces the raw 0/1 collision the bug caused, then proves the +1
  // translation yields DISTINCT slices for grid pages 0 -> 1.
  test('P1: grid pages 0 -> 1 map (via +1) to DISTINCT backend slices', async ({ request }) => {
    const full = (
      (await (await authGet(request, '/api/v1/admin/users', token, { limit: '200', sort: 'username:asc' })).json()) as PaginatedUsers
    ).data.map((u) => u.username);
    test.skip(full.length < 4, 'need >= 4 users to assert paging');

    const L = 2;
    const pageRows = async (backendPage: number): Promise<string[]> =>
      (
        (await (
          await authGet(request, '/api/v1/admin/users', token, { limit: String(L), page: String(backendPage), sort: 'username:asc' })
        ).json()) as PaginatedUsers
      ).data.map((u) => u.username);

    // The BUG: a 0-based grid page sent verbatim — page 0 and page 1 both clamp to skip=0.
    const raw0 = await pageRows(0);
    const raw1 = await pageRows(1);
    expect(raw1, 'raw 0-based grid pages 0 and 1 collide on skip=0 (what toUserListQuery prevents)').toEqual(raw0);

    // The FIX: toUserListQuery sends backendPage = gridPage + 1.
    const grid0 = await pageRows(0 + 1);
    const grid1 = await pageRows(1 + 1);
    expect(grid0, 'grid page 0 -> backend page 1 -> first slice').toEqual(full.slice(0, L));
    expect(grid1, 'grid page 1 -> backend page 2 -> second slice').toEqual(full.slice(L, 2 * L));
    expect(
      grid0.some((u) => grid1.includes(u)),
      'grid pages 0 and 1 return DISTINCT rows',
    ).toBe(false);
  });

  // --- 3. Media + thumbnails (presigned URLs) --------------------------------

  test('Media: context attachments expose presigned url + mimeType (+ thumbnail for images)', async ({ request }) => {
    // Default to the seeded fixture so this runs without manual env
    // once the test-DB seed has run. `??` keeps an explicit empty string
    // (E2E_CONSULTATION_ID="") as an opt-out to skip when no fixture/storage.
    const consultationId = process.env.E2E_CONSULTATION_ID ?? DEFAULT_MEDIA_CONSULTATION_ID;
    test.skip(
      !consultationId,
      'No media consultation available. The additive TASK-376 seed (folded into the test-DB seed via ' +
        'pnpm test:db:seed and the CI prepare-test-db job) provides consultation ' +
        `${DEFAULT_MEDIA_CONSULTATION_ID}. Override with E2E_CONSULTATION_ID, or set it to an empty ` +
        'string to skip (see docs/implementation/TASK-376-Media-Seed-And-Backfill/README.md).',
    );

    // The consultation-context route is TENANT-SCOPED: the cross-tenant
    // `super_admin` (no tenant binding) is rejected 400 "Tenant ID is
    // required". Read as the consultation's tenant-bound owner instead —
    // env-overridable, defaulting to the seeded fixture
    // owner `doctor` in the __GLOBAL__ tenant.
    const owner = await loginUser(request, MEDIA_OWNER.username, MEDIA_OWNER.password, MEDIA_OWNER.tenantKey);
    expect(
      owner,
      `consultation-owner (${MEDIA_OWNER.username}) login failed — is the stack seeded / are the E2E_MEDIA_OWNER_* env overrides correct?`,
    ).toBeTruthy();

    const res = await authGet(request, `/api/v1/consultations/${consultationId}/context`, owner!.token);
    expect(res.status()).toBe(200);
    const items = (await res.json()) as ContextItem[];
    const media = items.filter((i) => i.mediaId);
    expect(media.length, 'consultation has at least one media-bearing context item').toBeGreaterThan(0);

    for (const item of media) {
      expect(item.url, `context item ${item.id} resolves a presigned url`).toBeTruthy();
      expect(item.url!.startsWith('http'), 'url is an absolute (presigned) URL').toBe(true);
      expect(item.mimeType, 'media item carries a mimeType').toBeTruthy();
      if ((item.mimeType ?? '').startsWith('image/')) {
        // Real `.thumb.webp` derivative when generated on upload; otherwise
        // falls back to the full-size URL (pre-existing media w/o derivative).
        expect(item.thumbnailUrl, 'image item exposes a thumbnailUrl').toBeTruthy();
      }
    }
  });
});
