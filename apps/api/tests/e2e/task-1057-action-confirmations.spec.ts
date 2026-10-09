/**
 * TASK-1057 lane A — action-confirmation policy plane.
 *
 * DEPTH the route-authz matrix cannot express: the platform read/write routes declare
 * `read`/`manage:GlobalSetting`, which a tenant admin holds for its OWN rows, so the SUPER_ADMIN
 * boundary is imperative (`ActionConfirmationService.assertPlatformAccess`); and the policy must
 * actually bite — flipping `promptTemplate.update` to `required` makes a prompt-template PATCH
 * without `changeReason` answer 400 CONFIRMATION_REQUIRED, and a reset makes it succeed again.
 */
import { test, expect, type APIRequestContext } from '@playwright/test';
import { DEFAULT_TENANT_KEY, SEEDED_USERS, loginUser } from '../../../../tests/helpers';

const BASE = '/api/v1/admin/settings/action-confirmations';
const PROMPT_TEMPLATES = '/api/v1/admin/prompt-templates';
const ACTION = 'promptTemplate.update';

async function tenantAdminToken(request: APIRequestContext): Promise<string> {
  const login = await loginUser(request, SEEDED_USERS.admin.username, SEEDED_USERS.admin.password, DEFAULT_TENANT_KEY);
  expect(login, 'the seeded tenant admin must log in').not.toBeNull();
  return login!.token;
}

async function superAdminToken(request: APIRequestContext): Promise<string> {
  const login = await loginUser(request, SEEDED_USERS.superAdmin.username, SEEDED_USERS.superAdmin.password);
  expect(login, 'the seeded super admin must log in').not.toBeNull();
  return login!.token;
}

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

interface PlatformRow {
  actionId: string;
  mode: string;
  locked: boolean;
  source: string;
  version: number;
  modes: string[];
}

async function platformRows(request: APIRequestContext, token: string): Promise<PlatformRow[]> {
  const response = await request.get(BASE, { headers: auth(token) });
  expect(response.status()).toBe(200);
  return ((await response.json()) as { items: PlatformRow[] }).items;
}

// SERIAL: the cases move the SAME platform row.
test.describe.configure({ mode: 'serial' });

test.describe('effective — every admin', () => {
  test('a tenant admin may read the effective policy', async ({ request }) => {
    const response = await request.get(`${BASE}/effective`, { headers: auth(await tenantAdminToken(request)) });
    expect(response.status()).toBe(200);
    const body = (await response.json()) as { items: Array<{ actionId: string; mode: string; locked: boolean }> };
    expect(body.items.length).toBeGreaterThan(0);
    expect(body.items.some((i) => i.actionId === ACTION)).toBe(true);
    // Locked rows can never be switched off.
    expect(body.items.filter((i) => i.locked).every((i) => i.mode === 'required')).toBe(true);
  });
});

test.describe('the platform plane is SUPER_ADMIN only', () => {
  test('a tenant admin gets 403 on read and on write — a privilege boundary, not a 404', async ({ request }) => {
    const headers = auth(await tenantAdminToken(request));
    expect((await request.get(BASE, { headers })).status()).toBe(403);
    expect((await request.put(BASE, { headers, data: { cells: [{ actionId: ACTION, mode: 'required' }] } })).status()).toBe(403);
  });
});

test.describe('platform write', () => {
  test('a locked row refuses with a per-cell 400 and the batch still answers 200', async ({ request }) => {
    const token = await superAdminToken(request);
    const locked = (await platformRows(request, token)).find((r) => r.locked);
    expect(locked, 'the catalogue ships locked rows').toBeDefined();
    const response = await request.put(BASE, { headers: auth(token), data: { cells: [{ actionId: locked!.actionId, mode: 'not-required' }] } });
    expect(response.status()).toBe(200);
    const body = (await response.json()) as { rows: unknown[]; errors: Array<{ actionId: string; status: number }> };
    expect(body.rows).toEqual([]);
    expect(body.errors[0]).toMatchObject({ actionId: locked!.actionId, status: 400 });
  });

  test('required bites on a prompt-template PATCH; reset lifts it', async ({ request }) => {
    const superToken = await superAdminToken(request);
    const adminHeaders = auth(await tenantAdminToken(request));

    // A tenant-owned template to edit (created while the policy is at its default).
    const created = await request.post(PROMPT_TEMPLATES, {
      headers: adminHeaders,
      data: { name: `task-1057 ${Date.now()}`, content: 'Summarise the visit.', category: 'CUSTOM' },
    });
    expect(created.status()).toBe(201);
    const template = (await created.json()) as { id: string };

    try {
      // Platform admin switches the requirement on.
      const row = (await platformRows(request, superToken)).find((r) => r.actionId === ACTION)!;
      const on = await request.put(BASE, {
        headers: auth(superToken),
        data: { cells: [{ actionId: ACTION, mode: 'required', ...(row.version > 0 ? { expectedVersion: row.version } : {}) }] },
      });
      expect(on.status()).toBe(200);
      expect(((await on.json()) as { errors: unknown[] }).errors).toEqual([]);

      // Tenant admin PATCH without a reason -> 400 CONFIRMATION_REQUIRED.
      const refused = await request.patch(`${PROMPT_TEMPLATES}/${template.id}`, {
        headers: adminHeaders,
        data: { content: 'Summarise the visit, briefly.' },
      });
      expect(refused.status()).toBe(400);
      expect(await refused.json()).toMatchObject({ code: 'CONFIRMATION_REQUIRED', actionId: ACTION });

      // With a reason it goes through.
      const accepted = await request.patch(`${PROMPT_TEMPLATES}/${template.id}`, {
        headers: adminHeaders,
        data: { content: 'Summarise the visit, briefly.', changeReason: 'tighten wording for the e2e' },
      });
      expect(accepted.status()).toBe(200);
    } finally {
      // Reset to the catalogue default and prove the field is optional again.
      const fresh = (await platformRows(request, superToken)).find((r) => r.actionId === ACTION)!;
      const reset = await request.put(BASE, {
        headers: auth(superToken),
        data: { cells: [{ actionId: ACTION, mode: null, ...(fresh.version > 0 ? { expectedVersion: fresh.version } : {}) }] },
      });
      expect(reset.status()).toBe(200);
    }

    const after = await request.patch(`${PROMPT_TEMPLATES}/${template.id}`, { headers: adminHeaders, data: { content: 'Summarise the visit.' } });
    expect(after.status()).toBe(200);
  });
});
