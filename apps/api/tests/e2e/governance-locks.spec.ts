/**
 * Harness policy governance locks — safetyEnabled / phiFailClosed are
 * GLOBAL_ADMIN-only, even on the tenant-scoped policy route (gap).
 *
 * `agentic-policy.spec.ts` (pattern) already covers the OCC chain on
 * `PATCH admin/harness/policy` (428/412/version-bump) and the `policy/global`
 * privilege wall for an ORDINARY knob (`maxRegen`, which is NOT one of the
 * locked fields). It never exercises the safety-flag lock itself. The
 * McpServer/AgentTrajectory RBAC-subject half of this governance surface is
 * already exercised by `mcp-admin.spec.ts` and `trajectory-admin.spec.ts`, so
 * this spec adds only the net-new half: the `safetyEnabled`/`phiFailClosed`
 * field lock.
 *
 * The lock (`HarnessPolicyService#assertNoGlobalAdminOnlyPolicyWrites`,
 * `GLOBAL_ADMIN_ONLY_POLICY_KEYS`) is a SERVICE-level field lock, not a route
 * decorator: `PATCH admin/harness/policy` is declared
 * `@Authorize(['manage', 'HarnessPolicy'])`, which a tenant admin legitimately
 * holds for every OTHER knob on this same row (thresholds, `maxRegen`, gate
 * timers). `updatePolicy` calls the lock UNCONDITIONALLY — it does not even
 * check `isSuperAdmin` — so a GLOBAL_ADMIN acting on a TENANT row (not the
 * `/policy/global` platform row) is equally rejected. The only legitimate path
 * to flip these two fields is `PATCH admin/harness/policy/global`
 * (`assertPlatform`, GLOBAL_ADMIN only). This is the
 * "declarative decorator understates the real gate" pattern documented in
 * `05-nestjs-api.mdc` §Imperative Privilege Checks.
 *
 * Live-stack requirement: dev/test stack + seed (`pnpm test:api:up` +
 * `pnpm test:e2e`). The tenant-row tests are all-403 (nothing is ever
 * persisted — the lock throws before any write, verified below by re-reading
 * the unchanged version). The one legitimate global-default flip is toggled
 * and then restored in the same test, since that row is shared platform
 * state, not a throwaway fixture.
 */
import { test, expect, APIRequestContext } from '@playwright/test';
import { DEFAULT_TENANT_KEY, SEEDED_USERS, loginUser } from '../../../../tests/helpers';

const HARNESS_POLICY = '/api/v1/admin/harness/policy';
const HARNESS_POLICY_GLOBAL = `${HARNESS_POLICY}/global`;

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

interface HarnessPolicy {
  version: number;
  safetyEnabled: boolean;
  phiFailClosed: boolean;
  entityFaithfulnessThreshold: number;
  source: string;
}

async function readPolicy(request: APIRequestContext, token: string, path: string): Promise<HarnessPolicy> {
  const resp = await request.get(path, { headers: bearer(token) });
  expect(resp.status(), `GET ${path}`).toBe(200);
  return (await resp.json()) as HarnessPolicy;
}

test.describe('harness policy governance locks — safetyEnabled / phiFailClosed', () => {
  let globalAdminToken: string;
  let tenantAdminToken: string;

  test.beforeAll(async ({ request }) => {
    const ga = await loginUser(request, SEEDED_USERS.superAdmin.username, SEEDED_USERS.superAdmin.password, DEFAULT_TENANT_KEY);
    expect(ga, `global admin login (${DEFAULT_TENANT_KEY}) failed — is the stack seeded?`).toBeTruthy();
    globalAdminToken = ga!.token;

    const ta = await loginUser(request, SEEDED_USERS.admin.username, SEEDED_USERS.admin.password, DEFAULT_TENANT_KEY);
    expect(ta, `tenant_admin login (${DEFAULT_TENANT_KEY}) failed`).toBeTruthy();
    tenantAdminToken = ta!.token;
  });

  test('a tenant admin cannot flip safetyEnabled on the tenant policy route (403, not the 428 header gate)', async ({ request }) => {
    const before = await readPolicy(request, tenantAdminToken, HARNESS_POLICY);
    const resp = await request.patch(HARNESS_POLICY, {
      headers: { ...bearer(tenantAdminToken), 'If-Match': `"${before.version}"` },
      data: { safetyEnabled: !before.safetyEnabled },
    });
    expect(resp.status()).toBe(403);
  });

  test('a tenant admin cannot flip phiFailClosed on the tenant policy route (403, not the 428 header gate)', async ({ request }) => {
    const before = await readPolicy(request, tenantAdminToken, HARNESS_POLICY);
    const resp = await request.patch(HARNESS_POLICY, {
      headers: { ...bearer(tenantAdminToken), 'If-Match': `"${before.version}"` },
      data: { phiFailClosed: !before.phiFailClosed },
    });
    expect(resp.status()).toBe(403);
  });

  test('the lock rejects the WHOLE patch when a locked key rides along with an unlocked one — nothing is written', async ({ request }) => {
    const before = await readPolicy(request, tenantAdminToken, HARNESS_POLICY);
    const resp = await request.patch(HARNESS_POLICY, {
      headers: { ...bearer(tenantAdminToken), 'If-Match': `"${before.version}"` },
      data: { entityFaithfulnessThreshold: 0.9, safetyEnabled: !before.safetyEnabled },
    });
    expect(resp.status()).toBe(403);

    const after = await readPolicy(request, tenantAdminToken, HARNESS_POLICY);
    expect(after.version, 'a rejected patch must not bump the version or change any field').toBe(before.version);
    expect(after.entityFaithfulnessThreshold).toBe(before.entityFaithfulnessThreshold);
  });

  test('the same lock holds for a GLOBAL_ADMIN acting on the TENANT policy route — a field lock, not merely a role check', async ({ request }) => {
    const before = await readPolicy(request, globalAdminToken, HARNESS_POLICY);
    const resp = await request.patch(HARNESS_POLICY, {
      headers: { ...bearer(globalAdminToken), 'If-Match': `"${before.version}"` },
      data: { safetyEnabled: !before.safetyEnabled },
    });
    expect(resp.status()).toBe(403);
  });

  test('a tenant admin can still patch an unlocked clinical threshold on the same route (the lock is scoped, not blanket)', async ({ request }) => {
    const before = await readPolicy(request, tenantAdminToken, HARNESS_POLICY);
    const nextThreshold = before.entityFaithfulnessThreshold >= 0.5 ? 0.4 : 0.6;
    const resp = await request.patch(HARNESS_POLICY, {
      headers: { ...bearer(tenantAdminToken), 'If-Match': `"${before.version}"` },
      data: { entityFaithfulnessThreshold: nextThreshold, reason: `e2e governance-locks ${Date.now()}` },
    });
    expect(resp.status()).toBe(200);
    expect(((await resp.json()) as HarnessPolicy).entityFaithfulnessThreshold).toBe(nextThreshold);
  });

  test('a GLOBAL_ADMIN can flip safetyEnabled — but only through the platform GLOBAL-DEFAULT route', async ({ request }) => {
    const before = await readPolicy(request, globalAdminToken, HARNESS_POLICY_GLOBAL);
    const flipped = !before.safetyEnabled;

    const flip = await request.patch(HARNESS_POLICY_GLOBAL, {
      headers: { ...bearer(globalAdminToken), 'If-Match': `"${before.version}"` },
      data: { safetyEnabled: flipped, reason: `e2e governance-locks ${Date.now()}` },
    });
    expect(flip.status()).toBe(200);
    expect(((await flip.json()) as HarnessPolicy).safetyEnabled).toBe(flipped);

    // Restore — this is shared platform state, not a throwaway row.
    const after = await readPolicy(request, globalAdminToken, HARNESS_POLICY_GLOBAL);
    const restore = await request.patch(HARNESS_POLICY_GLOBAL, {
      headers: { ...bearer(globalAdminToken), 'If-Match': `"${after.version}"` },
      data: { safetyEnabled: before.safetyEnabled, reason: `e2e governance-locks restore ${Date.now()}` },
    });
    expect(restore.status()).toBe(200);
    expect(((await restore.json()) as HarnessPolicy).safetyEnabled).toBe(before.safetyEnabled);
  });
});
