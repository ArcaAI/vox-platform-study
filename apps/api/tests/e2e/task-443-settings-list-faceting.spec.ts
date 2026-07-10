/**
 * TASK-443 — settings list faceting contract (namespace / dataType / secretsOnly).
 *
 * Live-stack proof that the settings list narrows SERVER-SIDE (not a client
 * page filter):
 *   F1. `filters=namespace[in]:…` narrows to the listed namespaces.
 *   F2. `filters=dataType[equals]:Json` narrows to the enum member; an invalid
 *       `ValueType` member is rejected with a clear 400 (registry validation,
 *       TASK-406 pattern) — never a Prisma 500.
 *   F3. `secretsOnly=true` resolves the DERIVED secret predicate (encrypted
 *       value OR `secrets` namespace OR convention-named key — the exact
 *       tri-condition of `GlobalSettingDtoMapper.isSecretEntity`); false
 *       returns only non-secrets. The rows' own `isSecret` flag is the oracle.
 *
 * Harness mirrors task-402: seeded `super_admin` on `__GLOBAL__`, throwaway
 * rows only, cleanup via the service soft-delete path.
 */
import { test, expect, type APIRequestContext } from '@playwright/test';
import { DEFAULT_TENANT_KEY, SEEDED_USERS, loginUser } from '../../../../tests/helpers';

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
// Per-worker unique: Playwright re-runs beforeAll in EVERY worker process, so a
// bare Date.now() can collide across workers within one millisecond (409 on the
// (tenantId, name, key) unique index).
const UNIQUE = `${Date.now()}p${process.pid}`;
const NS_A = `t443a${UNIQUE}`;
const NS_B = `t443b${UNIQUE}`;

interface SettingRow {
  id: string;
  key: string;
  namespace: string | null;
  dataType: string;
  isSecret: boolean;
  tenantId?: string | null;
}

/** Seeded default tenant (reserved 50000000-… prefix) — fallback when the list is empty. */
const DEFAULT_TENANT_ID = '50000000-0000-0000-0000-000000000000';
let tenantId: string = DEFAULT_TENANT_ID;

function rows(raw: unknown): SettingRow[] {
  return (
    raw && typeof raw === 'object' && Array.isArray((raw as { data?: SettingRow[] }).data) ? (raw as { data: SettingRow[] }).data : []
  ) as SettingRow[];
}

let token: string;
const createdIds: string[] = [];

async function createSetting(request: APIRequestContext, data: Record<string, string>): Promise<SettingRow> {
  // Explicit tenant: elevated callers bypass the tenant-scope create injection,
  // and the model's tenantId is NOT NULL.
  const res = await request.post('/api/v1/admin/settings', { headers: bearer(token), data: { ...data, tenantId } });
  if (res.status() >= 300) {
    expect(res.status(), `create setting ${data.key} → ${await res.text()}`).toBeLessThan(300);
  }
  const row = (await res.json()) as SettingRow;
  createdIds.push(row.id);
  return row;
}

// Serial: one worker → beforeAll (and its login) runs ONCE, keeping the spec
// clear of the auth-tier rate limiter and the fixture rows shared.
test.describe.configure({ mode: 'serial' });

test.describe('TASK-443 settings list faceting', () => {
  test.beforeAll(async ({ request }) => {
    // On __GLOBAL__ so creates carry a tenant (the model's tenantId is NOT NULL).
    const login = await loginUser(request, SEEDED_USERS.superAdmin.username, SEEDED_USERS.superAdmin.password, DEFAULT_TENANT_KEY);
    expect(login, 'seeded super_admin logs in').toBeTruthy();
    token = login!.token;

    // Anchor the throwaway rows to a REAL tenant (an existing row's, else the seeded default).
    const probe = await request.get('/api/v1/admin/settings?limit=1', { headers: bearer(token) });
    const existing = rows(await probe.json());
    if (existing[0]?.tenantId) tenantId = existing[0].tenantId;

    // Three throwaway rows: plain String in NS_A, Json in NS_B, and a
    // convention-named secret (key marker `token`) in NS_A.
    await createSetting(request, { name: `T443 plain ${UNIQUE}`, key: `t443.plain.${UNIQUE}`, value: 'v1', dataType: 'String', namespace: NS_A });
    await createSetting(request, { name: `T443 json ${UNIQUE}`, key: `t443.json.${UNIQUE}`, value: '{"a":1}', dataType: 'Json', namespace: NS_B });
    await createSetting(request, {
      name: `T443 secret ${UNIQUE}`,
      key: `t443.rotation.token.${UNIQUE}`,
      value: 's3cr3t',
      dataType: 'String',
      namespace: NS_A,
    });
  });

  test.afterAll(async ({ request }) => {
    for (const id of createdIds) {
      await request.delete(`/api/v1/admin/settings/${id}`, { headers: bearer(token) }).catch(() => undefined);
    }
  });

  test('F1 — namespace[in] narrows the result set server-side', async ({ request }) => {
    const res = await request.get(`/api/v1/admin/settings?limit=50&filters=${encodeURIComponent(`namespace[in]:${NS_A}|${NS_B}`)}`, {
      headers: bearer(token),
    });
    expect(res.status()).toBe(200);
    const data = rows(await res.json());
    expect(data.length).toBe(3);
    for (const row of data) expect([NS_A, NS_B]).toContain(row.namespace);

    const onlyB = await request.get(`/api/v1/admin/settings?limit=50&filters=${encodeURIComponent(`namespace[in]:${NS_B}`)}`, {
      headers: bearer(token),
    });
    const dataB = rows(await onlyB.json());
    expect(dataB.length).toBe(1);
    expect(dataB[0].namespace).toBe(NS_B);
  });

  test('F2 — dataType[equals] narrows to the enum member; an invalid member 400s', async ({ request }) => {
    const res = await request.get(
      `/api/v1/admin/settings?limit=50&filters=${encodeURIComponent(`namespace[in]:${NS_A}|${NS_B};dataType[equals]:Json`)}`,
      { headers: bearer(token) },
    );
    expect(res.status()).toBe(200);
    const data = rows(await res.json());
    expect(data.length).toBe(1);
    expect(data[0].dataType).toBe('Json');

    const bad = await request.get(`/api/v1/admin/settings?limit=5&filters=${encodeURIComponent('dataType[equals]:NotAType')}`, {
      headers: bearer(token),
    });
    expect(bad.status()).toBe(400);
    const body = (await bad.json()) as { message?: string };
    expect(String(body.message)).toContain('dataType');
  });

  test('F3 — secretsOnly resolves the derived secret predicate server-side', async ({ request }) => {
    const ns = encodeURIComponent(`namespace[in]:${NS_A}|${NS_B}`);
    const secrets = await request.get(`/api/v1/admin/settings?limit=50&filters=${ns}&secretsOnly=true`, { headers: bearer(token) });
    expect(secrets.status()).toBe(200);
    const secretRows = rows(await secrets.json());
    expect(secretRows.length).toBe(1);
    expect(secretRows[0].key).toContain('rotation.token');
    expect(secretRows[0].isSecret).toBe(true);

    const plain = await request.get(`/api/v1/admin/settings?limit=50&filters=${ns}&secretsOnly=false`, { headers: bearer(token) });
    expect(plain.status()).toBe(200);
    const plainRows = rows(await plain.json());
    expect(plainRows.length).toBe(2);
    for (const row of plainRows) expect(row.isSecret).toBe(false);
  });

  test('F3b — a junk secretsOnly value is rejected by DTO validation (400)', async ({ request }) => {
    const res = await request.get('/api/v1/admin/settings?limit=5&secretsOnly=maybe', { headers: bearer(token) });
    expect(res.status()).toBe(400);
  });
});
