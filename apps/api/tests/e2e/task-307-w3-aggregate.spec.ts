/**
 * Aggregator suite for the cross-tenant decorator rollout.
 *
 * Provides a single, end-to-end audit pass that touches every endpoint the
 * `@TenantOwnedResource(...)` decorator protects, so reviewers and CI
 * dashboards can verify tenant isolation in one suite. The per-controller
 * specs
 * (`task-307-{consultation-job,tenant-bucket,storage,voice-profile,
 *  transcription-job}-cross-tenant.spec.ts`) carry the deeper assertions;
 * this file only confirms each protected route returns 404 (not 200 / 500)
 * for an out-of-tenant probe.
 *
 * Run together with the per-controller specs in this directory
 * (`task-307-*-cross-tenant.spec.ts`) for full coverage of the rollout.
 */
import { test, expect, type APIRequestContext } from '@playwright/test';
import { DEFAULT_TENANT_KEY, SEEDED_USERS, loginUser } from '../../../../tests/helpers';

/**
 * Which seeded principal drives each probe. The cross-tenant ownership 404
 * lives BEHIND the route's base authorization, so the probing identity must
 * already hold the route's base permission — otherwise authz short-circuits
 * with 403 and we never exercise the `@TenantOwnedResource` 404 path.
 *
 *   - doctor       — owns consultation/voice/transcription read+mutate perms.
 *   - tenantAdmin  — holds read:Storage / delete:Storage (storage/* routes).
 *   - superAdmin   — holds manage:Tenant (admin/tenants/* routes).
 */
type Principal = 'doctor' | 'tenantAdmin' | 'superAdmin';

interface ProbeCase {
  name: string;
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  path: string;
  /** Identity with the base permission so the ownership 404 is reachable. */
  principal: Principal;
  /** Acceptable response shapes — 404 is preferred (DEF-C3 no-existence-leak). */
  expectStatuses: ReadonlyArray<number>;
}

const UUIDV7_PROBE = '018f0000-0000-7900-8000-000000000000';

const CASES: ReadonlyArray<ProbeCase> = [
  {
    name: 'W3.4 — GET consultations/jobs/:jobId',
    method: 'GET',
    path: `/api/v1/consultations/jobs/${UUIDV7_PROBE}`,
    principal: 'doctor',
    expectStatuses: [404],
  },
  {
    name: 'W3.4 — PATCH consultations/jobs/:jobId/cancel',
    method: 'PATCH',
    path: `/api/v1/consultations/jobs/${UUIDV7_PROBE}/cancel`,
    principal: 'doctor',
    expectStatuses: [404],
  },
  {
    name: 'W3.5 — GET admin/tenants/storage/buckets/:id',
    method: 'GET',
    path: `/api/v1/admin/tenants/storage/buckets/${UUIDV7_PROBE}`,
    principal: 'superAdmin',
    expectStatuses: [404],
  },
  {
    name: 'W3.5 — DELETE admin/tenants/storage/buckets/:id',
    method: 'DELETE',
    path: `/api/v1/admin/tenants/storage/buckets/${UUIDV7_PROBE}`,
    principal: 'superAdmin',
    expectStatuses: [404],
  },
  {
    name: 'W3.6 — GET storage/buckets/:name',
    method: 'GET',
    // Seed slug is `recordings` (was `audio`).
    path: '/api/v1/storage/buckets/hope-recordings-arcaai',
    principal: 'tenantAdmin',
    expectStatuses: [404],
  },
  {
    name: 'W3.6 — DELETE storage/buckets/:name',
    method: 'DELETE',
    path: '/api/v1/storage/buckets/hope-attachments-arcaai',
    principal: 'tenantAdmin',
    expectStatuses: [404],
  },
  {
    name: 'W3.7 — PATCH voice-profile/:id/activate',
    method: 'PATCH',
    path: `/api/v1/voice-profile/${UUIDV7_PROBE}/activate`,
    principal: 'doctor',
    expectStatuses: [404],
  },
  {
    name: 'W3.7 — DELETE voice-profile/:id',
    method: 'DELETE',
    path: `/api/v1/voice-profile/${UUIDV7_PROBE}`,
    principal: 'doctor',
    expectStatuses: [404],
  },
  {
    name: 'W3.8 — GET audio/transcription-jobs/:id',
    method: 'GET',
    path: `/api/v1/audio/transcription-jobs/${UUIDV7_PROBE}`,
    principal: 'doctor',
    expectStatuses: [404],
  },
  {
    name: 'W3.8 — POST audio/transcription-jobs/:id/cancel',
    method: 'POST',
    path: `/api/v1/audio/transcription-jobs/${UUIDV7_PROBE}/cancel`,
    principal: 'doctor',
    expectStatuses: [404],
  },
];

async function probe(request: APIRequestContext, token: string, c: ProbeCase): Promise<number> {
  const headers = { Authorization: `Bearer ${token}` };
  switch (c.method) {
    case 'GET':
      return (await request.get(c.path, { headers })).status();
    case 'POST':
      return (await request.post(c.path, { headers, data: {} })).status();
    case 'PATCH':
      return (await request.patch(c.path, { headers, data: {} })).status();
    case 'DELETE':
      return (await request.delete(c.path, { headers })).status();
  }
}

test.describe('TASK-307 W3.9 — aggregate cross-tenant audit', () => {
  const tokens: Record<Principal, string> = {
    doctor: '',
    tenantAdmin: '',
    superAdmin: '',
  };

  test.beforeAll(async ({ request }) => {
    const doctor = await loginUser(request, SEEDED_USERS.doctor.username, SEEDED_USERS.doctor.password, DEFAULT_TENANT_KEY);
    expect(doctor, 'doctor login (tenant __GLOBAL__) failed').toBeTruthy();
    tokens.doctor = doctor!.token;

    const tenantAdmin = await loginUser(request, SEEDED_USERS.admin.username, SEEDED_USERS.admin.password, DEFAULT_TENANT_KEY);
    expect(tenantAdmin, 'tenant_admin login (tenant __GLOBAL__) failed').toBeTruthy();
    tokens.tenantAdmin = tenantAdmin!.token;

    const superAdmin = await loginUser(request, SEEDED_USERS.superAdmin.username, SEEDED_USERS.superAdmin.password);
    expect(superAdmin, 'super_admin login failed').toBeTruthy();
    tokens.superAdmin = superAdmin!.token;
  });

  for (const c of CASES) {
    test(c.name, async ({ request }) => {
      const status = await probe(request, tokens[c.principal], c);
      expect(c.expectStatuses).toContain(status);
    });
  }
});
