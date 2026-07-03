/**
 * TASK-396 — Global Settings secret reveal · admin-console E2E (authored + run).
 *
 * TASK-395 shipped secrets masked with a DISABLED reveal ("backend gap"). This
 * ticket adds the gated endpoint (`POST /admin/settings/:id/reveal`) — super-admin
 * only (CASL `manage all`), step-up re-auth (current password), audit-logged, and
 * NEVER bulk. This suite drives the real UI → API path end to end:
 *
 *   1. super-admin reveals a secret with the CORRECT step-up password → transient
 *      plaintext replaces the mask, with Copy + Hide (re-mask) affordances.
 *   2. a WRONG step-up password is rejected inline — the plaintext never shows.
 *   3. a non-super-admin is blocked from the settings surface (requireSuperAdmin
 *      route guard, TASK-394 — left intact).
 *
 * Non-destructive: reveal is a READ (it only appends an audit row); no setting is
 * ever written. Runs across all three viewports (desktop / tablet / mobile).
 *
 * @see docs/implementation/TASK-396-Settings-Secret-Reveal/README.md
 */
import { test, expect } from './fixtures/auth';

const SETTINGS_HEADING = 'Settings';

test.describe('TASK-396 — Global Settings secret reveal (super-admin · step-up · audited)', () => {
  test.describe('super-admin', () => {
    test.beforeEach(async ({ page, loginAs }) => {
      await loginAs('superAdmin');
      await page.goto('/settings');
      await expect(page.getByRole('heading', { name: SETTINGS_HEADING })).toBeVisible();
      // A seeded secret row is present, masked, with an ENABLED reveal.
      await expect(page.getByLabel('Secret value hidden').first()).toBeVisible();
    });

    test('reveals a secret with the correct step-up password, then re-masks', async ({ page }) => {
      const reveal = page.getByRole('button', { name: /^Reveal / }).first();
      await expect(reveal).toBeEnabled();
      await reveal.click();

      // Step-up dialog — re-enter the current account password.
      const dialog = page.getByRole('dialog');
      await expect(dialog).toBeVisible();
      const pw = dialog.locator('#reveal-step-up-password');
      await expect(pw).toBeVisible();
      await pw.fill('password123');
      await dialog.getByRole('button', { name: 'Reveal', exact: true }).click();

      // The transient plaintext replaces the •••• mask.
      const revealed = page.getByTestId('revealed-secret').first();
      await expect(revealed).toBeVisible();
      const text = ((await revealed.textContent()) ?? '').trim();
      expect(text.length).toBeGreaterThan(0);
      expect(text).not.toContain('\u2022'); // no bullet-mask characters

      // Copy + Hide affordances; Hide drops the transient plaintext (re-mask).
      await expect(page.getByRole('button', { name: /^Copy / }).first()).toBeVisible();
      const hide = page.getByRole('button', { name: /^Hide / }).first();
      await expect(hide).toBeVisible();
      await hide.click();
      await expect(page.getByTestId('revealed-secret')).toHaveCount(0);
      await expect(page.getByLabel('Secret value hidden').first()).toBeVisible();
    });

    test('rejects a wrong step-up password — plaintext never shows', async ({ page }) => {
      const reveal = page.getByRole('button', { name: /^Reveal / }).first();
      await expect(reveal).toBeEnabled();
      await reveal.click();

      const dialog = page.getByRole('dialog');
      await expect(dialog).toBeVisible();
      await dialog.locator('#reveal-step-up-password').fill('definitely-the-wrong-password');
      await dialog.getByRole('button', { name: 'Reveal', exact: true }).click();

      // Inline error; the dialog stays open and nothing is ever revealed.
      await expect(dialog.getByRole('alert')).toBeVisible();
      await expect(page.getByTestId('revealed-secret')).toHaveCount(0);
    });
  });

  test('a non-super-admin is blocked from the settings surface (route guard intact)', async ({ page, loginAs }) => {
    await loginAs('arcaaiAdmin');
    await page.goto('/settings');
    // requireSuperAdmin (TASK-394) bounces a direct URL hit to the viewer's tenant.
    await expect(page).toHaveURL(/\/tenants\//, { timeout: 15_000 });
    await expect(page.getByRole('heading', { name: SETTINGS_HEADING })).toBeHidden();
  });
});
