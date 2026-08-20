/**
 * TASK-779 area 1 — POLICY: the authorization + config-policy surface, at the wire.
 *
 * Three things this file pins, none of which had e2e evidence before:
 *
 * 1. **The TASK-712 `CASL_ENFORCED_PAIRS` entries for `ApiKey` are inert.**
 *    `policy.engine.ts` enforces `read`/`update`/`delete:ApiKey`: for a route
 *    carrying `@ResolveSubjectInstance(...)`, a `false` instance verdict is
 *    supposed to become a 403 "privilege" denial. On this controller it never
 *    can. `ApiKeyController.resolveApiKeyInstance` resolves the instance by
 *    calling `IApiKeyService.fetchById(id)`, and that service call itself runs
 *    `assertKeyAccess`, which throws `NotFoundException` for a key the caller
 *    does not own. So on exactly the request the enforce pair exists to deny,
 *    the RESOLVER throws first; `UnifiedAuthGuard.runCaslInstanceChecks`
 *    swallows resolver throws (its documented fail-open path), returns no
 *    denial, and the handler answers the service's own 404. And where the
 *    resolver succeeds, the caller has already passed `assertKeyAccess`, so the
 *    instance verdict is necessarily true.
 *
 *    This is NOT a hole — 404 hides existence, which is strictly stronger than
 *    403 — so the assertions below pin the 404, not an aspirational 403. They
 *    additionally read `/metrics` around the probe and prove
 *    `casl_enforce_denial_total` does not move, which is the direct evidence
 *    that the 404 came from the SERVICE and not from the enforce path. The
 *    consequence worth remembering: that counter can never increment, so a
 *    future "measure, then enforce more pairs" reading of it is vacuous.
 *
 * 2. **403 and 404 are different postures and the platform really distinguishes
 *    them.** Asserting only 404s would leave "we return 404 for everything"
 *    indistinguishable from a correct implementation. So this file exercises two
 *    genuine 403 PRIVILEGE boundaries alongside the 404s: the API-key minting
 *    ceiling (`assertScopeCeiling`), and a tenant admin reaching for another
 *    tenant's configuration.
 *
 * 3. **Config resolution is exactly two tiers: request tenant → SYSTEM.** Proven
 *    as an invariant over the WHOLE `AI_TASK_KEYS` registry rather than one
 *    hand-picked key, and READ-ONLY (this surface has no delete route, so a
 *    write would leave residue).
 *
 * Prerequisites: API running against the test DB and seeded. Run with
 * `RESET_DB=false` against an already-seeded stack.
 */
import { test, expect, type APIRequestContext } from '@playwright/test';
import { DEFAULT_TENANT_KEY, SEEDED_USERS, loginUser } from '../../../../tests/helpers';

const bearer = (token: string, tenantId?: string) => ({
  Authorization: `Bearer ${token}`,
  ...(tenantId ? { 'X-Tenant-Id': tenantId } : {}),
});

/** The SYSTEM config TIER. Never a customer tenant. */
const SYSTEM_TENANT_ID = '00000000-0000-0000-0000-000000000000';

let doctorToken: string; // owner-only clinician: holds `api-key-own-manage` only
let doctor2Token: string; // a DIFFERENT owner-only clinician in the SAME tenant
let tenantAdminToken: string; // `manage:ApiKey`, tenant-scoped
let superAdminToken: string;
let ownTenantId: string;
let foreignTenantId: string;

const createdKeyIds: string[] = [];

async function createOwnKey(request: APIRequestContext, token: string, label: string): Promise<string> {
  const response = await request.post('/api/v1/admin/api-keys', {
    headers: bearer(token),
    data: { keyName: `t779-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, keyType: 'SDK', scopes: ['stt:transcription:read'] },
  });
  expect(response.status(), `minting fixture key "${label}"`).toBe(201);
  const id = (await response.json()).apiKey.id as string;
  createdKeyIds.push(id);
  return id;
}

/**
 * Total of every `casl_enforce_denial_total` sample currently exposed. The
 * counter is registered at module load, so the HELP/TYPE lines are always
 * present; a metric with no labelled sample simply has no value lines, and this
 * returns 0. Comparing a BEFORE/AFTER delta (rather than asserting an absolute
 * zero) keeps the assertion honest if another spec ever legitimately trips it.
 */
async function readEnforceDenialTotal(request: APIRequestContext): Promise<number> {
  const response = await request.get('http://localhost:8968/metrics');
  expect(response.status(), 'GET /metrics').toBe(200);
  const body = await response.text();
  return body
    .split('\n')
    .filter((line) => line.startsWith('casl_enforce_denial_total{'))
    .reduce((sum, line) => sum + Number(line.trim().split(/\s+/).pop() ?? 0), 0);
}

test.beforeAll(async ({ request }) => {
  const [doc, doc2, admin, sa] = await Promise.all([
    loginUser(request, SEEDED_USERS.doctor.username, SEEDED_USERS.doctor.password, DEFAULT_TENANT_KEY),
    loginUser(request, SEEDED_USERS.doctor2.username, SEEDED_USERS.doctor2.password, DEFAULT_TENANT_KEY),
    loginUser(request, SEEDED_USERS.admin.username, SEEDED_USERS.admin.password, DEFAULT_TENANT_KEY),
    loginUser(request, SEEDED_USERS.superAdmin.username, SEEDED_USERS.superAdmin.password),
  ]);
  expect(doc?.token, 'doctor login failed — is the stack seeded?').toBeTruthy();
  expect(doc2?.token, 'doctor2 login failed').toBeTruthy();
  expect(admin?.token, 'tenant_admin login failed').toBeTruthy();
  expect(sa?.token, 'super_admin login failed').toBeTruthy();
  doctorToken = doc!.token;
  doctor2Token = doc2!.token;
  tenantAdminToken = admin!.token;
  superAdminToken = sa!.token;

  // Discover tenants rather than hardcoding ids: `ownTenantId` is the tenant the
  // seeded clinicians live in, `foreignTenantId` is any OTHER customer tenant.
  const tenants = await request.get('/api/v1/admin/tenants?page=0&limit=50', { headers: bearer(superAdminToken) });
  expect(tenants.status(), 'list tenants').toBe(200);
  const rows = ((await tenants.json()).data as Array<{ id: string }>).filter((t) => t.id !== SYSTEM_TENANT_ID);
  expect(rows.length, 'at least two customer tenants must be seeded').toBeGreaterThanOrEqual(2);

  const me = await request.get('/api/v1/admin/api-keys?page=0&limit=1', { headers: bearer(tenantAdminToken) });
  expect(me.status(), 'tenant admin can list its own keys').toBe(200);
  // The tenant admin's own tenant is whichever seeded tenant it authenticated into.
  const probe = await createOwnKey(request, tenantAdminToken, 'tenant-probe');
  const probeRow = await request.get(`/api/v1/admin/api-keys/${probe}`, { headers: bearer(tenantAdminToken) });
  expect(probeRow.status()).toBe(200);
  ownTenantId = (await probeRow.json()).tenantId as string;
  foreignTenantId = rows.find((t) => t.id !== ownTenantId)!.id;
  expect(foreignTenantId, 'a second customer tenant is required').toBeTruthy();
});

test.afterAll(async ({ request }) => {
  for (const id of createdKeyIds) {
    await request.delete(`/api/v1/admin/api-keys/${id}`, { headers: bearer(superAdminToken) }).catch(() => undefined);
  }
});

test.describe('TASK-779 policy — CASL enforced pairs on ApiKey are inert; 404 is the real posture', () => {
  test("every by-id route answers 404 (never 403) for a peer's key, and casl_enforce_denial_total does not move", async ({ request }) => {
    const victimId = await createOwnKey(request, doctorToken, 'victim');

    const before = await readEnforceDenialTotal(request);

    // One probe per ENFORCED pair: read (GET, GET usage), update (PATCH, revoke,
    // rotate), delete (DELETE). If the enforce path were reachable, each of these
    // is precisely the request it would 403.
    const probes: Array<[string, () => Promise<{ status(): number }>]> = [
      ['GET :id (read:ApiKey)', () => request.get(`/api/v1/admin/api-keys/${victimId}`, { headers: bearer(doctor2Token) })],
      ['GET :id/usage (read:ApiKey)', () => request.get(`/api/v1/admin/api-keys/${victimId}/usage`, { headers: bearer(doctor2Token) })],
      [
        'PATCH :id (update:ApiKey)',
        () => request.patch(`/api/v1/admin/api-keys/${victimId}`, { headers: bearer(doctor2Token), data: { keyName: 't779-hijack' } }),
      ],
      ['POST :id/revoke (update:ApiKey)', () => request.post(`/api/v1/admin/api-keys/${victimId}/revoke`, { headers: bearer(doctor2Token) })],
      ['POST :id/rotate (update:ApiKey)', () => request.post(`/api/v1/admin/api-keys/${victimId}/rotate`, { headers: bearer(doctor2Token) })],
      ['DELETE :id (delete:ApiKey)', () => request.delete(`/api/v1/admin/api-keys/${victimId}`, { headers: bearer(doctor2Token) })],
    ];

    for (const [label, run] of probes) {
      const response = await run();
      expect(response.status(), `${label} — existence must be hidden (404), never leaked as 403`).toBe(404);
    }

    const after = await readEnforceDenialTotal(request);
    expect(
      after - before,
      'casl_enforce_denial_total moved — the guard-level enforce path fired. That would mean the 404s above became reachable 403s ' +
        'somewhere, i.e. the resolver stopped throwing. Re-read `ApiKeyController.resolveApiKeyInstance` and this file’s header.',
    ).toBe(0);

    // The denied attempts were inert: the real owner still sees an ACTIVE key.
    const survivor = await request.get(`/api/v1/admin/api-keys/${victimId}`, { headers: bearer(doctorToken) });
    expect(survivor.status(), 'owner still resolves their key').toBe(200);
    expect((await survivor.json()).keyStatus, 'peer probes must not have revoked it').toBe('ACTIVE');
  });

  test('a cross-TENANT key id is 404 with the same shape — the two boundaries are indistinguishable to the caller', async ({ request }) => {
    // Minted by the super admin inside the foreign tenant, so this is a real row,
    // not a synthetic id: the 404 proves the boundary, not mere absence.
    const created = await request.post('/api/v1/admin/api-keys', {
      headers: bearer(superAdminToken, foreignTenantId),
      data: { keyName: `t779-foreign-${Date.now()}`, keyType: 'SDK', scopes: ['stt:transcription:read'] },
    });
    expect(created.status(), 'super admin mints a key inside the foreign tenant').toBe(201);
    const foreignId = (await created.json()).apiKey.id as string;

    try {
      for (const [label, response] of [
        ['tenant admin GET', await request.get(`/api/v1/admin/api-keys/${foreignId}`, { headers: bearer(tenantAdminToken) })],
        ['tenant admin DELETE', await request.delete(`/api/v1/admin/api-keys/${foreignId}`, { headers: bearer(tenantAdminToken) })],
        ['clinician GET', await request.get(`/api/v1/admin/api-keys/${foreignId}`, { headers: bearer(doctorToken) })],
      ] as const) {
        expect(response.status(), `${label} on a foreign-tenant key → 404, never 403`).toBe(404);
      }
    } finally {
      await request.delete(`/api/v1/admin/api-keys/${foreignId}`, { headers: bearer(superAdminToken, foreignTenantId) }).catch(() => undefined);
    }
  });
});

test.describe('TASK-779 policy — the contrasting 403 PRIVILEGE boundaries', () => {
  test('the minting ceiling refuses a scope beyond the caller’s own abilities with 403, not 404', async ({ request }) => {
    const response = await request.post('/api/v1/admin/api-keys', {
      headers: bearer(tenantAdminToken),
      data: { keyName: `t779-ceiling-${Date.now()}`, keyType: 'SDK', scopes: ['*'] },
    });
    expect(response.status(), 'a tenant admin minting the bare wildcard is a PRIVILEGE refusal').toBe(403);
    expect((await response.json()).message).toContain('Cannot grant API key scopes beyond your own permissions');
  });

  test('a tenant admin reaching for ANOTHER tenant’s configuration is 403 — the config plane is a privilege boundary, not an existence one', async ({
    request,
  }) => {
    const response = await request.get(`/api/v1/admin/ai-task-defaults?taskKey=guardrail.validate&tenantId=${foreignTenantId}`, {
      headers: bearer(tenantAdminToken),
    });
    expect(response.status(), 'tenant admins are pinned to their own tenant').toBe(403);
  });
});

test.describe('TASK-779 policy — config resolution is exactly two tiers: request tenant → SYSTEM', () => {
  /** Every registered AI task key, discovered from the API itself (400 message) rather than hardcoded. */
  async function allTaskKeys(request: APIRequestContext): Promise<string[]> {
    const response = await request.get('/api/v1/admin/ai-task-defaults?taskKey=__t779_unknown__', { headers: bearer(tenantAdminToken) });
    expect(response.status(), 'an unknown task key is rejected 400 (registry is closed)').toBe(400);
    const message = (await response.json()).message as string;
    const keys = message
      .replace(/^.*Valid task keys:\s*/s, '')
      .split(',')
      .map((k) => k.trim())
      .filter(Boolean);
    expect(keys.length, 'the 400 message must enumerate the task-key registry').toBeGreaterThan(3);
    return keys;
  }

  test('a platform admin with no tenant scope gets 400 — resolution NEVER silently defaults to a customer tenant', async ({ request }) => {
    const response = await request.get('/api/v1/admin/ai-task-defaults?taskKey=guardrail.validate', { headers: bearer(superAdminToken) });
    expect(response.status(), 'no tenant context must be an error, not a default').toBe(400);
    expect((await response.json()).message).toContain('tenantId');
  });

  test('for EVERY task key and BOTH customer tenants: the answer is the tenant asked for, and system-sourced ⟺ no tenant row exists', async ({
    request,
  }) => {
    const keys = await allTaskKeys(request);

    for (const tenantId of [ownTenantId, foreignTenantId]) {
      for (const taskKey of keys) {
        const effective = await request.get(`/api/v1/admin/ai-task-defaults?taskKey=${taskKey}&tenantId=${tenantId}`, {
          headers: bearer(superAdminToken),
        });
        expect(effective.status(), `effective ${taskKey} @ ${tenantId}`).toBe(200);
        const body = await effective.json();

        // (a) The cascade answers for the tenant that was ASKED FOR. A response
        // carrying a different customer tenant's id would be the cross-tenant
        // leak this rule exists to prevent.
        expect(body.tenantId, `${taskKey}: resolution must answer for the requested tenant`).toBe(tenantId);

        // (b) There are TWO tiers and only two, plus the documented UNRESOLVED
        // state. `source: null` means neither tier has an opinion (the consuming
        // service falls back to its own bootstrap default) — it is NOT a third
        // tier, and in particular it is never a customer tenant. What must never
        // appear here is a 'global'/'default' source.
        expect(['tenant', 'system', null], `${taskKey}: unexpected resolution source '${body.source}'`).toContain(body.source);

        // (c) Widening to SYSTEM happens ONLY on absence. `GET /row` returns the
        // raw tenant row, or a `version: 0` placeholder when there is none — so
        // the biconditional below is the whole "tenant wins, SYSTEM is the
        // fallback" rule expressed as one checkable statement.
        const row = await request.get(`/api/v1/admin/ai-task-defaults/row?taskKey=${taskKey}&tenantId=${tenantId}`, {
          headers: bearer(superAdminToken),
        });
        expect(row.status(), `row ${taskKey} @ ${tenantId}`).toBe(200);
        const rowBody = await row.json();
        expect(rowBody.tenantId, `${taskKey}: raw row must belong to the requested tenant`).toBe(tenantId);

        if (body.source === null) {
          // Unresolved at BOTH tiers: no tenant row, and nothing served.
          expect(rowBody.version, `${taskKey} @ ${tenantId}: unresolved, so the tenant cannot have a row`).toBe(0);
          expect(body.modelSlug, `${taskKey} @ ${tenantId}: an unresolved key must not carry a model slug`).toBeNull();
        } else if (body.source === 'system') {
          expect(rowBody.version, `${taskKey} @ ${tenantId}: resolved from SYSTEM, so the tenant must have NO row of its own`).toBe(0);
          expect(body.modelSlug, `${taskKey} @ ${tenantId}: a SYSTEM-resolved key serves a real slug`).toBeTruthy();
        } else {
          expect(rowBody.version, `${taskKey} @ ${tenantId}: resolved from the tenant, so a real tenant row must exist`).toBeGreaterThan(0);
          expect(rowBody.modelSlug, `${taskKey} @ ${tenantId}: the tenant row is what was served`).toBe(body.modelSlug);
        }
      }
    }
  });
});
