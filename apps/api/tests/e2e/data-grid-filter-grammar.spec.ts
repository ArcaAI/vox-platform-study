/**
 * Data-grid filter-grammar enhancements (Phase 2 backend).
 *
 * What it verifies (see packages/applications/src/common/paginatedQueryParamConverters.ts):
 *
 *  1. List operators — `field[in]:v1|v2` / `field[notIn]:v1|v2` deserialize to
 *     Prisma `{ in: [...] }` / `{ notIn: [...] }` with per-item enum-member
 *     validation (an invalid member anywhere in the list is a clean 400 naming
 *     the allowed members; an empty item — e.g. a trailing '|' — is a 400).
 *
 *  2. Case-insensitive string operators — `field[icontains]:x` (and
 *     istartsWith / iendsWith / iequals) deserialize to
 *     `{ contains: x, mode: 'insensitive' }` etc. Proven end-to-end by
 *     querying an UPPERCASE needle against the lowercase seeded usernames:
 *     `icontains` matches, plain (case-sensitive) `contains` does not.
 *
 *  3. Range merge — `field[gte]:X;field[lte]:Y` merges into one
 *     `{ field: { gte, lte } }` object on a regular (non-JSON) date column.
 *
 *  4. JSON dotted paths deliberately do NOT accept the new list operators —
 *     `jsonColumn.path[in]:a|b` stays a clean 400.
 */
import { test, expect, type APIRequestContext } from '@playwright/test';
import { SEEDED_USERS, loginUser } from '../../../../tests/helpers';

interface Paginated<T> {
  data: T[];
  count: number;
  limit: number;
  page: number;
}

const authGet = (request: APIRequestContext, path: string, token: string, params?: Record<string, string>) =>
  request.get(path, { headers: { Authorization: `Bearer ${token}` }, params });

test.describe('filter grammar: in/notIn lists + case-insensitive string ops', () => {
  let token: string;

  test.beforeAll(async ({ request }) => {
    // Cross-tenant operator: super_admin logs in WITHOUT a tenantKey.
    const sa = await loginUser(request, SEEDED_USERS.superAdmin.username, SEEDED_USERS.superAdmin.password);
    expect(sa, 'super_admin login failed — is the stack seeded?').toBeTruthy();
    token = sa!.token;
  });

  // --- 1. List operators on an enum column ----------------------------------

  test('Tenants list: [in] on the resourceStatus enum column returns matching rows (200)', async ({ request }) => {
    const res = await authGet(request, '/api/v1/admin/tenants', token, {
      limit: '10',
      filters: 'resourceStatus[in]:ENABLED|DISABLED',
    });
    expect(res.status()).toBe(200);
    const body = (await res.json()) as Paginated<{ id: string; resourceStatus?: string }>;
    expect(body.count, 'seeded stack has ENABLED tenants').toBeGreaterThan(0);
    for (const row of body.data) {
      if (row.resourceStatus) {
        expect(['ENABLED', 'DISABLED']).toContain(row.resourceStatus);
      }
    }
  });

  test('Tenants list: an INVALID member anywhere in the [in] list is a 400 naming the allowed members', async ({ request }) => {
    const res = await authGet(request, '/api/v1/admin/tenants', token, {
      limit: '10',
      filters: 'resourceStatus[in]:ENABLED|BOGUS_STATUS',
    });
    expect(res.status(), 'invalid enum member inside a list → BadRequest').toBe(400);
    const message = JSON.stringify(await res.json());
    expect(message).toContain('BOGUS_STATUS');
    expect(message).toContain('ENABLED'); // the allowed members are listed
  });

  test('Tenants list: an EMPTY list item (trailing "|") is a 400', async ({ request }) => {
    const res = await authGet(request, '/api/v1/admin/tenants', token, {
      limit: '10',
      filters: 'resourceStatus[in]:ENABLED|',
    });
    expect(res.status(), 'empty list item → BadRequest (never silently dropped)').toBe(400);
    expect(JSON.stringify(await res.json())).toContain('resourceStatus[in]');
  });

  // --- 2. Case-insensitive string ops on a String column ---------------------

  test('Users list: [icontains] matches an UPPERCASE needle against lowercase usernames (200)', async ({ request }) => {
    // Seeded usernames ('doctor', 'doctor2') are lowercase; the uppercase
    // needle only matches with `mode: 'insensitive'`.
    const res = await authGet(request, '/api/v1/admin/users', token, {
      limit: '50',
      filters: 'username[icontains]:DOCTOR',
    });
    expect(res.status()).toBe(200);
    const body = (await res.json()) as Paginated<{ id: string; username: string }>;
    expect(body.count, 'insensitive contains finds the seeded doctor users').toBeGreaterThan(0);
    for (const row of body.data) {
      expect(row.username.toLowerCase()).toContain('doctor');
    }
  });

  test('Users list: plain [contains] stays case-SENSITIVE (uppercase needle finds nothing)', async ({ request }) => {
    // Postgres LIKE is case-sensitive: no seeded username contains a
    // literal uppercase 'DOCTOR', so the case-sensitive op returns 0 rows.
    const res = await authGet(request, '/api/v1/admin/users', token, {
      limit: '10',
      filters: 'username[contains]:DOCTOR',
    });
    expect(res.status()).toBe(200);
    const body = (await res.json()) as Paginated<{ id: string }>;
    expect(body.count, 'case-sensitive contains must NOT match lowercase usernames').toBe(0);
  });

  // --- 3. Range merge on a regular (non-JSON) date column --------------------

  test('Users list: gte+lte tokens on createdAt merge into one range filter (200)', async ({ request }) => {
    const res = await authGet(request, '/api/v1/admin/users', token, {
      limit: '10',
      filters: 'createdAt[gte]:1970-01-01;createdAt[lte]:2100-01-01',
    });
    expect(res.status()).toBe(200);
    const body = (await res.json()) as Paginated<{ id: string }>;
    expect(body.count, 'the all-time range matches every seeded user').toBeGreaterThan(0);
  });

  // --- 4. JSON dotted paths reject the new list operators --------------------

  test('Users list: [in] on a JSON dotted path is a clean 400 (not a JSON path operator)', async ({ request }) => {
    const res = await authGet(request, '/api/v1/admin/users', token, {
      limit: '10',
      filters: 'metaData.tags[in]:a|b',
    });
    expect(res.status()).toBe(400);
    expect(JSON.stringify(await res.json())).toContain("'in'");
  });
});
