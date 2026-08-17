/**
 * AI runtime profiles e2e.
 *
 * Live-stack requirement: the dev stack (`pnpm test:api:up`) plus a seeded
 * database (`pnpm db:seed`), which supplies ZERO `AiRuntimeProfile` rows.
 *
 * What these specs prove that unit tests cannot:
 *   1. The OCC chain really is wired end to end through the gateway —
 *      `@RequiresIfMatch()` produces a genuine 428 over real HTTP with real
 *      headers.
 *   2. The strict global pipe rejects an out-of-range knob with 400.
 */
import { test, expect } from '@playwright/test';
import { DEFAULT_TENANT_KEY, SEEDED_USERS, loginUser } from '../../../../tests/helpers';

test.describe('AI runtime profiles', () => {
  let superAdminToken: string;

  test.beforeAll(async ({ request }) => {
    const login = await loginUser(request, SEEDED_USERS.superAdmin.username, SEEDED_USERS.superAdmin.password, DEFAULT_TENANT_KEY);
    superAdminToken = login!.token;
  });

  const auth = () => ({ Authorization: `Bearer ${superAdminToken}` });

  test('seeds ZERO profiles, so resolution is empty (silent-change guard)', async ({ request }) => {
    const list = await request.get('/api/v1/admin/ai-runtime-profiles', { headers: auth() });
    expect(list.status()).toBe(200);
    expect(await list.json()).toEqual([]);

    const resolved = await request.get('/api/v1/admin/ai-runtime-profiles/resolve?provider=lm-studio&modelSlug=gemma-4', {
      headers: auth(),
    });
    expect(resolved.status()).toBe(200);
    expect((await resolved.json()).isEmpty).toBe(true);
  });

  test('rejects an out-of-range knob with 400', async ({ request }) => {
    const res = await request.put('/api/v1/admin/ai-runtime-profiles/row?provider=lm-studio', {
      headers: { ...auth(), 'If-Match': '"1"' },
      data: { temperature: 3 },
    });
    expect(res.status()).toBe(400);
  });

  test('PUT without If-Match → 428', async ({ request }) => {
    const res = await request.put('/api/v1/admin/ai-runtime-profiles/row?provider=lm-studio', {
      headers: auth(),
      data: { temperature: 0.5 },
    });
    expect(res.status()).toBe(428);
  });
});
