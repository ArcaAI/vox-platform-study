/**
 * TASK-379 — Page-based Tenant Detail + App-Shell — frontend E2E (Playwright).
 *
 * Drives the real Admin Console UI (Vite :5174) → real API (:8868). Runs across
 * the three viewport projects (desktop 1280 / tablet 834 / mobile 390) defined in
 * `playwright.config.ts`; every test ADAPTS to the active tier by reading the DOM
 * (e.g. is the underline tab-nav visible, or the mobile section `Select`?) rather
 * than hard-coding widths — so the same assertions hold on all three.
 *
 * Scope (the TASK-379 surfaces; generic responsive primitives belong to TASK-384):
 *   1. tenant list → detail navigation (grid row / mobile card → /tenants/:id)
 *   2. detail tab switching (desktop underline links · mobile `Select`)
 *   3. working-tenant switcher (sidebar on desktop/tablet · nav drawer on mobile)
 *   4. NoTenant state on a top-level tenant-scoped page (super-admin, no working tenant)
 *   5. a dialog (create-tenant) — full-screen on mobile
 *
 * Requires a seeded stack (see e2e/README.md). Without one, login fails fast;
 * the spec still LISTS (the authored-spec gate: `... --list`).
 */
import { test, expect } from './fixtures/auth';
import type { Page } from '@playwright/test';

const TENANT_HEADING = 'Tenants';
// The system tenant's key is the seeded `__GLOBAL__` workspace — always present,
// so it is a stable target to click from the fleet list on every viewport.
const STABLE_TENANT_KEY = '__GLOBAL__';

/** Open the first known tenant from the fleet list; leaves the page on its detail. */
async function openStableTenant(page: Page): Promise<void> {
  await expect(page.getByRole('heading', { name: TENANT_HEADING })).toBeVisible();
  // The fleet renders the key as a cell (desktop/tablet grid) and as a card
  // subtitle (mobile). Clicking it bubbles to the row/card click handler.
  await page.getByText(STABLE_TENANT_KEY, { exact: true }).first().click();
  await page.waitForURL(/\/tenants\/[0-9a-f-]{8}/i);
}

/** True on the mobile tier — the app-bar hamburger only mounts below `md`. */
async function isMobileViewport(page: Page): Promise<boolean> {
  return page.getByRole('button', { name: 'Open navigation' }).isVisible();
}

test.describe('TASK-379 — tenant detail + app-shell (FE)', () => {
  test('1. fleet list → tenant detail navigation', async ({ page, loginAs }) => {
    await loginAs('superAdmin');
    await openStableTenant(page);

    // The detail layout is up: either the desktop/tablet underline tab-nav OR
    // the mobile section Select is present.
    const tabNav = page.getByRole('navigation', { name: 'Tenant sections' });
    const sectionSelect = page.getByRole('combobox', { name: 'Tenant section' });
    await expect(tabNav.or(sectionSelect)).toBeVisible();
  });

  test('2. tenant detail tab switching (underline tabs ↔ mobile Select)', async ({ page, loginAs }) => {
    await loginAs('superAdmin');
    await openStableTenant(page);

    const tabNav = page.getByRole('navigation', { name: 'Tenant sections' });
    const sectionSelect = page.getByRole('combobox', { name: 'Tenant section' });
    await expect(tabNav.or(sectionSelect)).toBeVisible();

    if (await tabNav.isVisible()) {
      // Desktop / tablet — horizontal underline tabs (TanStack <Link>).
      const config = tabNav.getByRole('link', { name: 'Configuration' });
      await config.click();
      await page.waitForURL('**/configuration');
      await expect(config, 'active tab carries data-status=active (teal underline)').toHaveAttribute('data-status', 'active');

      await tabNav.getByRole('link', { name: 'Users' }).click();
      await page.waitForURL('**/users');
    } else {
      // Mobile — the tab set collapses to a labelled Select.
      await sectionSelect.click();
      await page.getByRole('option', { name: 'Configuration' }).click();
      await page.waitForURL('**/configuration');
    }
  });

  test('3. working-tenant switcher opens (super-admin)', async ({ page, loginAs }, testInfo) => {
    await loginAs('superAdmin');
    await page.waitForURL('**/tenants');

    // The switcher sits in the persistent sidebar (desktop/tablet) or at the bottom of
    // the nav drawer (mobile) — open the drawer first on mobile.
    if (testInfo.project.name === 'mobile') {
      await page.getByRole('button', { name: 'Open navigation' }).click();
    }
    // The shell mounts the switcher in three slots (collapsed rail · full sidebar ·
    // drawer), only one of which is visible per tier — target that visible one.
    const switcher = page.getByRole('button', { name: /Switch working tenant/i }).filter({ visible: true });
    await switcher.click();

    // The popover Command is open — assert its "Manage tenants" entry (unique to the
    // popover). cmdk renders CommandItems with role="option" (the `asChild` <Link>
    // inherits that role), so query the option rather than a link.
    await expect(page.getByRole('option', { name: 'Manage tenants' })).toBeVisible();
  });

  test('4. NoTenant state on a top-level tenant-scoped page (super-admin)', async ({ page, loginAs }) => {
    await loginAs('superAdmin');
    await page.waitForURL('**/tenants');

    // A super-admin with no working tenant gets a guided empty state (GAP-ADM-001),
    // not a blank/erroring grid, on the top-level (non-tenant-scoped) Users page.
    await page.goto('/users');
    await expect(page.getByText('Select a tenant to continue')).toBeVisible();
    await expect(page.getByRole('link', { name: 'View all tenants' })).toBeVisible();
  });

  test('5. create-tenant dialog opens (full-screen on mobile)', async ({ page, loginAs }) => {
    await loginAs('superAdmin');
    await page.waitForURL('**/tenants');

    // Desktop/tablet → header "New tenant"; mobile → the FAB. Both expose the
    // same accessible name, and only the visible one is in the a11y tree.
    await page.getByRole('button', { name: 'New tenant' }).click();

    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    // The dialog has both an <h2> title and a submit <button> reading "Create tenant";
    // target the heading so the locator is unambiguous.
    await expect(dialog.getByRole('heading', { name: 'Create tenant' })).toBeVisible();
    await expect(dialog.getByLabel('Name', { exact: true })).toBeVisible();
    // TASK-387 #3 — the commercial plan selector is now part of create/edit.
    await expect(dialog.getByLabel('Plan')).toBeVisible();

    // On mobile the modal is (near-)full-screen (MOBILE_DIALOG_CONTENT: w-full
    // max-w-none). Verify the content spans the viewport width.
    if (await isMobileViewport(page)) {
      const box = await dialog.boundingBox();
      const width = page.viewportSize()?.width ?? 0;
      expect(box, 'dialog has a layout box').toBeTruthy();
      expect(box!.width, 'mobile dialog is full-bleed').toBeGreaterThanOrEqual(width - 2);
    }
  });

  test('6. tenant detail surfaces the plan + tags meta; lifecycle hidden on the system tenant (TASK-387)', async ({ page, loginAs }) => {
    await loginAs('superAdmin');
    await openStableTenant(page);

    // The detail header renders the commercial plan + tags meta for every tenant
    // (values read em-dash when unset); the labels are always present (#1 / #2).
    await expect(page.getByText('Plan', { exact: true })).toBeVisible();
    await expect(page.getByText('Tags', { exact: true })).toBeVisible();

    // DEF-ADM-002 — the stable target is the system tenant (__GLOBAL__), which is
    // backend-protected from suspend/archive/restore; the UI mirrors that by
    // hiding the lifecycle menu (and showing the protected note instead).
    await expect(page.getByRole('button', { name: 'More lifecycle actions' })).toHaveCount(0);
  });
});
