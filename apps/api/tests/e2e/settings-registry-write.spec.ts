/**
 * Settings registry write lane e2e.
 *
 * Live-stack requirement: the dev stack (`pnpm test:api:up`) plus a seeded
 * database (`pnpm db:seed`).
 *
 * What these specs prove that unit tests cannot:
 *   1. The settings write lane's descriptor-driven enforcement holds through
 *      the real guard/interceptor pipeline, and the newly registered orphan
 *      keys actually appear in `GET /admin/settings/catalog`.
 *   2. The strict global pipe (`whitelist + forbidNonWhitelisted`) rejects a
 *      value whose type contradicts the descriptor with 400.
 */
import { test, expect } from '@playwright/test';
import { DEFAULT_TENANT_KEY, SEEDED_USERS, loginUser } from '../../../../tests/helpers';

test.describe('settings registry write lane', () => {
  let superAdminToken: string;

  test.beforeAll(async ({ request }) => {
    const login = await loginUser(request, SEEDED_USERS.superAdmin.username, SEEDED_USERS.superAdmin.password, DEFAULT_TENANT_KEY);
    superAdminToken = login!.token;
  });

  const auth = () => ({ Authorization: `Bearer ${superAdminToken}` });

  test('the formerly orphaned keys now appear in the catalog', async ({ request }) => {
    const res = await request.get('/api/v1/admin/settings/catalog', { headers: auth() });
    expect(res.status()).toBe(200);

    const keys: string[] = (await res.json()).items.map((i: { key: string }) => i.key);
    for (const key of [
      'rate-limit.enabled',
      'audit-retention.enabled',
      'audit-retention.cron',
      'audit-retention.retention-days',
      'agentic.trajectory.enabled',
      'agentic.trajectory.cron',
      'agentic.trajectory.retentionDays',
    ]) {
      expect(keys, `${key} must be cataloged`).toContain(key);
    }
  });

  test('resolves a global-kv key through the effective read lane', async ({ request }) => {
    const res = await request.get('/api/v1/admin/settings/registry/rate-limit.enabled', { headers: auth() });
    expect(res.status()).toBe(200);

    const body = await res.json();
    expect(body.tier).toBe('global-kv');
    // sourceScope names WHICH row answered the tenant->SYSTEM->code-default
    // cascade (SettingSourceScope: 'tenant' | 'system' | 'code-default'), not
    // the descriptor's tier — 'global-kv' never appears here. This test does
    // not control what's currently stored for this key, so accept the full
    // valid set rather than assume a specific row answered.
    expect(['tenant', 'system', 'code-default']).toContain(body.sourceScope);
  });

  test('404s an unknown registry key on the path', async ({ request }) => {
    const res = await request.get('/api/v1/admin/settings/registry/nope.not.a.key', { headers: auth() });
    expect(res.status()).toBe(404);
  });

  test('400s an unwritable tier', async ({ request }) => {
    // `storage.platformDefault.*` is tier `db-config` — it keeps its dedicated service.
    const res = await request.put('/api/v1/admin/settings/registry/storage.platformDefault.endpoint', {
      headers: auth(),
      data: { value: true },
    });
    expect(res.status()).toBe(400);
  });

  test('400s a value whose type contradicts the descriptor', async ({ request }) => {
    const res = await request.put('/api/v1/admin/settings/registry/rate-limit.enabled', {
      headers: auth(),
      data: { value: 'yes-please' },
    });
    expect(res.status()).toBe(400);
  });

  test('the static registry route wins over the global-setting :id route', async ({ request }) => {
    // If `GlobalSettingModule` had registered first, this would be parsed as
    // `admin/settings/:id` with id="registry" and 404/500 differently.
    const res = await request.get('/api/v1/admin/settings/registry/agentic.context.liveDelta.maxChars', {
      headers: auth(),
    });
    expect(res.status()).toBe(200);
    expect((await res.json()).key).toBe('agentic.context.liveDelta.maxChars');
  });
});

test.describe('settings registry write lane cross-tenant posture', () => {
  test('a global-only registry key is not writable by a tenant admin', async ({ request }) => {
    const login = await loginUser(request, SEEDED_USERS.doctor.username, SEEDED_USERS.doctor.password, DEFAULT_TENANT_KEY);

    const res = await request.put('/api/v1/admin/settings/registry/agentic.context.liveDelta.maxChars', {
      headers: { Authorization: `Bearer ${login!.token}` },
      data: { value: 9000 },
    });
    expect([401, 403]).toContain(res.status());
  });
});
