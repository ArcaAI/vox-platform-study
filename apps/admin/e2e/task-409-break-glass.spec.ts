/**
 * TASK-409 — break-glass second confirmation · admin-console E2E (authored + run).
 *
 * Drives the REAL UI (dev server :5174 → API :8868 via the Vite proxy) across
 * all three viewports. Persona = superAdmin. All mutated rows are THROWAWAY
 * policies/roles created by this spec through the API and soft-deleted after
 * (break-glass credentials supplied); seeded rows are only read.
 *
 * Coverage:
 *   1. Policy delete — the Delete action opens the break-glass dialog
 *      (type-the-exact-name + current password, destructive confirm):
 *      confirm stays disabled until the name matches; a wrong password
 *      surfaces the server 401 inline (dialog stays open); the correct
 *      password completes the delete and the row disappears.
 *   2. Protected policy — `system-full-access` keeps the Protected badge +
 *      disabled Delete: NO break-glass path is offered (absolute block).
 *   3. Rule-edit escalation — editing rules of a policy attached to >1 role
 *      closes the form and escalates to the "Confirm rule change" break-glass
 *      dialog (the server's 428), which retries the edit with credentials.
 *
 * @see docs/implementation/TASK-409-Policy-Break-Glass/README.md
 */
import type { APIRequestContext } from '@playwright/test';
import { test, expect, PERSONAS } from './fixtures/auth';

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
const PASSWORD = PERSONAS.superAdmin.password;

/** Authenticate the seeded super admin against the API (via the Vite proxy). */
async function apiLogin(request: APIRequestContext): Promise<string> {
  const res = await request.post('/api/v1/auth/login', {
    data: { username: PERSONAS.superAdmin.username, password: PERSONAS.superAdmin.password, tenantKey: '__GLOBAL__' },
  });
  expect(res.status(), 'super_admin API login for spec setup').toBe(200);
  return ((await res.json()) as { token: string }).token;
}

async function apiCreatePolicy(request: APIRequestContext, token: string, name: string): Promise<string> {
  const res = await request.post('/api/v1/admin/rbac/policies', {
    headers: bearer(token),
    data: { name, description: 'TASK-409 FE e2e throwaway', scope: 'TENANT', rules: [{ action: 'read', subject: 'Consultation' }] },
  });
  expect(res.status(), `create throwaway policy ${name}`).toBe(201);
  return ((await res.json()) as { id: string }).id;
}

async function apiCreateRole(request: APIRequestContext, token: string, name: string): Promise<string> {
  const res = await request.post('/api/v1/admin/rbac/roles', {
    headers: bearer(token),
    data: { name, description: 'TASK-409 FE e2e throwaway' },
  });
  expect(res.status(), `create throwaway role ${name}`).toBe(201);
  return ((await res.json()) as { id: string }).id;
}

/** Break-glass-aware API cleanup (soft-delete only; ignores failures). */
async function apiDeletePolicy(request: APIRequestContext, token: string, id: string, name: string): Promise<void> {
  await request
    .delete(`/api/v1/admin/rbac/policies/${id}`, { headers: bearer(token), data: { password: PASSWORD, confirmationName: name } })
    .catch(() => undefined);
}
async function apiDeleteRole(request: APIRequestContext, token: string, id: string, name: string): Promise<void> {
  await request
    .delete(`/api/v1/admin/rbac/roles/${id}`, { headers: bearer(token), data: { password: PASSWORD, confirmationName: name } })
    .catch(() => undefined);
}
async function apiDetach(request: APIRequestContext, token: string, roleId: string, policyId: string, policyName: string): Promise<void> {
  await request
    .delete(`/api/v1/admin/rbac/roles/${roleId}/policies/${policyId}`, {
      headers: bearer(token),
      data: { password: PASSWORD, confirmationName: policyName },
    })
    .catch(() => undefined);
}

test.describe('TASK-409 — break-glass dialogs (roles & policies)', () => {
  test.beforeEach(async ({ page, loginAs }) => {
    await loginAs('superAdmin');
    await page.goto('/roles');
    await expect(page.getByRole('heading', { name: 'Roles & Policies' })).toBeVisible();
  });

  test('1 · policy delete walks the break-glass dialog (name gate → wrong password inline → success)', async ({ page, request }, testInfo) => {
    const NAME = `a-t409-fe-del-${testInfo.project.name}-${Date.now()}`;
    const token = await apiLogin(request);
    const policyId = await apiCreatePolicy(request, token, NAME);

    try {
      // Fresh load so the list includes the new throwaway.
      await page.goto('/roles');
      await page.getByRole('tab', { name: 'Policies' }).click();
      await page.getByRole('button', { name: `Delete ${NAME}`, exact: true }).click();

      const dialog = page.getByRole('dialog');
      await expect(dialog.getByRole('heading', { name: 'Delete policy' })).toBeVisible();
      const confirm = dialog.getByRole('button', { name: 'Delete policy' });

      // Armed only when the typed name matches exactly AND a password is present.
      await expect(confirm).toBeDisabled();
      await dialog.locator('#break-glass-password').fill(PASSWORD);
      await dialog.locator('#break-glass-name').fill(`${NAME}-typo`);
      await expect(confirm).toBeDisabled();

      // Wrong password → the server 401 surfaces inline; the dialog stays open.
      await dialog.locator('#break-glass-name').fill(NAME);
      await dialog.locator('#break-glass-password').fill('wrong-password');
      await expect(confirm).toBeEnabled();
      await confirm.click();
      await expect(dialog.getByRole('alert')).toBeVisible();
      await expect(dialog).toBeVisible();

      // Correct password → delete completes, dialog closes, row disappears.
      await dialog.locator('#break-glass-password').fill(PASSWORD);
      await confirm.click();
      await expect(dialog).toBeHidden();
      await expect(page.getByText('Policy deleted').first()).toBeVisible();
      await expect(page.getByRole('button', { name: `Delete ${NAME}`, exact: true })).toHaveCount(0);
    } finally {
      await apiDeletePolicy(request, token, policyId, NAME);
    }
  });

  test('2 · protected policy offers NO break-glass path (badge + disabled Delete)', async ({ page }) => {
    await page.getByRole('tab', { name: 'Policies' }).click();

    const row = page.getByRole('row', { name: /system-full-access/ });
    await expect(row.getByText('Protected')).toBeVisible();

    const disabledDelete = page.getByRole('button', { name: /Delete system-full-access \(protected system policy/ });
    await expect(disabledDelete).toBeVisible();
    await expect(disabledDelete).toBeDisabled();

    // No dialog can be reached for this row.
    await expect(page.getByRole('dialog')).toHaveCount(0);
  });

  test('3 · rule edit of a multi-role policy escalates to the Confirm-rule-change dialog', async ({ page, request }, testInfo) => {
    const STAMP = `${testInfo.project.name}-${Date.now()}`;
    const POLICY = `a-t409-fe-edit-${STAMP}`;
    const ROLE_A = `a-t409-fe-role-a-${STAMP}`;
    const ROLE_B = `a-t409-fe-role-b-${STAMP}`;
    const token = await apiLogin(request);
    const policyId = await apiCreatePolicy(request, token, POLICY);
    const roleAId = await apiCreateRole(request, token, ROLE_A);
    const roleBId = await apiCreateRole(request, token, ROLE_B);
    for (const roleId of [roleAId, roleBId]) {
      const res = await request.post(`/api/v1/admin/rbac/roles/${roleId}/policies/${policyId}`, {
        headers: bearer(token),
        data: { priority: 0 },
      });
      expect([200, 201], 'attach throwaway policy').toContain(res.status());
    }

    try {
      await page.goto('/roles');
      await page.getByRole('tab', { name: 'Policies' }).click();
      await page.getByRole('button', { name: `Edit ${POLICY}`, exact: true }).click();

      // Switch the rules editor to JSON and change the rules payload.
      const form = page.getByRole('dialog');
      await expect(form.getByRole('heading', { name: 'Edit policy' })).toBeVisible();
      await form.getByRole('tab', { name: 'Advanced (JSON)' }).click();
      await form.locator('#policy-rules-json').fill(
        JSON.stringify(
          [
            { action: 'read', subject: 'Consultation' },
            { action: 'create', subject: 'Consultation' },
          ],
          null,
          2,
        ),
      );
      await form.getByRole('button', { name: 'Save changes' }).click();

      // The server answers 428 → the break-glass dialog takes over (the
      // form dialog is closing simultaneously, so filter by content).
      const breakGlass = page.getByRole('dialog').filter({ hasText: 'Confirm rule change' });
      await expect(breakGlass.getByRole('heading', { name: 'Confirm rule change' })).toBeVisible();
      await breakGlass.locator('#break-glass-name').fill(POLICY);
      await breakGlass.locator('#break-glass-password').fill(PASSWORD);
      await breakGlass.getByRole('button', { name: 'Apply rule change' }).click();

      await expect(breakGlass).toBeHidden();
      await expect(page.getByText('Policy updated').first()).toBeVisible();
    } finally {
      await apiDetach(request, token, roleAId, policyId, POLICY);
      await apiDetach(request, token, roleBId, policyId, POLICY);
      await apiDeletePolicy(request, token, policyId, POLICY);
      await apiDeleteRole(request, token, roleAId, ROLE_A);
      await apiDeleteRole(request, token, roleBId, ROLE_B);
    }
  });

  test('4 · role delete opens the break-glass dialog and completes with credentials', async ({ page, request }, testInfo) => {
    const NAME = `a-t409-fe-role-del-${testInfo.project.name}-${Date.now()}`;
    const token = await apiLogin(request);
    const roleId = await apiCreateRole(request, token, NAME);

    try {
      await page.goto('/roles');
      // Select the throwaway role in the browser list, then delete from the
      // detail pane (tile accessible name = display name + slug + count).
      await page
        .getByRole('button', { name: new RegExp(NAME) })
        .first()
        .click();
      await page.getByRole('button', { name: `Delete ${NAME}`, exact: true }).click();

      const dialog = page.getByRole('dialog');
      await expect(dialog.getByRole('heading', { name: 'Delete role' })).toBeVisible();
      await dialog.locator('#break-glass-name').fill(NAME);
      await dialog.locator('#break-glass-password').fill(PASSWORD);
      await dialog.getByRole('button', { name: 'Delete role' }).click();

      await expect(dialog).toBeHidden();
      await expect(page.getByText('Role deleted').first()).toBeVisible();
    } finally {
      await apiDeleteRole(request, token, roleId, NAME);
    }
  });
});
