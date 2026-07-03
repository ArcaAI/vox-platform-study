/**
 * TASK-395 P1-4 — Sectioned Global Settings form · admin-console E2E (authored + run).
 *
 * Verifies the KV table was replaced by a namespace-sectioned form: a section-nav
 * rail, type-appropriate controls (Boolean → Switch), the preserved `locked`
 * affordance, and a dirty-state Save/Discard toolbar. Secrets render masked with a
 * DISABLED reveal (no reveal endpoint — TASK-395 §3 backend FLAG).
 *
 * Persona = superAdmin (locked rows editable). Non-destructive: a toggle exercises
 * the dirty toolbar then Discards — nothing is ever saved. Runs in all viewports.
 *
 * @see docs/designs/admin/unbuilt-super-admin-surfaces.md §5.6
 */
import { test, expect } from './fixtures/auth';

test.describe('TASK-395 — Global Settings (P1-4 sectioned form)', () => {
  test.beforeEach(async ({ page, loginAs }) => {
    await loginAs('superAdmin');
    await page.goto('/settings');
    await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
  });

  test('keeps the Global/My-settings tabs + New setting affordance', async ({ page }) => {
    await expect(page.getByRole('tab', { name: 'Global' })).toBeVisible();
    await expect(page.getByRole('tab', { name: 'My settings' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'New setting' })).toBeVisible();
  });

  test('groups settings via a namespace section-nav rail', async ({ page }) => {
    // The rail replaces the old KV-table namespace subheader (task-391 cell).
    await expect(page.getByRole('navigation', { name: 'Settings sections' })).toBeVisible();
    await expect(page.getByRole('button', { name: /Feature flags/ })).toBeVisible();
  });

  test('renders type-appropriate controls + the preserved locked affordance', async ({ page }) => {
    // Boolean settings (feature flags) → Switch controls.
    await expect(page.getByRole('switch').first()).toBeVisible();
    // Locked rows keep the TASK-391 lock affordance (super-admin still edits them).
    await expect(page.getByTitle('Locked — super-admin only').first()).toBeVisible();
  });

  test('a toggle drives the dirty Save/Discard toolbar (non-destructive)', async ({ page }) => {
    const save = page.getByRole('button', { name: 'Save changes' });
    await expect(save).toBeDisabled();

    await page.getByRole('switch').first().click();
    await expect(page.getByText(/unsaved change/)).toBeVisible();
    await expect(save).toBeEnabled();

    // Discard the local edit — never persists to the API.
    await page.getByRole('button', { name: 'Discard' }).click();
    await expect(page.getByText(/unsaved change/)).toBeHidden();
    await expect(save).toBeDisabled();
  });

  test('secrets (if seeded) mask the value with a disabled reveal (backend gap)', async ({ page }) => {
    // The reveal is intentionally disabled — no gated reveal endpoint exists yet.
    const reveal = page.getByRole('button', { name: /Reveal secret/ });
    if ((await reveal.count()) > 0) {
      await expect(reveal.first()).toBeDisabled();
    }
  });

  test('the create-setting dialog still opens and dismisses', async ({ page }) => {
    await page.getByRole('button', { name: 'New setting' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByLabel('Key')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
  });
});
