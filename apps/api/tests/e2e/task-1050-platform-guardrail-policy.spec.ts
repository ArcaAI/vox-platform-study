/**
 * TASK-1050 W2h — DEPTH coverage for the platform guardrail control plane (README §11.3 B/C/E, §12.2).
 *
 * The route-authorization MATRIX covers the breadth once these routes are in a regenerated manifest. This spec
 * pins what it cannot express:
 *   - a TENANT admin is 403 on every route (an imperative, row-independent gate — the decorator says AiModel);
 *   - the SAME super admin with a customer working tenant is 403; with none it is served;
 *   - PUT policy-keys/:key is OCC on the model row (428 without If-Match, 412 on a stale one) and refuses an
 *     out-of-bounds value and a criteria prompt that breaks the judge template (400);
 *   - a lane selection naming a model that does not declare the lane is 400 JUDGE_LANE_UNSUPPORTED;
 *   - the monitoring reads answer their documented shapes, cross-tenant.
 *
 * Written by lane W2h, NOT run by it (owner rule: the orchestrator runs e2e after the full merge). It assumes the
 * W4 seed (granite on every judge lane, `_metadata.policyDefaults`) and that nothing else edits guardrail policy
 * concurrently; every write it makes is reverted by a reset in `finally`.
 */
import { test, expect, type APIRequestContext } from '@playwright/test';
import { DEFAULT_TENANT_KEY, SEEDED_USERS, loginUser } from '../../../../tests/helpers';

const BASE = '/api/v1/admin/guardrail';
const GLOBAL_TENANT_ID = '50000000-0000-0000-0000-000000000000';

async function tenantAdmin(request: APIRequestContext): Promise<Record<string, string>> {
  const login = await loginUser(request, SEEDED_USERS.admin.username, SEEDED_USERS.admin.password, DEFAULT_TENANT_KEY);
  expect(login, 'the seeded tenant admin must log in').not.toBeNull();
  return { Authorization: `Bearer ${login!.token}` };
}

async function platformAdmin(request: APIRequestContext): Promise<Record<string, string>> {
  const login = await loginUser(request, SEEDED_USERS.superAdmin.username, SEEDED_USERS.superAdmin.password);
  expect(login, 'the seeded super admin must log in').not.toBeNull();
  return { Authorization: `Bearer ${login!.token}` };
}

const ROUTES: Array<[method: 'get' | 'put' | 'post', path: string, body?: unknown]> = [
  ['get', '/policy-keys'],
  ['get', '/policy-keys/judgeTemperature'],
  ['put', '/policy-keys/judgeTemperature', { value: 0.05 }],
  ['post', '/policy-keys/reset?lane=guardrail.safety'],
  ['post', '/policy-keys/judgeTemperature/reset'],
  ['get', '/policy-keys/judgeTemperature/revisions'],
  ['post', '/policy-keys/judgeTemperature/revisions/00000000-0000-0000-0000-000000000000/restore'],
  ['put', '/judge-models/00000000-0000-0000-0000-000000000000/judge-meta', { tiers: { Safe: 'pass', Controversial: 'warn', Unsafe: 'flag' } }],
  ['post', '/judge-models/00000000-0000-0000-0000-000000000000/judge-meta/reset'],
  ['get', '/judge-lanes'],
  ['put', '/judge-lanes', { selections: [{ lane: 'injection_judge', modelId: '00000000-0000-0000-0000-000000000000' }] }],
  ['post', '/dry-run', { lanes: ['injection_judge'], direction: 'inbound', samples: ['hello'] }],
  ['get', '/metrics/activity'],
  ['get', '/metrics/performance'],
  ['get', '/metrics/health'],
  ['get', '/metrics/evaluations'],
];

async function call(request: APIRequestContext, method: 'get' | 'put' | 'post', path: string, headers: Record<string, string>, body?: unknown) {
  const ifMatch = method === 'put' && path !== '/judge-lanes' ? { 'If-Match': '"1"' } : {};
  return request[method](`${BASE}${path}`, { headers: { ...headers, ...ifMatch }, ...(body !== undefined ? { data: body } : {}) });
}

test.describe('TASK-1050 W2h — platform guardrail control', () => {
  test('a TENANT admin is 403 on every route', async ({ request }) => {
    const headers = await tenantAdmin(request);
    for (const [method, path, body] of ROUTES) {
      const response = await call(request, method, path, headers, body);
      expect(response.status(), `${method.toUpperCase()} ${path}`).toBe(403);
    }
  });

  test('a super admin WITH a customer working tenant is 403; with none, the reads are served', async ({ request }) => {
    const headers = await platformAdmin(request);
    const scoped = await request.get(`${BASE}/policy-keys`, { headers: { ...headers, 'X-Tenant-Id': GLOBAL_TENANT_ID } });
    expect(scoped.status()).toBe(403);

    const keys = await request.get(`${BASE}/policy-keys`, { headers });
    expect(keys.status()).toBe(200);
    const body = await keys.json();
    expect(body.catalogueAvailable).toBe(true);
    const validate = body.groups.find((g: { taskKey: string }) => g.taskKey === 'guardrail.validate');
    expect(validate.keys.map((k: { key: string }) => k.key)).toEqual(expect.arrayContaining(['judgeTemperature', 'judgeMaxTokens', 'medicalValidationCriteria']));
    for (const lane of ['guardrail.judge.injection', 'guardrail.judge.unsafe_content', 'guardrail.judge.clinical_safety', 'guardrail.judge.leakage']) {
      expect(body.groups.map((g: { taskKey: string }) => g.taskKey)).toContain(lane);
    }
  });

  test('PUT policy-keys/:key: 428 without If-Match, 412 stale, 400 out of bounds, 200 + revision, reset restores the default', async ({ request }) => {
    const headers = await platformAdmin(request);
    const read = await request.get(`${BASE}/policy-keys/judgeTemperature`, { headers });
    expect(read.status()).toBe(200);
    const entry = await read.json();
    const version = entry.version as number;

    expect((await request.put(`${BASE}/policy-keys/judgeTemperature`, { headers, data: { value: 0.1 } })).status()).toBe(428);
    expect((await request.put(`${BASE}/policy-keys/judgeTemperature`, { headers: { ...headers, 'If-Match': `"${version + 100}"` }, data: { value: 0.1 } })).status()).toBe(412);

    const outOfBounds = await request.put(`${BASE}/policy-keys/judgeTemperature`, { headers: { ...headers, 'If-Match': `"${version}"` }, data: { value: 9 } });
    expect(outOfBounds.status()).toBe(400);
    expect(JSON.stringify(await outOfBounds.json())).toContain('GUARDRAIL_POLICY_VALUE_INVALID');

    try {
      const next = entry.currentValue === 0.1 ? 0.2 : 0.1;
      const written = await request.put(`${BASE}/policy-keys/judgeTemperature`, { headers: { ...headers, 'If-Match': `"${version}"` }, data: { value: next } });
      expect(written.status()).toBe(200);
      const saved = await written.json();
      expect(saved).toMatchObject({ currentValue: next, changed: true, version: version + 1 });
      expect(written.headers()['etag']).toBe(`"${version + 1}"`);

      const history = await request.get(`${BASE}/policy-keys/judgeTemperature/revisions`, { headers });
      expect((await history.json()).revisions[0]).toMatchObject({ reason: 'edit', value: next });
    } finally {
      const reset = await request.post(`${BASE}/policy-keys/judgeTemperature/reset`, { headers });
      expect(reset.status()).toBe(200);
    }
  });

  test('a criteria prompt that drops a locked section is 400 with the template errors', async ({ request }) => {
    const headers = await platformAdmin(request);
    const read = await (await request.get(`${BASE}/policy-keys/injectionJudgeCriteria`, { headers })).json();
    const broken = String(read.currentValue ?? '').replace(/<section id="untrusted_data_clause">[\s\S]*?<\/section>/, '');
    const response = await request.put(`${BASE}/policy-keys/injectionJudgeCriteria`, { headers: { ...headers, 'If-Match': `"${read.version}"` }, data: { value: broken || 'x' } });
    expect(response.status()).toBe(400);
    expect(JSON.stringify(await response.json())).toMatch(/SECTION_MISSING|TEXT_OUTSIDE_SECTION/);
  });

  test('a lane selection naming a model that does not declare the lane is 400 JUDGE_LANE_UNSUPPORTED', async ({ request }) => {
    const headers = await platformAdmin(request);
    const lanes = (await (await request.get(`${BASE}/judge-lanes`, { headers })).json()).lanes as Array<{ lane: string; candidates: Array<{ modelId: string }> }>;
    const injection = lanes.find((l) => l.lane === 'injection_judge')!;
    const clinical = lanes.find((l) => l.lane === 'clinical_safety_judge')!;
    const notClinical = injection.candidates.find((c) => !clinical.candidates.some((k) => k.modelId === c.modelId));
    test.skip(!notClinical, 'needs a judge model that declares injection but not clinical safety (W4 seeds Qwen3Guard-Gen-0.6B)');
    const response = await request.put(`${BASE}/judge-lanes`, { headers, data: { selections: [{ lane: 'clinical_safety_judge', modelId: notClinical!.modelId }] } });
    expect(response.status()).toBe(400);
    expect(JSON.stringify(await response.json())).toContain('JUDGE_LANE_UNSUPPORTED');
  });

  test('the monitoring reads answer their shapes', async ({ request }) => {
    const headers = await platformAdmin(request);
    const activity = await request.get(`${BASE}/metrics/activity?bucket=1h`, { headers });
    expect(activity.status()).toBe(200);
    expect(await activity.json()).toMatchObject({ bucket: '1h', totals: expect.any(Object), series: expect.any(Array), perTenant: expect.any(Array) });

    const performance = await request.get(`${BASE}/metrics/performance`, { headers });
    expect(performance.status()).toBe(200);
    expect(typeof (await performance.json()).available).toBe('boolean');

    const health = await request.get(`${BASE}/metrics/health`, { headers });
    expect(health.status()).toBe(200);
    expect((await health.json()).models.map((m: { taskKey: string }) => m.taskKey)).toContain('guardrail.validate');

    const evaluations = await request.get(`${BASE}/metrics/evaluations?limit=5`, { headers });
    expect(evaluations.status()).toBe(200);
    const page = await evaluations.json();
    expect(Array.isArray(page.items)).toBe(true);
    for (const item of page.items) expect(item).not.toHaveProperty('encryptedWithheldContent');

    expect((await request.get(`${BASE}/metrics/evaluations?cursor=forged`, { headers })).status()).toBe(400);
  });
});
