/**
 * TASK-395 P1-5 — API-Keys richness · admin-console E2E (authored + run).
 *
 * Verifies the per-key `rateLimit` / `environment` / `ipAllowlist` surfaced as
 * table columns + create-dialog fields (all REAL `ApiKey` fields, SDK-forwarded —
 * no backend change). Rotate/scopes/masked-key remain covered by task-391.
 *
 * Persona = superAdmin (all keys, cross-tenant). Non-destructive: the create
 * dialog is opened + dismissed, never submitted. Runs in all three viewports.
 *
 * @see docs/designs/admin/unbuilt-super-admin-surfaces.md §5.2
 */
import { test, expect } from './fixtures/auth';

test.describe('TASK-395 — API Keys (P1-5 rate-limit · environment · IP allowlist)', () => {
  // `/api-keys` collides with the Vite `/api` dev-proxy → reach it via the
  // sidebar (client-side nav), exactly like task-391-api-keys (see D1).
  test.beforeEach(async ({ page, loginAs }) => {
    await loginAs('superAdmin');
    await expect(page.getByRole('heading', { name: 'Tenants' })).toBeVisible();
    if ((page.viewportSize()?.width ?? 1280) < 768) {
      await page.getByRole('button', { name: 'Open navigation' }).click();
    }
    await page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: 'API Keys' }).click();
    await expect(page.getByRole('heading', { name: 'API Keys' })).toBeVisible();
  });

  test('surfaces Rate limit · Environment · IP allowlist columns', async ({ page }) => {
    await expect(page.getByRole('columnheader', { name: 'Rate limit' })).toBeVisible();
    await expect(page.getByRole('columnheader', { name: 'Environment' })).toBeVisible();
    await expect(page.getByRole('columnheader', { name: 'IP allowlist' })).toBeVisible();
  });

  test('create dialog exposes environment, rate-limit + IP-allowlist fields', async ({ page }) => {
    await page.getByRole('button', { name: 'New API key' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByLabel('Environment')).toBeVisible();
    await expect(dialog.getByLabel('Rate limit')).toBeVisible();
    await expect(dialog.getByLabel('IP allowlist')).toBeVisible();
    // Non-destructive — dismiss without creating a key.
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
  });
});
