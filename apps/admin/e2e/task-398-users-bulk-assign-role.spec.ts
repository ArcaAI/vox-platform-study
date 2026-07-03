/**
 * TASK-398 P1-6 — bulk **Assign role** on the Users surface (FE E2E).
 *
 * Proves the new bulk-bar affordance drives the real SDK/API wiring:
 *   - the bulk bar (rows selected) now exposes **Assign role** alongside the
 *     four TASK-394 actions (which must all still be present — no regression);
 *   - clicking it opens the single-select role picker fed by `useRoles()`
 *     (seeded rbac roles render as radio rows), with search filtering and a
 *     confirm that stays disabled until a role is picked.
 *
 * NON-DESTRUCTIVE (mirrors task-394-users-wiring.spec.ts): the dialog is
 * exercised up to an enabled confirm and then dismissed — no bulk mutation is
 * ever committed against seeded users. The live mutation path (per-item
 * envelope, AC-02 tier guard, RBAC 403) is covered API-side by
 * `apps/api/tests/e2e/task-398-users-bulk-role-export.spec.ts`.
 *
 * Persona = `superAdmin` on the first NON-system tenant so `canManage` holds.
 * Runs in all three viewport projects; the bulk-bar tests skip on mobile where
 * the card list has no row-selection surface (TASK-384 model, as task-394).
 */
import { test, expect, type Page } from './fixtures/auth';

const MOBILE_MAX = 768; // TASK-384: `< md` is the mobile card-list tier.

function isMobile(page: Page): boolean {
  return (page.viewportSize()?.width ?? 1280) < MOBILE_MAX;
}

/**
 * From the post-login `/tenants` landing, open the first NON-system tenant and
 * land on its Users tab (mirrors the task-394 helper).
 */
async function openFirstNonSystemTenantUsers(page: Page): Promise<void> {
  const mobile = isMobile(page);
  await page.goto('/tenants');

  if (mobile) {
    const list = page.locator('ul[aria-label="Tenants"]');
    await expect(list).toBeVisible();
    await list.locator('li').filter({ hasNotText: 'System' }).first().getByRole('button').first().click();
  } else {
    const grid = page.locator('[role="grid"][aria-label="Tenants"]');
    await expect(grid).toBeVisible();
    await grid.locator('[data-slot="data-grid-row"]').filter({ hasNotText: 'System' }).first().click();
  }

  await page.waitForURL(/\/tenants\/[^/]+/);

  if (mobile) {
    await page.getByRole('combobox', { name: 'Tenant section' }).click();
    await page.getByRole('option', { name: 'Users' }).click();
  } else {
    await page.getByRole('navigation', { name: 'Tenant sections' }).getByRole('link', { name: 'Users' }).click();
  }
  await page.waitForURL('**/users');
  await expect(page.getByLabel('Search').first()).toBeVisible();
}

test.describe('TASK-398 P1-6 — bulk Assign role', () => {
  test.beforeEach(async ({ page, loginAs }) => {
    await loginAs('superAdmin');
    await openFirstNonSystemTenantUsers(page);
  });

  test('bulk bar exposes Assign role alongside the TASK-394 actions', async ({ page }) => {
    test.skip(isMobile(page), 'Mobile card-list has no row-selection surface (TASK-384).');

    await page.getByRole('checkbox', { name: 'Select all rows' }).click();

    const bar = page.getByTestId('users-bulk-bar');
    await expect(bar).toBeVisible();
    // New affordance…
    await expect(bar.getByRole('button', { name: 'Assign role' })).toBeVisible();
    // …with every pre-existing action preserved (TASK-394 regression guard).
    await expect(bar.getByRole('button', { name: 'Enable' })).toBeVisible();
    await expect(bar.getByRole('button', { name: 'Disable' })).toBeVisible();
    await expect(bar.getByRole('button', { name: 'Assign department' })).toBeVisible();
    await expect(bar.getByRole('button', { name: 'Delete' })).toBeVisible();
    await expect(bar.getByRole('button', { name: 'Export CSV' })).toBeVisible();

    await bar.getByRole('button', { name: 'Clear selection' }).click();
    await expect(bar).toBeHidden();
  });

  test('Assign role opens the single-select picker fed by useRoles (dismissed uncommitted)', async ({ page }) => {
    test.skip(isMobile(page), 'Mobile card-list has no row-selection surface (TASK-384).');

    await page.getByRole('checkbox', { name: 'Select all rows' }).click();
    const bar = page.getByTestId('users-bulk-bar');
    await bar.getByRole('button', { name: 'Assign role' }).click();

    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('heading', { name: 'Assign role' })).toBeVisible();
    await expect(dialog.getByText(/\d+ users? selected/)).toBeVisible();

    // Seeded rbac roles render as radio rows (real useRoles data, not a stub).
    const nurseOption = dialog.getByRole('radio', { name: 'NURSE', exact: true });
    await expect(nurseOption).toBeVisible();

    // Search narrows the list…
    await dialog.getByLabel('Filter roles…').fill('nur');
    await expect(nurseOption).toBeVisible();
    await expect(dialog.getByRole('radio', { name: 'DOCTOR', exact: true })).toBeHidden();
    await dialog.getByLabel('Filter roles…').clear();

    // …and the confirm arms only once a role is picked.
    const confirm = dialog.getByRole('button', { name: 'Assign role' });
    await expect(confirm).toBeDisabled();
    await nurseOption.click();
    await expect(confirm).toBeEnabled();

    // Dismiss WITHOUT committing (non-destructive; selection survives).
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toBeHidden();
    await expect(bar).toBeVisible();
    await bar.getByRole('button', { name: 'Clear selection' }).click();
  });
});
