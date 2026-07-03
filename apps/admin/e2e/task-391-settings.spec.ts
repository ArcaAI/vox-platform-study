/**
 * TASK-391 #24 (ST1) — Global Settings · admin-console E2E (authored).
 *
 * Verifies the Settings surface (`/settings`) wired to `useGlobalSettings`
 * (CRUD + OCC), with the TASK-390 polish: settings are **grouped by namespace**
 * and **locked** rows carry a lock indicator (write-guarded server-side —
 * super-admins may still edit them; the console disables the controls for
 * everyone else).
 *
 * Persona = superAdmin (locked rows load + are editable; the disabled-for-
 * non-super-admin path is a separate persona concern, not asserted here).
 * Runs in all three viewport projects.
 *
 * Run status: authored — executes only against a live admin app + seeded API.
 * Deferred this round (see README §3.5).
 *
 * @see docs/designs/admin/unbuilt-super-admin-surfaces.md §5.6
 */
import { test, expect } from './fixtures/auth';

test.describe('TASK-391 — Global Settings (#24 locked + namespaces)', () => {
  test.beforeEach(async ({ page, loginAs }) => {
    await loginAs('superAdmin');
    await page.goto('/settings');
    await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
  });

  test('exposes the Global and My-settings tabs + create affordance', async ({ page }) => {
    await expect(page.getByRole('tab', { name: 'Global' })).toBeVisible();
    await expect(page.getByRole('tab', { name: 'My settings' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'New setting' })).toBeVisible();
  });

  test('#24 · settings are grouped by namespace', async ({ page }) => {
    // TASK-395 P1-4 replaced the KV table with a namespace-sectioned form, so the
    // `feature-flags` namespace now surfaces as a section heading rather than a
    // table cell (the sectioned-form deep-dive lives in task-395-settings-form).
    await expect(page.getByRole('heading', { name: 'Feature flags' })).toBeVisible();
  });

  // D2 RESOLVED (TASK-391 follow-up): `GlobalSettingResponse` now exposes
  // `locked`, so `GET /admin/settings` returns it and the console renders the
  // lock affordance for seed rows marked `locked: true` (e.g. the TASK-332
  // local-raw-capture flag). The FE guard is `isSettingLocked` in settings.tsx.
  test('#24 · locked rows render a Lock affordance', async ({ page }) => {
    await expect(page.getByTitle('Locked — super-admin only').first()).toBeVisible();
  });

  test('#24 · the create-setting dialog opens and dismisses', async ({ page }) => {
    await page.getByRole('button', { name: 'New setting' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByLabel('Key')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
  });
});
