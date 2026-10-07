/**
 * TASK-1050 W2b — `GET/PUT admin/guardrail/policy`, the tenant admin's guardrail on/off route, against a
 * LIVE gateway (README §11.1). Written by the lane, run by the orchestrator at P4 (needs the reseed that
 * grants `manage:TenantGuardrailPolicy` to TENANT_ADMIN).
 *
 * Depth the authz matrix cannot express:
 *  - the field-level split gate: `enabled` only (403 GUARDRAIL_FIELD_PLATFORM_ONLY on action / lock /
 *    threshold, 403 GUARDRAIL_CHECK_LOCKED on medical validation, 403 on a check the platform locked);
 *  - OD-8: the last inbound check cannot be switched off (400), a direction off is allowed;
 *  - If-Match: missing → 428, stale → 412;
 *  - cross-tenant: a tenant admin naming another tenant never reads or writes its row (404-over-403);
 *  - credential classes: an API key is refused (403), a clinician is refused (403).
 */
import { expect, test, type APIRequestContext } from '@playwright/test';
import { DEFAULT_TENANT_KEY, SEEDED_API_KEY, SEEDED_USERS, loginUser } from '../../../../tests/helpers';

const ROUTE = '/api/v1/admin/guardrail/policy';

interface CheckState {
  checkId: string;
  enabled: boolean;
  action: string;
  locked: boolean;
  lockReason: 'catalogue' | 'platform' | null;
  editable: boolean;
}
interface PolicyBody {
  tenantId: string;
  version: number;
  directions: { inbound: { enabled: boolean }; outbound: { enabled: boolean } };
  checks: CheckState[];
}

test.describe.configure({ mode: 'serial' });

test.describe('TASK-1050 — tenant guardrail on/off (admin/guardrail/policy)', () => {
  let tenantAdmin: string;
  let tenantAdminTenantId: string;
  let superAdmin: string;
  let otherTenantId: string;
  let doctor: string;

  const auth = (token: string, extra: Record<string, string> = {}) => ({ Authorization: `Bearer ${token}`, ...extra });

  async function read(request: APIRequestContext, token = tenantAdmin): Promise<PolicyBody> {
    const response = await request.get(ROUTE, { headers: auth(token) });
    expect(response.status()).toBe(200);
    return (await response.json()) as PolicyBody;
  }

  test.beforeAll(async ({ request }) => {
    const ta = await loginUser(request, SEEDED_USERS.admin.username, SEEDED_USERS.admin.password, DEFAULT_TENANT_KEY);
    expect(ta, 'tenant_admin login failed').toBeTruthy();
    tenantAdmin = ta!.token;
    tenantAdminTenantId = ta!.user.tenantId;

    const sa = await loginUser(request, SEEDED_USERS.superAdmin.username, SEEDED_USERS.superAdmin.password, 'ARCAAI');
    expect(sa, 'super_admin login failed').toBeTruthy();
    superAdmin = sa!.token;
    otherTenantId = sa!.user.tenantId;
    expect(otherTenantId).not.toBe(tenantAdminTenantId);

    const doc = await loginUser(request, SEEDED_USERS.doctor.username, SEEDED_USERS.doctor.password, DEFAULT_TENANT_KEY);
    expect(doc, 'doctor login failed').toBeTruthy();
    doctor = doc!.token;
  });

  test('GET answers every check with its read-only action and lock state', async ({ request }) => {
    const body = await read(request);
    expect(body.tenantId).toBe(tenantAdminTenantId);
    const medical = body.checks.find((check) => check.checkId === 'medical_validation');
    expect(medical).toMatchObject({ enabled: true, action: 'block', locked: true, lockReason: 'catalogue', editable: false });
    expect(body.directions.inbound.enabled).toBe(true);
  });

  test('PUT without If-Match is 428', async ({ request }) => {
    const response = await request.put(ROUTE, { headers: auth(tenantAdmin), data: { checks: { prompt_toxicity: { enabled: false } } } });
    expect(response.status()).toBe(428);
  });

  test('a tenant admin switches a check off; a stale version is then 412', async ({ request }) => {
    const before = await read(request);
    const ok = await request.put(ROUTE, {
      headers: auth(tenantAdmin, { 'If-Match': `"${before.version}"` }),
      data: { checks: { prompt_toxicity: { enabled: false } } },
    });
    expect(ok.status()).toBe(200);
    const after = (await ok.json()) as PolicyBody;
    expect(after.checks.find((check) => check.checkId === 'prompt_toxicity')?.enabled).toBe(false);

    const stale = await request.put(ROUTE, {
      headers: auth(tenantAdmin, { 'If-Match': `"${before.version}"` }),
      data: { checks: { prompt_toxicity: { enabled: true } } },
    });
    expect(stale.status()).toBe(412);

    const restore = await request.put(ROUTE, {
      headers: auth(tenantAdmin, { 'If-Match': `"${after.version}"` }),
      data: { checks: { prompt_toxicity: { enabled: true } } },
    });
    expect(restore.status()).toBe(200);
  });

  for (const [field, checks] of [
    ['action', { prompt_safety: { action: 'ignore' } }],
    ['locked', { prompt_safety: { locked: true } }],
    ['minScore', { pii_leak: { minScore: 0.1 } }],
  ] as const) {
    test(`a tenant admin changing ${field} is 403 GUARDRAIL_FIELD_PLATFORM_ONLY`, async ({ request }) => {
      const { version } = await read(request);
      const response = await request.put(ROUTE, { headers: auth(tenantAdmin, { 'If-Match': `"${version}"` }), data: { checks } });
      expect(response.status()).toBe(403);
      const body = await response.json();
      expect(JSON.stringify(body)).toContain('GUARDRAIL_FIELD_PLATFORM_ONLY');
    });
  }

  test('the medical check is locked for everyone: 403 GUARDRAIL_CHECK_LOCKED', async ({ request }) => {
    const { version } = await read(request);
    const response = await request.put(ROUTE, {
      headers: auth(tenantAdmin, { 'If-Match': `"${version}"` }),
      data: { checks: { medical_validation: { enabled: false } } },
    });
    expect(response.status()).toBe(403);
    expect(JSON.stringify(await response.json())).toContain('GUARDRAIL_CHECK_LOCKED');
  });

  test('OD-8: switching off every inbound check is 400; a direction OFF (monitor only) is allowed', async ({ request }) => {
    const { version } = await read(request);
    const ungated = await request.put(ROUTE, {
      headers: auth(tenantAdmin, { 'If-Match': `"${version}"` }),
      data: { checks: { jailbreak_detection: { enabled: false }, prompt_safety: { enabled: false }, prompt_toxicity: { enabled: false } } },
    });
    expect(ungated.status()).toBe(400);

    const monitor = await request.put(ROUTE, {
      headers: auth(tenantAdmin, { 'If-Match': `"${version}"` }),
      data: { directions: { outbound: { enabled: false } } },
    });
    expect(monitor.status()).toBe(200);
    const after = (await monitor.json()) as PolicyBody;
    const back = await request.put(ROUTE, {
      headers: auth(tenantAdmin, { 'If-Match': `"${after.version}"` }),
      data: { directions: { outbound: { enabled: true } } },
    });
    expect(back.status()).toBe(200);
  });

  test('a check the platform LOCKED for the tenant cannot be switched by it', async ({ request }) => {
    const platformRoute = `/api/v1/admin/guardrail/availability/${tenantAdminTenantId}`;
    const current = await request.get(platformRoute, { headers: auth(superAdmin) });
    expect(current.status()).toBe(200);
    const row = await current.json();
    const policies = row.version === 0 ? { checks: {} } : row.policies;
    const checks = { ...((policies as { checks?: Record<string, unknown> }).checks ?? {}), prompt_safety: { enabled: true, locked: true } };
    const locked = await request.put(platformRoute, {
      headers: auth(superAdmin, { 'If-Match': `"${row.version}"` }),
      data: { policies: { ...policies, checks } },
    });
    expect(locked.status()).toBe(200);

    const { version } = await read(request);
    const refused = await request.put(ROUTE, { headers: auth(tenantAdmin, { 'If-Match': `"${version}"` }), data: { checks: { prompt_safety: { enabled: false } } } });
    expect(refused.status()).toBe(403);

    const unlockedRow = await locked.json();
    const unlock = await request.put(platformRoute, {
      headers: auth(superAdmin, { 'If-Match': `"${unlockedRow.version}"` }),
      data: { policies: { ...policies, checks: { ...checks, prompt_safety: { enabled: true, locked: false } } } },
    });
    expect(unlock.status()).toBe(200);
  });

  test('cross-tenant: a tenant admin naming another tenant never reads or writes its row', async ({ request }) => {
    const probe = await request.get(ROUTE, { headers: auth(tenantAdmin, { 'X-Tenant-Id': otherTenantId }) });
    // Either the tenant context is pinned (the caller reads its OWN row) or the probe is hidden (404);
    // never the other tenant's row and never a 403 that would acknowledge it.
    if (probe.status() === 200) expect(((await probe.json()) as PolicyBody).tenantId).toBe(tenantAdminTenantId);
    else expect(probe.status()).toBe(404);

    const write = await request.put(ROUTE, {
      headers: auth(tenantAdmin, { 'X-Tenant-Id': otherTenantId, 'If-Match': '"0"' }),
      data: { checks: { prompt_toxicity: { enabled: false } } },
    });
    expect([404, 412, 200]).toContain(write.status());
    const other = await request.get(`/api/v1/admin/guardrail/availability/${otherTenantId}`, { headers: auth(superAdmin) });
    const otherBody = await other.json();
    expect(JSON.stringify(otherBody.policies ?? {})).not.toContain('tenant_admin');
  });

  test('a clinician (no TenantGuardrailPolicy grant) is 403', async ({ request }) => {
    expect((await request.get(ROUTE, { headers: auth(doctor) })).status()).toBe(403);
  });

  test('an API key is refused on the admin plane (403)', async ({ request }) => {
    expect((await request.get(ROUTE, { headers: { 'X-API-Key': SEEDED_API_KEY } })).status()).toBe(403);
  });
});
