/**
 * TASK-776 / REST review H-1 phase 2 — the seven TIER-A routes now require `If-Match`.
 *
 * Tier A was the set of PATCH/PUT routes whose response DTO carries `version`,
 * so `ETagInterceptor` emitted a strong `ETag` on the corresponding GET — and
 * whose write path then IGNORED the `If-Match` a conforming client echoed back.
 * That is strictly worse than emitting no validator at all: the client did what
 * RFC 9110 asks, believed the write was conditional, and still lost the update.
 *
 * The seven routes (verbatim from the boot audit
 * `apps/api/src/bootstrap/occ-coverage-audit.ts` before the flip):
 *
 *   PATCH /consultations/:id
 *   PATCH /dna-writing-styles/:reportId/default
 *   PUT   /dna-writing-styles/settings
 *   PATCH /admin/entitlements/plans/:plan
 *   PUT   /admin/entitlements/tenants/:tenantId/override
 *   PUT   /admin/tenants/:id/tags
 *   PUT   /admin/tenant-idp-config/:id/directory-credentials
 *
 * Each gets the same three-assertion contract, run against the LIVE gateway:
 *
 *   | request                | expected                                                    |
 *   |------------------------|-------------------------------------------------------------|
 *   | no `If-Match`          | 428 `HTTP.PRECONDITION_REQUIRED`                            |
 *   | stale `If-Match`       | 412 `PERSISTENCE.CONCURRENCY_CONFLICT`, and NO write lands  |
 *   | correct `If-Match`     | 2xx, and `_version` increments                              |
 *
 * Two routes are create-or-update and use the gateway's create-intent
 * validator `If-Match: "0"` (`expectedVersion.decorator.ts` — a GET on a
 * not-yet-materialized row answers `version: 0`): the entitlement override and
 * the per-doctor DNA settings row.
 *
 * CLEANUP is id-tracked per worker (`test.afterAll` runs once per worker), never
 * by name prefix — a prefix predicate deletes rows a sibling worker is still
 * using. Seeded rows this spec mutates (the TRIAL plan matrix, the doctor's
 * default DNA report) are restored explicitly.
 */

import { test, expect, type APIRequestContext } from '@playwright/test';
import { DEFAULT_TENANT_KEY, SEEDED_USERS, loginUser } from '../../../../tests/helpers';

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
const ifMatch = (version: number) => ({ 'If-Match': `"${version}"` });

/** Rows created by THIS worker, torn down in `afterAll`. */
const createdTenantIds: string[] = [];
const createdDepartmentIds: string[] = [];
const createdIdpProviderIds: string[] = [];

function unique(label: string): string {
  return `t776occ-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function expect428(res: import('@playwright/test').APIResponse, what: string) {
  expect(res.status(), `${what}: a missing If-Match must be 428, not a silent success`).toBe(428);
  expect(await res.json()).toMatchObject({
    statusCode: 428,
    code: 'HTTP.PRECONDITION_REQUIRED',
    message: 'If-Match header is required for this operation.',
  });
}

async function expect412(res: import('@playwright/test').APIResponse, what: string) {
  expect(res.status(), `${what}: a stale If-Match must be 412`).toBe(412);
  const body = await res.json();
  expect(body.statusCode).toBe(412);
  expect(body.code).toBe('PERSISTENCE.CONCURRENCY_CONFLICT');
}

test.describe('TASK-776 H-1 phase 2: tier-A routes enforce If-Match', () => {
  let superToken: string;
  let doctorToken: string;

  test.beforeAll(async ({ request }) => {
    const [superAdmin, doctor] = await Promise.all([
      loginUser(request, SEEDED_USERS.superAdmin.username, SEEDED_USERS.superAdmin.password, DEFAULT_TENANT_KEY),
      loginUser(request, SEEDED_USERS.doctor.username, SEEDED_USERS.doctor.password, DEFAULT_TENANT_KEY),
    ]);
    expect(superAdmin, 'super_admin login must succeed').not.toBeNull();
    expect(doctor, 'doctor login must succeed').not.toBeNull();
    superToken = superAdmin!.token;
    doctorToken = doctor!.token;
  });

  test.afterAll(async ({ request }) => {
    for (const id of createdIdpProviderIds.splice(0)) {
      await request.delete(`/api/v1/admin/tenant-idp-config/${id}`, { headers: bearer(superToken) });
    }
    for (const id of createdTenantIds.splice(0)) {
      // Clears the entitlement override too — the tenant row owns it.
      await request.delete(`/api/v1/admin/entitlements/tenants/${id}/override`, { headers: bearer(superToken) });
      await request.delete(`/api/v1/admin/tenants/${id}`, { headers: bearer(superToken) });
    }
    for (const id of createdDepartmentIds.splice(0)) {
      await request.delete(`/api/v1/admin/departments/${id}`, { headers: bearer(superToken) });
    }
  });

  async function createTenant(request: APIRequestContext): Promise<{ id: string; version: number }> {
    // `Tenant.key` is globally `@unique` (soft-deleted rows included), so the
    // key must stay unique across parallel workers AND earlier runs against the
    // same DB. Truncating `unique()` to 24 chars used to cut BOTH the random
    // suffix and the last two timestamp digits, leaving 100ms resolution and no
    // entropy — two tenants created in the same window collided on 409. Build
    // the key inside the 24-char budget instead of trimming entropy off it.
    const key = `t776occ${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    const res = await request.post('/api/v1/admin/tenants', {
      headers: bearer(superToken),
      data: { name: `T776 OCC ${key}`, key },
    });
    expect([200, 201], 'tenant create must succeed').toContain(res.status());
    const tenant = (await res.json()) as { id: string; version: number };
    createdTenantIds.push(tenant.id);
    return tenant;
  }

  // ==========================================================================
  // PUT /admin/tenants/:id/tags
  // ==========================================================================

  test.describe('PUT /admin/tenants/:id/tags', () => {
    test('missing / stale / correct If-Match', async ({ request }) => {
      const tenant = await createTenant(request);

      await expect428(
        await request.put(`/api/v1/admin/tenants/${tenant.id}/tags`, { headers: bearer(superToken), data: { tags: ['a'] } }),
        'tenant tags',
      );

      await expect412(
        await request.put(`/api/v1/admin/tenants/${tenant.id}/tags`, {
          headers: { ...bearer(superToken), ...ifMatch(tenant.version + 99) },
          data: { tags: ['stale-write'] },
        }),
        'tenant tags',
      );

      // The 412 must have written NOTHING.
      const afterStale = await request.get(`/api/v1/admin/tenants/${tenant.id}/tags`, { headers: bearer(superToken) });
      expect(((await afterStale.json()) as { tags: string[] }).tags, 'a rejected precondition writes nothing').toEqual([]);

      const ok = await request.put(`/api/v1/admin/tenants/${tenant.id}/tags`, {
        headers: { ...bearer(superToken), ...ifMatch(tenant.version) },
        data: { tags: ['priority', 'vip'] },
      });
      expect(ok.status()).toBe(200);
      const body = (await ok.json()) as { version: number; tags: string[] };
      expect(body.tags.slice().sort()).toEqual(['priority', 'vip']);
      expect(body.version, 'a successful CAS increments _version').toBe(tenant.version + 1);
    });

    test('the precondition is evaluated BEFORE the no-changes short-circuit', async ({ request }) => {
      // `TenantService.setTags` returns early when the tag set is unchanged.
      // Re-sending the SAME set with a stale validator must still 412 — RFC 7232
      // evaluates preconditions independently of what the payload would change.
      const tenant = await createTenant(request);
      const first = await request.put(`/api/v1/admin/tenants/${tenant.id}/tags`, {
        headers: { ...bearer(superToken), ...ifMatch(tenant.version) },
        data: { tags: ['same'] },
      });
      expect(first.status()).toBe(200);

      await expect412(
        await request.put(`/api/v1/admin/tenants/${tenant.id}/tags`, {
          headers: { ...bearer(superToken), ...ifMatch(tenant.version) }, // now stale by one
          data: { tags: ['same'] }, // ... and a no-op payload
        }),
        'tenant tags (idempotent payload)',
      );
    });
  });

  // ==========================================================================
  // PUT /admin/entitlements/tenants/:tenantId/override  (create-or-update)
  // ==========================================================================

  test('PUT /admin/entitlements/tenants/:tenantId/override — "0" creates, then the version chains', async ({ request }) => {
    const tenant = await createTenant(request);

    await expect428(
      await request.put(`/api/v1/admin/entitlements/tenants/${tenant.id}/override`, {
        headers: bearer(superToken),
        data: { maxUsers: 5 },
      }),
      'entitlement override',
    );

    // No row yet: the override GET answers null (no ETag), so the FIRST write
    // carries the create-intent validator `"0"`.
    const created = await request.put(`/api/v1/admin/entitlements/tenants/${tenant.id}/override`, {
      headers: { ...bearer(superToken), ...ifMatch(0) },
      data: { maxUsers: 5 },
    });
    expect(created.status()).toBe(200);
    const createdBody = (await created.json()) as { version: number; maxUsers: number | null };
    expect(createdBody.maxUsers).toBe(5);
    expect(createdBody.version).toBe(1);

    // `"0"` against a row that now exists is stale, not a second create.
    await expect412(
      await request.put(`/api/v1/admin/entitlements/tenants/${tenant.id}/override`, {
        headers: { ...bearer(superToken), ...ifMatch(0) },
        data: { maxUsers: 99 },
      }),
      'entitlement override (create-intent against an existing row)',
    );

    const updated = await request.put(`/api/v1/admin/entitlements/tenants/${tenant.id}/override`, {
      headers: { ...bearer(superToken), ...ifMatch(createdBody.version) },
      data: { maxUsers: 7 },
    });
    expect(updated.status()).toBe(200);
    const updatedBody = (await updated.json()) as { version: number; maxUsers: number | null };
    expect(updatedBody.maxUsers).toBe(7);
    expect(updatedBody.version).toBe(createdBody.version + 1);
  });

  // ==========================================================================
  // PATCH /admin/entitlements/plans/:plan
  // ==========================================================================

  test('PATCH /admin/entitlements/plans/:plan', async ({ request }) => {
    const read = await request.get('/api/v1/admin/entitlements/plans/TRIAL', { headers: bearer(superToken) });
    expect(read.status()).toBe(200);
    const plan = (await read.json()) as { version: number; modelTier: string | null };
    expect(read.headers()['etag'], 'the plan row advertises a strong ETag — that is what made it tier A').toBe(`"${plan.version}"`);

    await expect428(
      await request.patch('/api/v1/admin/entitlements/plans/TRIAL', {
        headers: bearer(superToken),
        data: { expectedVersion: plan.version },
      }),
      'plan entitlement',
    );

    await expect412(
      await request.patch('/api/v1/admin/entitlements/plans/TRIAL', {
        headers: { ...bearer(superToken), ...ifMatch(plan.version + 99) },
        data: { expectedVersion: plan.version },
      }),
      'plan entitlement',
    );

    // A deliberately value-preserving edit: this row is platform-wide seeded
    // config, so the assertion is about the version chain, not the payload.
    const ok = await request.patch('/api/v1/admin/entitlements/plans/TRIAL', {
      headers: { ...bearer(superToken), ...ifMatch(plan.version) },
      data: { expectedVersion: plan.version },
    });
    expect(ok.status()).toBe(200);
    const after = (await ok.json()) as { version: number; modelTier: string | null };
    expect(after.version).toBe(plan.version + 1);
    expect(after.modelTier, 'the no-op edit preserves the seeded value').toBe(plan.modelTier);
  });

  // ==========================================================================
  // PATCH /consultations/:id  — the clinician-facing one, flipped LAST
  // ==========================================================================

  test('PATCH /consultations/:id', async ({ request }) => {
    const opened = await request.post('/api/v1/consultations/open', {
      headers: bearer(doctorToken),
      data: { patientId: unique('patient') },
    });
    expect([200, 201]).toContain(opened.status());
    const consultation = (await opened.json()) as { id: string; version: number };

    await expect428(
      await request.patch(`/api/v1/consultations/${consultation.id}`, {
        headers: bearer(doctorToken),
        data: { metadata: { note: 'no header' } },
      }),
      'consultation update',
    );

    await expect412(
      await request.patch(`/api/v1/consultations/${consultation.id}`, {
        headers: { ...bearer(doctorToken), ...ifMatch(consultation.version + 99) },
        data: { metadata: { note: 'stale write' } },
      }),
      'consultation update',
    );

    const afterStale = await request.get(`/api/v1/consultations/${consultation.id}`, { headers: bearer(doctorToken) });
    const staleBody = (await afterStale.json()) as { version: number; metadata?: Record<string, unknown> };
    expect(staleBody.version, 'neither rejected request may bump the row').toBe(consultation.version);
    expect(staleBody.metadata?.note, 'the stale write must not have landed').toBeUndefined();

    const ok = await request.patch(`/api/v1/consultations/${consultation.id}`, {
      headers: { ...bearer(doctorToken), ...ifMatch(consultation.version) },
      data: { metadata: { note: 'accepted' } },
    });
    expect(ok.status()).toBe(200);
    const okBody = (await ok.json()) as { version: number; metadata?: Record<string, unknown> };
    expect(okBody.metadata?.note).toBe('accepted');
    // The response must carry the POST-write version: a client chaining
    // If-Match off this body would otherwise 412 on its very next write.
    expect(okBody.version, 'the response reports the freshly-persisted version').toBe(consultation.version + 1);
  });

  // ==========================================================================
  // PUT /dna-writing-styles/settings  (create-or-update, doctor self-service)
  // ==========================================================================

  test('PUT /dna-writing-styles/settings', async ({ request }) => {
    const read = await request.get('/api/v1/dna-writing-styles/settings', { headers: bearer(doctorToken) });
    expect(read.status()).toBe(200);
    const settings = (await read.json()) as { version: number; doctorToggle: boolean | null };
    const original = settings.doctorToggle;

    await expect428(
      await request.put('/api/v1/dna-writing-styles/settings', { headers: bearer(doctorToken), data: { enabled: false } }),
      'dna settings',
    );

    await expect412(
      await request.put('/api/v1/dna-writing-styles/settings', {
        headers: { ...bearer(doctorToken), ...ifMatch(settings.version + 99) },
        data: { enabled: false },
      }),
      'dna settings',
    );

    // `GET settings` answers `version: 0` while no DOCTOR-scope PipelinePolicy
    // row exists, and `"0"` is the create-intent validator for exactly that.
    const ok = await request.put('/api/v1/dna-writing-styles/settings', {
      headers: { ...bearer(doctorToken), ...ifMatch(settings.version) },
      data: { enabled: original === false ? true : false },
    });
    expect(ok.status()).toBe(200);
    const okBody = (await ok.json()) as { version: number; doctorToggle: boolean | null };
    expect(okBody.version, 'the write materializes/bumps the row').toBeGreaterThan(settings.version);

    // Restore the seeded toggle so a re-run (RESET_DB=false) starts clean.
    const restore = await request.put('/api/v1/dna-writing-styles/settings', {
      headers: { ...bearer(doctorToken), ...ifMatch(okBody.version) },
      data: { enabled: original },
    });
    expect(restore.status()).toBe(200);
  });

  // ==========================================================================
  // PATCH /dna-writing-styles/:reportId/default
  // ==========================================================================

  test('PATCH /dna-writing-styles/:reportId/default', async ({ request }) => {
    const list = await request.get('/api/v1/dna-writing-styles/mine', { headers: bearer(doctorToken) });
    expect(list.status()).toBe(200);
    const reports = (await list.json()) as Array<{ id: string; version: number; isLatest: boolean }>;
    const currentDefault = reports.find((r) => r.isLatest);
    const promotable = reports.find((r) => !r.isLatest);
    expect(currentDefault, 'seed precondition: the doctor has a default DNA report').toBeDefined();
    expect(promotable, 'seed precondition: the doctor has a non-default DNA report to promote').toBeDefined();

    await expect428(await request.patch(`/api/v1/dna-writing-styles/${promotable!.id}/default`, { headers: bearer(doctorToken) }), 'dna set-default');

    await expect412(
      await request.patch(`/api/v1/dna-writing-styles/${promotable!.id}/default`, {
        headers: { ...bearer(doctorToken), ...ifMatch(promotable!.version + 99) },
      }),
      'dna set-default',
    );

    const stillNotDefault = (await (await request.get('/api/v1/dna-writing-styles/mine', { headers: bearer(doctorToken) })).json()) as Array<{
      id: string;
      isLatest: boolean;
    }>;
    expect(stillNotDefault.find((r) => r.id === promotable!.id)?.isLatest, 'a rejected precondition must not promote').toBe(false);

    const ok = await request.patch(`/api/v1/dna-writing-styles/${promotable!.id}/default`, {
      headers: { ...bearer(doctorToken), ...ifMatch(promotable!.version) },
    });
    expect(ok.status()).toBe(200);
    const okBody = (await ok.json()) as { version: number; isLatest: boolean };
    expect(okBody.isLatest).toBe(true);
    expect(okBody.version).toBe(promotable!.version + 1);

    // Restore the seeded default (the demoted row's version moved too, so re-read).
    const afterList = (await (await request.get('/api/v1/dna-writing-styles/mine', { headers: bearer(doctorToken) })).json()) as Array<{
      id: string;
      version: number;
    }>;
    const restoreTarget = afterList.find((r) => r.id === currentDefault!.id);
    const restore = await request.patch(`/api/v1/dna-writing-styles/${restoreTarget!.id}/default`, {
      headers: { ...bearer(doctorToken), ...ifMatch(restoreTarget!.version) },
    });
    expect(restore.status(), 'restore the seeded default report').toBe(200);
  });

  // ==========================================================================
  // PUT /admin/tenant-idp-config/:id/directory-credentials
  // ==========================================================================

  test('PUT /admin/tenant-idp-config/:id/directory-credentials', async ({ request }) => {
    // The route's OWN Swagger used to say "No If-Match (a narrow secret
    // rotation)" while its sibling `PUT :id` required one — a one-line
    // divergence inside a single aggregate, which is exactly the per-ROUTE
    // (not per-RESOURCE) disease H-1 names.
    const deptRes = await request.post('/api/v1/admin/departments', {
      headers: bearer(superToken),
      data: { name: unique('idp-dept') },
    });
    expect(deptRes.status()).toBe(201);
    const department = (await deptRes.json()) as { id: string };
    createdDepartmentIds.push(department.id);

    const rolesRes = await request.get('/api/v1/admin/rbac/roles', { headers: bearer(superToken) });
    expect(rolesRes.status()).toBe(200);
    const rolesBody = (await rolesRes.json()) as { data?: Array<{ id: string }> } | Array<{ id: string }>;
    const roles = Array.isArray(rolesBody) ? rolesBody : (rolesBody.data ?? []);
    expect(roles.length, 'seed precondition: at least one role exists for defaultRoleId').toBeGreaterThan(0);

    const createRes = await request.post('/api/v1/admin/tenant-idp-config', {
      headers: bearer(superToken),
      data: {
        protocol: 'OIDC',
        displayName: unique('idp'),
        clientSecret: 'e2e-placeholder-secret',
        config: {
          issuer: 'https://idp.example.test',
          clientId: 'e2e-client',
          defaultRoleId: roles[0]!.id,
          defaultDepartmentId: department.id,
        },
      },
    });
    expect([200, 201], 'identity-provider create must succeed').toContain(createRes.status());
    const provider = (await createRes.json()) as { id: string; version: number };
    createdIdpProviderIds.push(provider.id);

    const credentials = { azureTenantId: 'e2e-tenant', clientId: 'e2e-client', clientSecret: 'e2e-secret' };

    await expect428(
      await request.put(`/api/v1/admin/tenant-idp-config/${provider.id}/directory-credentials`, {
        headers: bearer(superToken),
        data: { credentials },
      }),
      'directory credentials',
    );

    await expect412(
      await request.put(`/api/v1/admin/tenant-idp-config/${provider.id}/directory-credentials`, {
        headers: { ...bearer(superToken), ...ifMatch(provider.version + 99) },
        data: { credentials },
      }),
      'directory credentials',
    );

    const ok = await request.put(`/api/v1/admin/tenant-idp-config/${provider.id}/directory-credentials`, {
      headers: { ...bearer(superToken), ...ifMatch(provider.version) },
      data: { credentials },
    });
    expect(ok.status()).toBe(200);
    expect(((await ok.json()) as { version: number }).version).toBe(provider.version + 1);
  });
});
