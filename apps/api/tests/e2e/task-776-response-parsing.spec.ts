/**
 * TASK-776 — Response-parsing contract: ETag / If-Match OCC + pagination envelopes.
 *
 * Verifies, against the LIVE gateway:
 *   1. `ETagInterceptor` — strong quoted-decimal `ETag` on a versioned GET.
 *   2. `@RequiresIfMatch()` + `@ExpectedVersion()` — the full malformed/missing/
 *      stale/correct `If-Match` matrix (`apps/api/src/decorators/expectedVersion.decorator.ts`).
 *   3. Offset pagination (`PaginatedQuery`: page/limit/search/searchFields/filters/sort)
 *      and cursor pagination (`CursorQuery`/`CursorPaginated`: data/nextCursor/hasMore/limit,
 *      DEFAULT_CURSOR_LIMIT=10, MAX_CURSOR_LIMIT=100) envelope shapes.
 *
 * Route under test for the OCC matrix: `PATCH /admin/departments/{id}`
 * (`apps/api/route-manifest.json` confirms `requiresIfMatch: true`).
 *
 * Every assertion below was independently verified with live `curl` calls against
 * the running test-stack API before being encoded here — divergences from the
 * originally-briefed contract are called out inline as `DIVERGENCE:` comments.
 */

import { test, expect } from '@playwright/test';
import { loginUser, SEEDED_USERS, DEFAULT_TENANT_KEY } from '../../../../tests/helpers';

function auth(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

// Ids created by THIS worker process. `test.afterAll` runs once per worker, so
// cleanup must be keyed on what this worker actually made — filtering by name
// prefix would delete rows a sibling worker is still using mid-test.
const createdDepartmentIds: string[] = [];

async function createDepartment(request: import('@playwright/test').APIRequestContext, token: string, namePrefix: string) {
  const res = await request.post('/api/v1/admin/departments', {
    headers: auth(token),
    data: { name: `${namePrefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` },
  });
  expect(res.status(), 'department create must succeed').toBe(201);
  const dept = (await res.json()) as { id: string; version: number };
  createdDepartmentIds.push(dept.id);
  return dept;
}

test.describe('TASK-776: response parsing — ETag / If-Match OCC + pagination', () => {
  let tenantAdminToken: string;

  test.beforeAll(async ({ request }) => {
    const admin = await loginUser(request, SEEDED_USERS.admin.username, SEEDED_USERS.admin.password, DEFAULT_TENANT_KEY);
    expect(admin, 'tenant_admin login must succeed').not.toBeNull();
    tenantAdminToken = admin!.token;
  });

  // Every department this spec creates is named `t776-*`. Without this the rows
  // accumulate on every run against a shared, non-reset test DB (RESET_DB=false
  // is the normal local invocation), so the suite must clean up after itself.
  test.afterAll(async ({ request }) => {
    await Promise.all(
      createdDepartmentIds.splice(0).map((id) => request.delete(`/api/v1/admin/departments/${id}`, { headers: auth(tenantAdminToken) })),
    );
  });

  // ==========================================================================
  // ETag on GET
  // ==========================================================================

  test('GET on a versioned resource returns a strong, quoted-decimal ETag', async ({ request }) => {
    const dept = await createDepartment(request, tenantAdminToken, 't776-etag');
    const res = await request.get(`/api/v1/admin/departments/${dept.id}`, { headers: auth(tenantAdminToken) });
    expect(res.status()).toBe(200);
    expect(res.headers()['etag']).toBe('"1"');
  });

  // ==========================================================================
  // If-Match matrix
  // ==========================================================================

  test.describe('If-Match matrix on PATCH /admin/departments/{id}', () => {
    test('missing If-Match => 428 with code HTTP.PRECONDITION_REQUIRED', async ({ request }) => {
      const dept = await createDepartment(request, tenantAdminToken, 't776-missing');
      const res = await request.patch(`/api/v1/admin/departments/${dept.id}`, {
        headers: auth(tenantAdminToken),
        data: { description: 'no header' },
      });
      expect(res.status()).toBe(428);
      const body = await res.json();
      expect(body).toMatchObject({
        statusCode: 428,
        code: 'HTTP.PRECONDITION_REQUIRED',
        message: 'If-Match header is required for this operation.',
      });
    });

    const malformedCases: Array<{ label: string; header: string }> = [
      { label: 'unquoted decimal', header: '3' },
      { label: 'weak validator', header: 'W/"3"' },
      { label: 'wildcard', header: '*' },
      { label: 'negative quoted', header: '"-1"' },
      { label: 'non-numeric quoted', header: '"abc"' },
    ];

    for (const { label, header } of malformedCases) {
      test(`malformed If-Match (${label}: ${header}) => 400`, async ({ request }) => {
        const dept = await createDepartment(request, tenantAdminToken, 't776-malformed');
        const res = await request.patch(`/api/v1/admin/departments/${dept.id}`, {
          headers: { ...auth(tenantAdminToken), 'If-Match': header },
          data: { description: 'malformed if-match' },
        });
        expect(res.status(), `header "${header}" (${label})`).toBe(400);
        const body = await res.json();
        // The @ExpectedVersion() param decorator throws a plain BadRequestException
        // with a string `message` (NOT the class-validator array `subErrors` envelope
        // used elsewhere in this suite) — confirmed live: this generic-BadRequestException
        // shape wins even when the request body ALSO fails DTO validation (it lacks
        // `expectedVersion`), meaning If-Match parsing is evaluated ahead of body
        // validation for this route's parameter list.
        expect(body.statusCode).toBe(400);
        expect(typeof body.message).toBe('string');
        expect(body.message).toContain('Invalid If-Match header');
      });
    }

    test('stale If-Match (version drift) => 412', async ({ request }) => {
      const dept = await createDepartment(request, tenantAdminToken, 't776-stale');
      const res = await request.patch(`/api/v1/admin/departments/${dept.id}`, {
        headers: { ...auth(tenantAdminToken), 'If-Match': '"99"' },
        data: { description: 'stale', expectedVersion: 99 },
      });
      expect(res.status()).toBe(412);
      const body = await res.json();
      expect(body.code).toBe('PERSISTENCE.CONCURRENCY_CONFLICT');
      expect(body.metadata).toMatchObject({ expectedVersion: 99, currentVersion: 1 });
    });

    test('correct If-Match => 200 and the ETag increments on refetch', async ({ request }) => {
      const dept = await createDepartment(request, tenantAdminToken, 't776-correct');

      // DIVERGENCE: the briefed contract implied the `If-Match` HEADER alone is
      // sufficient for a correct conditional write. In practice
      // `UpdateDepartmentRequest.expectedVersion` is a REQUIRED (`@IsInt() @Min(1)`,
      // no `@IsOptional()`) body field, validated by the global ValidationPipe
      // BEFORE the controller ever folds the header value over it
      // (`department.controller.ts#update`: "Header takes precedence over body
      // when both are present" — but the body field must still independently pass
      // DTO validation). A header-only PATCH (body omits `expectedVersion`) 400s
      // with `subErrors: ["expectedVersion must not be less than 1", "expectedVersion
      // must be an integer number"]`, matching neither this test's "malformed
      // header" cases above (that class of error fires earlier) nor a clean 200/412.
      // The client-facing contract is therefore: send BOTH the `If-Match` header
      // AND a matching `expectedVersion` body field.
      const patchRes = await request.patch(`/api/v1/admin/departments/${dept.id}`, {
        headers: { ...auth(tenantAdminToken), 'If-Match': '"1"' },
        data: { description: 'correct update', expectedVersion: 1 },
      });
      expect(patchRes.status()).toBe(200);
      const patched = await patchRes.json();
      expect(patched.version).toBe(2);

      const getRes = await request.get(`/api/v1/admin/departments/${dept.id}`, { headers: auth(tenantAdminToken) });
      expect(getRes.status()).toBe(200);
      expect(getRes.headers()['etag']).toBe('"2"');
    });

    test('If-Match header WITHOUT a matching expectedVersion body field => 400 validation error (not 200/412)', async ({ request }) => {
      // Companion assertion for the divergence documented above: proves the
      // header-only shape fails DTO validation rather than silently succeeding
      // or silently 412-ing.
      const dept = await createDepartment(request, tenantAdminToken, 't776-header-only');
      const res = await request.patch(`/api/v1/admin/departments/${dept.id}`, {
        headers: { ...auth(tenantAdminToken), 'If-Match': '"1"' },
        data: { description: 'header only, no body expectedVersion' },
      });
      expect(res.status()).toBe(400);
      const body = await res.json();
      expect(body.message).toBe('Validation error');
      expect(body.subErrors).toEqual(expect.arrayContaining([expect.stringContaining('expectedVersion')]));
    });
  });

  // ==========================================================================
  // Pagination envelopes
  // ==========================================================================

  test.describe('offset pagination (PaginatedQuery: page/limit/search/searchFields/filters/sort)', () => {
    test('default envelope shape; page defaults to 0, actual page size defaults to 10', async ({ request }) => {
      const res = await request.get('/api/v1/admin/audit-logs', { headers: auth(tenantAdminToken) });
      expect(res.status()).toBe(200);
      const body = await res.json();
      expect(body).toEqual(
        expect.objectContaining({
          count: expect.any(Number),
          limit: expect.any(Number),
          page: expect.any(Number),
          data: expect.any(Array),
        }),
      );
      expect(body.page).toBe(0);
      // F-02 (fixed): the offset `limit` default is 10, and the response
      // envelope's `limit` FIELD now echoes the EFFECTIVE page size actually
      // applied, not the raw (pre-default) query value. Previously
      // `PaginatedQuery.limit` carried only a Swagger-metadata `default: 10`
      // that was never applied to the bound value, so an omitted `?limit=`
      // flowed through as `undefined` -> JSON `0` even though the service
      // queried 10 rows — a client paginating off the echoed `limit` would
      // compute its next offset from 0 and loop forever. The default is now
      // applied at the DTO layer itself (`PaginatedQuery.limit = DEFAULT_PAGE_SIZE`,
      // `packages/applications/src/common/dto/paginated.query.ts`), so the raw
      // and effective values coincide.
      expect(body.limit).toBe(10);
      expect(body.data.length).toBeLessThanOrEqual(10);
    });

    test('page/limit/search/searchFields/filters/sort are all accepted and echoed/coerced', async ({ request }) => {
      const res = await request.get('/api/v1/admin/audit-logs?page=0&limit=3&search=&searchFields=action&filters=action:UPDATE&sort=createdAt:desc', {
        headers: auth(tenantAdminToken),
      });
      expect(res.status()).toBe(200);
      const body = await res.json();
      expect(body.limit).toBe(3);
      expect(body.page).toBe(0);
      expect(Array.isArray(body.data)).toBe(true);
      expect(body.data.length).toBeLessThanOrEqual(3);
    });
  });

  test.describe('cursor pagination (CursorQuery/CursorPaginated: data/nextCursor/hasMore/limit)', () => {
    test('default envelope shape and DEFAULT_CURSOR_LIMIT=10', async ({ request }) => {
      const res = await request.get('/api/v1/admin/audit-logs/cursor', { headers: auth(tenantAdminToken) });
      expect(res.status()).toBe(200);
      const body = await res.json();
      expect(Object.keys(body).sort()).toEqual(['data', 'hasMore', 'limit', 'nextCursor']);
      expect(Array.isArray(body.data)).toBe(true);
      expect(typeof body.hasMore).toBe('boolean');
      expect(body.limit).toBe(10);
      expect(body.nextCursor === null || typeof body.nextCursor === 'string').toBe(true);
    });

    test('explicit limit is honored up to MAX_CURSOR_LIMIT', async ({ request }) => {
      const res = await request.get('/api/v1/admin/audit-logs/cursor?limit=3', { headers: auth(tenantAdminToken) });
      expect(res.status()).toBe(200);
      const body = await res.json();
      expect(body.limit).toBe(3);
      expect(body.data.length).toBeLessThanOrEqual(3);
    });

    test('limit > MAX_CURSOR_LIMIT (100) is CLAMPED to 100, not rejected with 400', async ({ request }) => {
      // Discovered empirically (clampCursorLimit in packages/applications/src/common/cursorPagination.ts):
      // `Math.min(Math.floor(limit), MAX_CURSOR_LIMIT)` — over-limit silently clamps down,
      // it does not 400. This matches the briefed "discover it, don't assume" instruction.
      const res = await request.get('/api/v1/admin/audit-logs/cursor?limit=150', { headers: auth(tenantAdminToken) });
      expect(res.status()).toBe(200);
      const body = await res.json();
      expect(body.limit).toBe(100);
    });
  });
});
