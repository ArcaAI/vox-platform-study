/**
 * TASK-932 R-1 / R-6 / R-7 — the settings registry in a browser.
 *
 * The unit tests prove the screen's logic against a stubbed gateway. What only a
 * running stack can prove is the part that was actually broken: a platform admin
 * opening a key with NO working tenant selected, saving it, and seeing the value
 * come back. That round trip crossed the BFF proxy, the scope resolution, the
 * ETag interceptor and the write lane — and it answered 400 at the first hop.
 *
 * Skip-gated on the stack, like every spec in this suite.
 */

import { expect, test, type Page } from '@playwright/test';
import { expectNoA11yViolations } from './helpers/a11y';
import { impersonateUser, loginAsAdmin, selectWorkingTenant } from './helpers/auth';
import { API_DOWN_MESSAGE, APP_DOWN_MESSAGE, apiAvailable, appAvailable } from './helpers/stack';

/** `global-kv`, `maxScope: 'tenant'`, `globalOnly` — a platform-editable knob. */
const EDITABLE_KEY = 'consultation.realtime.textTimeoutMs';
/** `env` tier — locked for every caller, super administrators included. */
const LOCKED_KEY = 'databaseUrl';

test.beforeEach(async ({ page }) => {
  test.skip(!(await appAvailable()), APP_DOWN_MESSAGE);
  test.skip(!(await apiAvailable()), API_DOWN_MESSAGE);
  await loginAsAdmin(page);
});

async function openRegistry(page: Page) {
  await page.goto('/settings-registry');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await expect(page.getByRole('grid', { name: 'Settings registry' })).toBeVisible();
}

/** Find one key's row and open its drawer. */
async function openKey(page: Page, key: string) {
  await page.getByPlaceholder(/search/i).first().fill(key);
  const row = page.locator('[data-slot="data-grid-row"]', { hasText: key }).first();
  await expect(row).toBeVisible();
  await row.click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  return dialog;
}

test.describe('settings registry — the platform admin can write (R-6)', () => {
  test('edits a key at PLATFORM scope with no working tenant selected, and the value sticks', async ({ page }) => {
    // No `selectWorkingTenant` on purpose: this is the exact state the reported
    // defect made unusable.
    await openRegistry(page);
    const dialog = await openKey(page, EDITABLE_KEY);

    // The scope control names the row: with nothing selected, the platform row
    // is the only one addressable, and the drawer SAYS so.
    await expect(dialog.getByText(/Editing the platform default|changes the platform for every tenant/i).first()).toBeVisible();

    const field = dialog.getByLabel('New value');
    const before = await field.inputValue();
    const next = before === '90000' ? '95000' : '90000';

    await field.fill(next);
    await dialog.getByRole('button', { name: 'Save' }).click();
    await expect(dialog.getByRole('button', { name: 'Save' })).toBeDisabled();

    // Re-open from scratch: a value that only exists in local state proves nothing.
    await page.reload();
    await openRegistry(page);
    const reopened = await openKey(page, EDITABLE_KEY);
    await expect(reopened.getByLabel('New value')).toHaveValue(next);

    // Restore so a re-run starts from the same place.
    await reopened.getByLabel('New value').fill(before);
    await reopened.getByRole('button', { name: 'Save' }).click();
  });

  test('with a working tenant selected, the drawer offers a NAMED tenant override', async ({ page }) => {
    await selectWorkingTenant(page);
    await openRegistry(page);
    const dialog = await openKey(page, EDITABLE_KEY);

    // "This tenant only" would leave the admin to remember which one — the
    // control names it, because the row read and the row written must visibly
    // agree.
    const override = dialog.getByRole('radio', { name: /override$/ });
    await expect(override).toBeVisible();
    await override.click();
    await expect(dialog.getByText(/Saving writes an override on/i)).toBeVisible();

    const field = dialog.getByLabel('New value');
    await field.fill('87000');
    await dialog.getByRole('button', { name: 'Save' }).click();
    await expect(dialog.getByRole('button', { name: 'Save' })).toBeDisabled();
  });
});

test.describe('settings registry — locked tiers (R-6 / D-6)', () => {
  test('a bootstrap key renders Locked with its reason and offers no editor', async ({ page }) => {
    await openRegistry(page);
    const dialog = await openKey(page, LOCKED_KEY);

    await expect(dialog.getByText(/not editable here/i)).toBeVisible();
    await expect(dialog.getByText(/redeploy/i)).toBeVisible();
    // Locked for a SUPER ADMIN too — the lock is not a privilege gate.
    await expect(dialog.getByRole('button', { name: 'Save' })).toHaveCount(0);
  });
});

test.describe('settings registry — tenant visibility (R-1)', () => {
  test('an impersonated tenant admin sees no platform-only keys', async ({ page }) => {
    await impersonateUser(page, 'arcaai_admin');
    await page.goto('/settings-registry');

    // The title changes with the audience: a tenant admin is not looking at a
    // platform inventory, so calling it one would promise what it does not show.
    await expect(page.getByRole('heading', { level: 1, name: 'Tenant settings' })).toBeVisible();
    await expect(page.getByRole('grid', { name: 'Settings registry' })).toBeVisible();

    const search = page.getByPlaceholder(/search/i).first();
    for (const hidden of ['databaseUrl', 'jwt.secretKey', 'console.mlflow.enabled', 'consultation.ocr.enabled']) {
      await search.fill(hidden);
      await expect(page.getByText('No settings match these filters')).toBeVisible();
    }

    // ...and the key it CAN set is still there.
    await search.fill('rateLimit.maxRequests');
    await expect(page.locator('[data-slot="data-grid-row"]', { hasText: 'rateLimit.maxRequests' }).first()).toBeVisible();
  });
});

test.describe('settings registry — presentation (R-7)', () => {
  test('offers the four faceting chips at desktop width', async ({ page }) => {
    // Below a ~1024px GRID CONTAINER the chips collapse into the Filters
    // control, which is why this is asserted here and not in jsdom.
    await page.setViewportSize({ width: 1600, height: 900 });
    await openRegistry(page);
    for (const chip of ['Category', 'Tier', 'Max scope', 'Editability']) {
      await expect(page.getByRole('button', { name: chip, exact: true })).toBeVisible();
    }
  });

  test('groups the list by category with header rows', async ({ page }) => {
    await page.setViewportSize({ width: 1600, height: 900 });
    await openRegistry(page);
    await expect(page.locator('[data-slot="data-grid-group-row"]').first()).toBeVisible();
  });

  for (const theme of ['light', 'dark'] as const) {
    test(`has no axe violations in ${theme}`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: theme });
      await openRegistry(page);
      await expectNoA11yViolations(page);
    });
  }
});
