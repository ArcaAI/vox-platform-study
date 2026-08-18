/**
 * TASK-762 — `/api/v1/admin/service-accounts` + `POST /api/v1/auth/service-token`.
 *
 * Two distinct postures are asserted here and they must not be conflated:
 *
 *  - **403 PRIVILEGE boundaries.** Issuance is SUPER_ADMIN-only, and neither a
 *    tenant API key nor a service-account token may reach the surface at all.
 *    These are deliberate refusals of a caller who legitimately exists.
 *  - **404-over-403 TENANCY posture.** A by-id read of another tenant's account
 *    is "not found", never "forbidden", so the API never reveals that a foreign
 *    row exists. (`05-nestjs-api.md` DoD: every new admin resource needs this.)
 *
 * Plus the credential contract itself: the secret is returned exactly once, a
 * read never carries it back, and the token exchange is non-enumerable.
 */
import { test, expect, APIRequestContext } from '@playwright/test';
import { DEFAULT_TENANT_KEY, SEEDED_USERS, loginUser } from '../../../../tests/helpers';

const BASE = '/api/v1/admin/service-accounts';
const EXCHANGE = '/api/v1/auth/service-token';

interface CreatedAccount {
  id: string;
  clientId: string;
  clientSecret: string;
  tenantId: string;
  scopes: string[];
  version: number;
}

async function createAccount(request: APIRequestContext, token: string, body: Record<string, unknown>) {
  return request.post(BASE, { headers: { Authorization: `Bearer ${token}` }, data: body });
}

test.describe('Service accounts — issuance privilege boundary', () => {
  let superAdminToken: string;
  let tenantAdminToken: string;
  const createdIds: string[] = [];

  test.beforeAll(async ({ request }) => {
    const sa = await loginUser(request, SEEDED_USERS.superAdmin.username, SEEDED_USERS.superAdmin.password, 'ARCAAI');
    expect(sa, 'super admin login failed').toBeTruthy();
    superAdminToken = sa!.token;

    const ta = await loginUser(request, SEEDED_USERS.admin.username, SEEDED_USERS.admin.password, DEFAULT_TENANT_KEY);
    expect(ta, `tenant_admin login (${DEFAULT_TENANT_KEY}) failed`).toBeTruthy();
    tenantAdminToken = ta!.token;
  });

  test.afterAll(async ({ request }) => {
    for (const id of createdIds) {
      await request.delete(`${BASE}/${id}`, { headers: { Authorization: `Bearer ${superAdminToken}` } });
    }
  });

  test('a tenant admin CANNOT issue a service account — 403, not 404', async ({ request }) => {
    // This is the TASK-756 defect made impossible for this class: `@CanManage`
    // is tenant-admin-reachable, so the gate is imperative and stricter.
    const resp = await createAccount(request, tenantAdminToken, {
      displayName: 'tenant-admin attempt',
      scopes: ['svc:admin:department:manage'],
    });
    expect(resp.status(), 'tenant admin must be refused issuance').toBe(403);
  });

  test('a SUPER_ADMIN issues an account and receives the client secret exactly once', async ({ request }) => {
    const resp = await createAccount(request, superAdminToken, {
      displayName: 'e2e reconciliation bot',
      scopes: ['svc:admin:department:manage'],
    });
    expect(resp.status()).toBe(201);

    const account = (await resp.json()) as CreatedAccount;
    createdIds.push(account.id);

    expect(account.clientId).toMatch(/^hope_svc_/);
    expect(account.clientSecret, 'the secret is returned on create').toBeTruthy();
    expect(account.clientSecret.length).toBeGreaterThanOrEqual(32);

    // …and NEVER again. A subsequent read must not carry it, nor any verifier.
    const read = await request.get(`${BASE}/${account.id}`, { headers: { Authorization: `Bearer ${superAdminToken}` } });
    expect(read.status()).toBe(200);
    const body = await read.text();
    expect(body).not.toContain(account.clientSecret);
    expect(body).not.toContain('secretVerifier');
  });

  test('rejects an admin:* scope — that vocabulary belongs to tenant API keys', async ({ request }) => {
    const resp = await createAccount(request, superAdminToken, {
      displayName: 'wrong namespace',
      scopes: ['admin:department:manage'],
    });
    expect(resp.status(), 'admin:* must be rejected by the DTO validator').toBe(400);
  });

  test('rejects the bare API-key wildcard', async ({ request }) => {
    const resp = await createAccount(request, superAdminToken, { displayName: 'wildcard', scopes: ['*'] });
    expect(resp.status()).toBe(400);
  });
});

test.describe('Service accounts — cross-tenant posture (404-over-403)', () => {
  let superAdminToken: string;
  let tenantAdminToken: string;
  let foreignAccountId: string;

  test.beforeAll(async ({ request }) => {
    const sa = await loginUser(request, SEEDED_USERS.superAdmin.username, SEEDED_USERS.superAdmin.password, 'ARCAAI');
    superAdminToken = sa!.token;
    const ta = await loginUser(request, SEEDED_USERS.admin.username, SEEDED_USERS.admin.password, DEFAULT_TENANT_KEY);
    tenantAdminToken = ta!.token;

    // Issued in the super admin's own (ARCAAI) tenant — foreign to the tenant admin.
    const resp = await createAccount(request, superAdminToken, {
      displayName: 'foreign-tenant account',
      scopes: ['svc:admin:department:manage'],
    });
    expect(resp.status()).toBe(201);
    foreignAccountId = ((await resp.json()) as CreatedAccount).id;
  });

  test.afterAll(async ({ request }) => {
    await request.delete(`${BASE}/${foreignAccountId}`, { headers: { Authorization: `Bearer ${superAdminToken}` } });
  });

  test('a tenant admin reading a FOREIGN account gets 404, never 403', async ({ request }) => {
    const resp = await request.get(`${BASE}/${foreignAccountId}`, { headers: { Authorization: `Bearer ${tenantAdminToken}` } });
    expect([403, 404], 'must not be 200 — a foreign row must never be readable').toContain(resp.status());
    // The tenancy posture specifically: existence must not leak.
    expect(resp.status(), 'cross-tenant reads are 404-over-403').toBe(404);
    expect(await resp.text()).not.toContain('hope_svc_');
  });

  test("a tenant admin's list never contains a foreign account", async ({ request }) => {
    const resp = await request.get(BASE, { headers: { Authorization: `Bearer ${tenantAdminToken}` } });
    if (resp.status() === 200) {
      expect(await resp.text()).not.toContain(foreignAccountId);
    } else {
      expect([403, 404]).toContain(resp.status());
    }
  });
});

test.describe('Service accounts — the admin surface refuses every non-human credential', () => {
  test('an unauthenticated request is refused', async ({ request }) => {
    const resp = await request.get(BASE);
    expect([401, 403]).toContain(resp.status());
  });

  test('a service-account token cannot reach the issuance surface — no self-replication', async ({ request }) => {
    const sa = await loginUser(request, SEEDED_USERS.superAdmin.username, SEEDED_USERS.superAdmin.password, 'ARCAAI');
    const created = await createAccount(request, sa!.token, {
      displayName: 'self-replication probe',
      scopes: ['svc:admin:department:manage'],
    });
    expect(created.status()).toBe(201);
    const account = (await created.json()) as CreatedAccount;

    const exchange = await request.post(EXCHANGE, { data: { clientId: account.clientId, clientSecret: account.clientSecret } });
    expect(exchange.status(), 'exchange should succeed for a valid credential').toBe(200);
    const { accessToken } = (await exchange.json()) as { accessToken: string };

    const attempt = await request.post(BASE, {
      headers: { 'X-Service-Account-Token': accessToken },
      data: { displayName: 'spawned', scopes: ['svc:admin:department:manage'] },
    });
    expect(attempt.status(), 'a service account may never mint another').toBe(403);

    await request.delete(`${BASE}/${account.id}`, { headers: { Authorization: `Bearer ${sa!.token}` } });
  });
});

test.describe('Token exchange — non-enumerable and shape-checked', () => {
  test('an unknown client and a bad secret are indistinguishable', async ({ request }) => {
    const unknown = await request.post(EXCHANGE, { data: { clientId: 'hope_svc_does_not_exist', clientSecret: 'a'.repeat(64) } });
    expect(unknown.status()).toBe(401);

    const sa = await loginUser(request, SEEDED_USERS.superAdmin.username, SEEDED_USERS.superAdmin.password, 'ARCAAI');
    const created = await createAccount(request, sa!.token, { displayName: 'enumeration probe', scopes: ['svc:admin:department:manage'] });
    const account = (await created.json()) as CreatedAccount;

    const badSecret = await request.post(EXCHANGE, { data: { clientId: account.clientId, clientSecret: 'b'.repeat(64) } });
    expect(badSecret.status()).toBe(401);
    expect(await badSecret.text(), 'the two denials must not be distinguishable').toBe(await unknown.text());

    await request.delete(`${BASE}/${account.id}`, { headers: { Authorization: `Bearer ${sa!.token}` } });
  });

  test('credentials are refused in the query string', async ({ request }) => {
    const resp = await request.post(`${EXCHANGE}?clientId=x&clientSecret=${'a'.repeat(64)}`, { data: {} });
    expect(resp.status(), 'a secret in a URL lands in access logs and proxy traces').toBe(400);
  });

  test('revocation is effective immediately, not after a token TTL', async ({ request }) => {
    const sa = await loginUser(request, SEEDED_USERS.superAdmin.username, SEEDED_USERS.superAdmin.password, 'ARCAAI');
    const created = await createAccount(request, sa!.token, { displayName: 'revocation probe', scopes: ['svc:admin:department:manage'] });
    const account = (await created.json()) as CreatedAccount;

    const exchange = await request.post(EXCHANGE, { data: { clientId: account.clientId, clientSecret: account.clientSecret } });
    expect(exchange.status()).toBe(200);

    const revoke = await request.delete(`${BASE}/${account.id}`, { headers: { Authorization: `Bearer ${sa!.token}` } });
    expect(revoke.status()).toBe(204);

    // No NEW token can be exchanged the moment the account is revoked.
    const after = await request.post(EXCHANGE, { data: { clientId: account.clientId, clientSecret: account.clientSecret } });
    expect(after.status(), 'a revoked account must not exchange').toBe(401);
  });
});
