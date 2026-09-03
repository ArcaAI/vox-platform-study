/**
 * Request-validation contract (global ValidationPipe + exception mapping)
 *
 * Verifies, against the LIVE gateway, the behaviors documented for:
 *   1. The global `ValidationPipe` (`transform + whitelist + forbidNonWhitelisted +
 *      forbidUnknownValues`) — extra fields, wrong primitive types, missing required
 *      fields, enum violations, Min/Max range violations, and query-string `transform`
 *      coercion.
 *   2. Exception → HTTP status mapping (`ExceptionInterceptor` +
 *      `DataNotFoundExceptionFilter`): `DataNotFoundException` → 404,
 *      `ArgumentInvalidException` → 400, `OptimisticConcurrencyException` → 412,
 *      Prisma `P2002` → 409 / `P2025` → 404.
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

function trackDepartment<T extends { id?: string }>(row: T): T {
  if (row && typeof row.id === 'string') createdDepartmentIds.push(row.id);
  return row;
}

test.describe('request validation', () => {
  let tenantAdminToken: string;
  let superAdminToken: string;

  test.beforeAll(async ({ request }) => {
    const admin = await loginUser(request, SEEDED_USERS.admin.username, SEEDED_USERS.admin.password, DEFAULT_TENANT_KEY);
    expect(admin, 'tenant_admin login must succeed').not.toBeNull();
    tenantAdminToken = admin!.token;

    const superAdmin = await loginUser(request, SEEDED_USERS.superAdmin.username, SEEDED_USERS.superAdmin.password);
    expect(superAdmin, 'super_admin login must succeed').not.toBeNull();
    superAdminToken = superAdmin!.token;
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
  // Global ValidationPipe: transform + whitelist + forbidNonWhitelisted + forbidUnknownValues
  // ==========================================================================

  test.describe('global ValidationPipe envelope', () => {
    test('undeclared/extra body field on POST => 400 with the ApiErrorResponse envelope', async ({ request }) => {
      const res = await request.post('/api/v1/admin/departments', {
        headers: auth(tenantAdminToken),
        data: { name: `t776-extra-${Date.now()}`, notAField: 'x' },
      });
      expect(res.status()).toBe(400);
      const body = await res.json();
      expect(body).toMatchObject({
        statusCode: 400,
        message: 'Validation error',
        error: 'Bad Request',
      });
      expect(Array.isArray(body.subErrors)).toBe(true);
      expect(body.subErrors.some((s: string) => s.includes('notAField'))).toBe(true);
      expect(typeof body.correlationId).toBe('string');
      expect(body.correlationId.length).toBeGreaterThan(0);
    });

    test('wrong primitive type (number where string expected) => 400 envelope', async ({ request }) => {
      const res = await request.post('/api/v1/admin/departments', {
        headers: auth(tenantAdminToken),
        data: { name: 123 },
      });
      expect(res.status()).toBe(400);
      const body = await res.json();
      expect(body).toMatchObject({ statusCode: 400, message: 'Validation error', error: 'Bad Request' });
      expect(body.subErrors.some((s: string) => s.includes('name must be a string'))).toBe(true);
    });

    test('missing required field => 400 envelope', async ({ request }) => {
      // CreateGlobalSettingRequest.key is @IsString() @IsNotEmpty() (required).
      const res = await request.post('/api/v1/admin/settings', {
        headers: auth(superAdminToken),
        data: { name: 't776', value: '1', dataType: 'String' },
      });
      expect(res.status()).toBe(400);
      const body = await res.json();
      expect(body).toMatchObject({ statusCode: 400, message: 'Validation error', error: 'Bad Request' });
      expect(body.subErrors.some((s: string) => s.includes('key'))).toBe(true);
    });

    test('enum violation => 400 envelope naming every allowed ValueType', async ({ request }) => {
      const res = await request.post('/api/v1/admin/settings', {
        headers: auth(superAdminToken),
        data: { name: 't776', key: `t776.enum.${Date.now()}`, value: '1', dataType: 'NOT_A_TYPE' },
      });
      expect(res.status()).toBe(400);
      const body = await res.json();
      expect(body).toMatchObject({ statusCode: 400, message: 'Validation error', error: 'Bad Request' });
      expect(body.subErrors.some((s: string) => s.includes('dataType must be one of the following values'))).toBe(true);
    });

    test('out-of-range Min violation (negative offset page) => 400 envelope', async ({ request }) => {
      // PaginatedQuery.page carries @Min(0); AuditLogQuery extends it.
      const res = await request.get('/api/v1/admin/audit-logs?page=-1&limit=5', {
        headers: auth(tenantAdminToken),
      });
      expect(res.status()).toBe(400);
      const body = await res.json();
      expect(body).toMatchObject({ statusCode: 400, message: 'Validation error', error: 'Bad Request' });
      expect(body.subErrors.some((s: string) => s.includes('page must not be less than 0'))).toBe(true);
    });

    test('transform:true coerces numeric query strings into numbers on the offset list envelope', async ({ request }) => {
      const res = await request.get('/api/v1/admin/audit-logs?page=1&limit=5', {
        headers: auth(tenantAdminToken),
      });
      expect(res.status()).toBe(200);
      const body = await res.json();
      // Coerced by @Transform(({value}) => parseInt(value, 10)) — JSON.parse of the
      // response body proves these arrived as `number`, not the literal query strings.
      expect(typeof body.page).toBe('number');
      expect(body.page).toBe(1);
      expect(typeof body.limit).toBe('number');
      expect(body.limit).toBe(5);
      expect(Array.isArray(body.data)).toBe(true);
      expect(typeof body.count).toBe('number');
    });
  });

  // ==========================================================================
  // Exception mapping
  // ==========================================================================

  test.describe('exception -> HTTP status mapping', () => {
    test('DataNotFoundException => 404 with the generic unified-envelope body', async ({ request }) => {
      // `DepartmentRepository.findById` throws the domain `DataNotFoundException`
      // directly on a miss (repository.ts:109-116); `DepartmentService.update`'s own
      // `if (!department) throw new NotFoundException(...)` guard right after it is
      // therefore unreachable dead code on this path — the raw DataNotFoundException
      // always wins and is mapped by the dedicated `DataNotFoundExceptionFilter`.
      const fakeId = '00000000-0000-0000-0000-000000000000';
      const res = await request.patch(`/api/v1/admin/departments/${fakeId}`, {
        headers: { ...auth(tenantAdminToken), 'If-Match': '"1"' },
        data: { description: 'x', expectedVersion: 1 },
      });
      expect(res.status()).toBe(404);
      const body = await res.json();
      // Exact shape from DataNotFoundExceptionFilter. Since REST review H-2 this
      // is the ONE unified envelope every gateway error uses —
      // `{statusCode, code, message, correlationId}` — so the filter now also
      // emits `code: 'HTTP.NOT_FOUND'` (status-derived: it has no domain code)
      // and the correlationId. Deliberately still NO `error` key here.
      //
      // The enumeration posture is unchanged and is what the strict `toEqual`
      // pins: the message stays the generic 'Resource not found', so neither
      // the model name nor the row id appears anywhere in the body.
      expect(body).toEqual({
        statusCode: 404,
        code: 'HTTP.NOT_FOUND',
        message: 'Resource not found',
        correlationId: expect.any(String),
      });
    });

    test('ArgumentInvalidException (no-op update) => 400 with code GENERIC.ARGUMENT_INVALID', async ({ request }) => {
      const created = await request.post('/api/v1/admin/departments', {
        headers: auth(tenantAdminToken),
        data: { name: `t776-argInvalid-${Date.now()}` },
      });
      expect(created.status()).toBe(201);
      const dept = trackDepartment(await created.json());
      expect(dept.version).toBe(1);

      // (FIXED) — a semantically empty update is now
      // DETERMINISTICALLY rejected, on the first PATCH of a freshly created row
      // as much as on any later one.
      //
      // `BaseService.updateEntity()` used to stamp `entity.updatedBy =
      // requestUser.id` BEFORE applying the DTO. That stamp routes through
      // change tracking, so on a new row (`updatedBy` NULL) it was a real value
      // transition: `hasChanges` became true, the guard at
      // department.service.ts:311 never fired, and the no-op write committed
      // (200, `_version` 1 -> 2, `updatedAt` rewritten, ResourceUpdated audit
      // row) — while the IDENTICAL second request returned 400, because by then
      // the stamp was value-identical. The contract was history-dependent, and
      // each phantom write invalidated other clients' ETags.
      //
      // The stamp now follows the DTO application and only runs when a real
      // change was staged, so both attempts below behave the same.
      const first = await request.patch(`/api/v1/admin/departments/${dept.id}`, {
        headers: { ...auth(tenantAdminToken), 'If-Match': '"1"' },
        data: { expectedVersion: 1 },
      });
      expect(first.status()).toBe(400);
      expect(await first.json()).toMatchObject({
        message: 'No changes to write to.',
        code: 'GENERIC.ARGUMENT_INVALID',
      });

      // No write happened: the version is untouched, so `If-Match: "1"` is still
      // the current ETag and the second identical no-op behaves identically.
      const res = await request.patch(`/api/v1/admin/departments/${dept.id}`, {
        headers: { ...auth(tenantAdminToken), 'If-Match': '"1"' },
        data: { expectedVersion: 1 },
      });
      expect(res.status()).toBe(400);
      const body = await res.json();
      expect(body).toMatchObject({
        message: 'No changes to write to.',
        code: 'GENERIC.ARGUMENT_INVALID',
      });
      expect(typeof body.correlationId).toBe('string');
    });

    test('OptimisticConcurrencyException (version drift) => 412 with code + metadata', async ({ request }) => {
      const created = await request.post('/api/v1/admin/departments', {
        headers: auth(tenantAdminToken),
        data: { name: `t776-occ-${Date.now()}` },
      });
      expect(created.status()).toBe(201);
      const dept = trackDepartment(await created.json());
      expect(dept.version).toBe(1);

      const staleVersion = 99;
      const res = await request.patch(`/api/v1/admin/departments/${dept.id}`, {
        headers: { ...auth(tenantAdminToken), 'If-Match': `"${staleVersion}"` },
        data: { description: 'stale write', expectedVersion: staleVersion },
      });
      expect(res.status()).toBe(412);
      const body = await res.json();
      expect(body.code).toBe('PERSISTENCE.CONCURRENCY_CONFLICT');
      expect(body.metadata).toMatchObject({ expectedVersion: staleVersion, currentVersion: 1 });
    });

    test('Prisma P2002 (unique constraint) => 409 with the sanitised unified-envelope body', async ({ request }) => {
      const key = `t776.p2002.${Date.now()}`;
      const payload = { name: 'T776 dup', key, value: '1', dataType: 'String' };

      const first = await request.post('/api/v1/admin/settings', {
        headers: auth(tenantAdminToken),
        data: payload,
      });
      expect(first.status()).toBe(201);

      // Plain duplicate create (no prior soft-delete) has no service-level
      // precheck for an ACTIVE collision — `GlobalSettingService.create` only
      // pre-checks for a DELETED row to resurrect — so the raw Prisma unique
      // violation reaches `ExceptionInterceptor`'s P2002 branch unmodified.
      const dup = await request.post('/api/v1/admin/settings', {
        headers: auth(tenantAdminToken),
        data: payload,
      });
      expect(dup.status()).toBe(409);
      const body = await dup.json();
      // DIVERGENCE: the briefed contract said "Prisma P2002 => 409" without
      // specifying a body shape beyond the general exception-mapping section.
      // The body is sanitised: it never carries the raw Prisma message or
      // `meta` (constraint/column names). Since REST review H-2 it DOES carry
      // the unified envelope — `message` and `code` were added, both derived
      // from the Prisma error CODE alone, never from its text.
      expect(body).toMatchObject({
        statusCode: 409,
        code: 'PERSISTENCE.UNIQUE_CONSTRAINT_VIOLATION',
        message: 'Unique constraint violation',
        error: 'Unique constraint violation',
      });
      expect(typeof body.correlationId).toBe('string');
      // The sanitisation this test exists for: no Prisma text reaches the client.
      expect(JSON.stringify(body)).not.toContain('Unique constraint failed');
    });

    test('Prisma P2025 (record not found) — DIVERGENCE: unreachable through the versioned-write path', async () => {
      // DIVERGENCE / FINDING (documented, not asserted against a live route):
      //
      // The briefed contract states "Prisma P2025 => 404" as a distinct exception-
      // mapping branch (`ExceptionInterceptor`'s Prisma-code switch does have a
      // `P2025` -> 404 case). In practice this branch appears to be **structurally
      // unreachable** for every OCC-versioned write path in this codebase:
      //
      //   1. Every service update/delete path calls `repository.findById(id)` FIRST,
      //      which itself throws the domain `DataNotFoundException` on a miss
      //      (packages/domains/src/common/repository.ts:109-116) — this is caught by
      //      a DEDICATED `ExceptionInterceptor` branch (order-sensitive, runs before
      //      the generic BaseException branch) and produces the DIFFERENT 404 body
      //      `{statusCode:404, code:'HTTP.NOT_FOUND', message:'Resource not found',
      //      correlationId}` (see the DataNotFoundException test above), not the
      //      Prisma-P2025 body (`code:'PERSISTENCE.RECORD_NOT_FOUND'`,
      //      `error:'Not found'`).
      //   2. The CAS write itself (`Repository.updateWithVersion`,
      //      packages/domains/src/common/repository.ts:208-249) uses Prisma
      //      `updateMany({ where: { id, version: expectedVersion } })`, which NEVER
      //      throws P2025 on zero matched rows (updateMany reports `count: 0`
      //      instead of throwing) — a 0-row result is translated into either
      //      `DataNotFoundException` (row gone entirely) or
      //      `OptimisticConcurrencyException` (row exists, version drifted; see the
      //      412 test above), never a raw Prisma error.
      //
      // No route in `apps/api/route-manifest.json`'s OCC surface (nor the
      // non-OCC admin CRUD routes inspected for this ticket) performs a bare
      // Prisma `update()`/`delete()` by id without a preceding `findById` guard,
      // so a live P2025 could not be produced without either (a) a raw two-writer
      // TOCTOU race against the SAME row between this test's own `findById` probe
      // and its write (non-deterministic, not a reliable e2e assertion), or
      // (b) constructing a request that bypasses the domain repository entirely
      // (out of scope — would require modifying production code, which this
      // ticket's instructions forbid).
      //
      // Recorded here as a documented finding rather than a fabricated assertion.
      expect(true).toBe(true);
    });
  });
});
