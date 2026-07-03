/**
 * TASK-394 P0-1 — Users surfaces wired to the TASK-388 backends (FE E2E).
 *
 * Proves the newly-wired Users affordances drive the real SDK/API (login is the
 * shared seeded-persona fixture; the dev server proxies `/api/v1` → the gateway):
 *   - **Reset password** dialog (temp-password + reset-link modes) opens from a
 *     row action — `useUsers().resetPassword`.
 *   - **Server export** menu (CSV / Excel / PDF) triggers a real file download —
 *     `useUsers().exportUsers` (read-only over the filtered set).
 *   - **Bulk bar** exposes the four server bulk actions once rows are selected —
 *     `useUsers().bulkAction` (desktop/tablet grid; mobile card-list has no
 *     row-selection surface, so that assertion is desktop/tablet only).
 *   - **User detail** surfaces the cross-user **Personal instructions**
 *     (`usePrompts` `USER_PERSONAL`) and **Preferences** (`useUserSettings`
 *     `listForUser`) panels.
 *
 * Persona = `superAdmin` opening a NON-system tenant so `canManage` holds (the
 * create/reset/bulk affordances render). Runs in all three viewport projects.
 *
 * NON-DESTRUCTIVE: dialogs are opened and dismissed and export is a read; no
 * reset/bulk/edit mutation is ever committed.
 *
 * @see task-381-users-management.spec.ts (surface shape) · docs/implementation/TASK-394-*
 */
import { test, expect, type Page } from './fixtures/auth';

const MOBILE_MAX = 768; // TASK-384: `< md` is the mobile card-list tier.

function isMobile(page: Page): boolean {
  return (page.viewportSize()?.width ?? 1280) < MOBILE_MAX;
}

/**
 * From the post-login `/tenants` landing, open the first NON-system tenant and
 * land on its Users tab (mirrors `task-381`'s helper). Non-system → `canManage`
 * is true. Works on every viewport (grid row vs card; nav link vs Select).
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
  // The Users surface is mounted (search is present on every tier).
  await expect(page.getByLabel('Search').first()).toBeVisible();
}

/** Open the first user's detail (member cell button / card) — viewport-agnostic. */
async function openFirstUserDetail(page: Page): Promise<void> {
  if (isMobile(page)) {
    await page.locator('ul[aria-label="Tenant users"] li').first().getByRole('button').first().click();
  } else {
    await page.locator('[role="grid"][aria-label="Tenant users"] [data-slot="data-grid-row"]').first().getByRole('button').first().click();
  }
  await page.waitForURL(/\/users\/[0-9a-fA-F-]{6,}/);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
}

/** Switch a user-detail section (underline nav ≥768, Select < 768). */
async function selectUserTab(page: Page, label: string): Promise<void> {
  if (isMobile(page)) {
    const sel = page.getByRole('combobox', { name: 'User section' });
    await sel.click();
    await page.getByRole('option', { name: label }).click();
  } else {
    await page.getByRole('navigation', { name: 'User sections' }).getByRole('button', { name: label }).click();
  }
}

test.describe('TASK-394 P0-1 — Users backends wired', () => {
  test.beforeEach(async ({ page, loginAs }) => {
    await loginAs('superAdmin');
    await openFirstNonSystemTenantUsers(page);
  });

  test('reset-password dialog opens with both modes', async ({ page }) => {
    // Drive from the user-detail header (a plain button on every viewport —
    // avoids the touch-dropdown quirk of the row action menu on mobile). The
    // profile panel also exposes a reset button now, so take the first
    // (DOM-order = the header action).
    await openFirstUserDetail(page);
    await page.getByRole('button', { name: 'Reset password', exact: true }).first().click();

    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('heading', { name: 'Reset password' })).toBeVisible();

    // Both REAL modes are offered (Radix single ToggleGroup → role="radio";
    // link is the default). `useUsers().resetPassword` backs both.
    const linkMode = dialog.getByRole('radio', { name: 'Send reset link' });
    const tempMode = dialog.getByRole('radio', { name: 'Temporary password' });
    await expect(linkMode).toBeVisible();
    await expect(tempMode).toBeVisible();

    // Switching to temporary reveals the (optional) temp-password field.
    await tempMode.click();
    await expect(dialog.getByLabel('Temporary password')).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Set temporary password' })).toBeVisible();

    // Dismiss WITHOUT committing a reset (non-destructive).
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toBeHidden();
  });

  test('server export menu (CSV/Excel/PDF) triggers a real file download', async ({ page }) => {
    await page.getByRole('button', { name: 'Export' }).click();
    await expect(page.getByRole('menuitem', { name: 'Export as CSV' })).toBeVisible();
    await expect(page.getByRole('menuitem', { name: 'Export as Excel' })).toBeVisible();
    await expect(page.getByRole('menuitem', { name: 'Export as PDF' })).toBeVisible();

    // A CSV export is a read over the filtered set — non-destructive — and
    // proves the SDK `exportUsers` → blob → download path end to end.
    const downloadPromise = page.waitForEvent('download', { timeout: 20_000 });
    await page.getByRole('menuitem', { name: 'Export as CSV' }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(/users-.*\.csv$/);
  });

  test('bulk bar exposes the server bulk actions when rows are selected', async ({ page }) => {
    test.skip(isMobile(page), 'Mobile card-list has no row-selection surface (TASK-384).');

    // Select all rows → the grid renders the bulk `actionBar`.
    await page.getByRole('checkbox', { name: 'Select all rows' }).click();

    // Scope to the bulk bar — the tenant-detail header has its own
    // Enable/Disable buttons that would otherwise collide by name.
    const bar = page.getByTestId('users-bulk-bar');
    await expect(bar).toBeVisible();
    await expect(bar.getByText(/\d+ users? selected/)).toBeVisible();
    // The four server bulk actions + the client CSV of the selection.
    await expect(bar.getByRole('button', { name: 'Enable' })).toBeVisible();
    await expect(bar.getByRole('button', { name: 'Disable' })).toBeVisible();
    await expect(bar.getByRole('button', { name: 'Assign department' })).toBeVisible();
    await expect(bar.getByRole('button', { name: 'Delete' })).toBeVisible();
    await expect(bar.getByRole('button', { name: 'Export CSV' })).toBeVisible();

    // Clear the selection — never invoke a bulk mutation (non-destructive).
    await bar.getByRole('button', { name: 'Clear selection' }).click();
    await expect(bar).toBeHidden();
  });

  test('user detail surfaces cross-user Personal instructions + Preferences panels', async ({ page }) => {
    await openFirstUserDetail(page);

    // Agent instructions → the USER_PERSONAL section (usePrompts doctor-scoped).
    await selectUserTab(page, 'Agent instructions');
    await expect(page.getByRole('heading', { name: 'Personal instructions' })).toBeVisible();

    // Preferences → the admin cross-user editor (useUserSettings.listForUser).
    await selectUserTab(page, 'Preferences');
    await expect(page.getByText(/stored preferences/i)).toBeVisible();
  });
});
