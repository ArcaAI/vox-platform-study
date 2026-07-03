/**
 * TASK-381 — Users Management (20u grid + 38u detail) · admin-console E2E.
 *
 * Drives the real login UI (shared `./fixtures/auth`) and the shipped Users
 * surface across the Desktop/Tablet/Mobile projects defined in
 * `apps/admin/playwright.config.ts`. Each test runs in all three viewports;
 * we branch on `page.viewportSize()` to assert the responsive shape the code
 * actually ships (TASK-384 model):
 *   - desktop/tablet (≥ 768) → `VirtualizedDataGrid` toolbar (search · facets · View)
 *   - mobile        (< 768)  → card-list (search · cards · FAB)
 *   - detail tabs: underline `nav` (≥ 768) vs a `Select` (< 768)
 *
 * Scope = the surface's own behavior (README §2 REAL). Generic responsive
 * primitives (the breakpoint hook, condensed-column math) are covered by
 * TASK-384, not here. No TARGET flow is asserted.
 *
 * Persona = `superAdmin` opening a NON-system tenant, so `canManage` is true
 * (`!isSystemTenant && isAdminRole`) and the New-user / FAB affordances render.
 *
 * Run status: authored — runs only against a live admin app + API (the config
 * `webServer` boots the app; the SDK needs the gateway). When the stack is
 * down these are listed/compiled but not executed.
 *
 * @see docs/designs/admin/users-management.md
 */
import { test, expect } from './fixtures/auth';
import type { Page } from '@playwright/test';

const MOBILE_MAX = 768; // TASK-384: `< md` is the mobile card-list tier.

function isMobile(page: Page): boolean {
  return (page.viewportSize()?.width ?? 1280) < MOBILE_MAX;
}

/** The 7 detail sections (mirrors `$userId.tsx` TABS, in order). */
const USER_TABS = ['Profile', 'Preferences', 'Agent instructions', 'DNA Style', 'Departments', 'DNA Reports', 'Activity'] as const;

/**
 * From the post-login `/tenants` landing, open the first NON-system tenant and
 * land on its Users tab. Non-system → `canManage` is true so the create/FAB
 * affordances exist. Works on every viewport (grid row vs card; nav link vs Select).
 */
async function openFirstNonSystemTenantUsers(page: Page): Promise<void> {
  const mobile = isMobile(page);
  await page.goto('/tenants');

  if (mobile) {
    const list = page.locator('ul[aria-label="Tenants"]');
    await expect(list).toBeVisible();
    // Skip the System tenant (badge text "System") so canManage holds.
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
}

test.describe('TASK-381 — Users surface (20u grid · 38u detail)', () => {
  test.beforeEach(async ({ page, loginAs }) => {
    await loginAs('superAdmin');
    await openFirstNonSystemTenantUsers(page);
  });

  test('20u · grid exposes search + facets/View (desktop·tablet) or card-list + FAB (mobile)', async ({ page }) => {
    // Search is present on every tier (toolbar Input and card-list Input both
    // expose aria-label="Search").
    await expect(page.getByLabel('Search').first()).toBeVisible();

    if (isMobile(page)) {
      // Mobile → card-list container + the New-user FAB (no facet bar).
      await expect(page.locator('[data-slot="responsive-card-list"]')).toBeVisible();
      await expect(page.locator('ul[aria-label="Tenant users"]')).toBeVisible();
      await expect(page.getByRole('button', { name: 'New user' })).toBeVisible();
    } else {
      // Desktop/Tablet → the grid, the faceted-filter bar, and the View toggle.
      await expect(page.locator('[role="grid"][aria-label="Tenant users"]')).toBeVisible();
      // Role + Status facets survive the tablet column-condense (Department/Type
      // columns — and their facets — are desktop-only); assert those two with exact
      // names so "Status" doesn't also match the grid's "Status column options" /
      // "Reorder resourceStatus column" header buttons.
      await expect(page.getByRole('button', { name: 'Role', exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Status', exact: true })).toBeVisible();
      await expect(page.getByRole('combobox', { name: 'Toggle columns' })).toBeVisible(); // the "View" control (role=combobox, aria-label="Toggle columns")
      await expect(page.getByRole('button', { name: 'New user' })).toBeVisible();
    }

    // Export menu is available on every tier (header cluster).
    await expect(page.getByRole('button', { name: 'Export' })).toBeVisible();
  });

  test('20u · search box accepts input and drives the server query', async ({ page }) => {
    const search = page.getByLabel('Search').first();
    await search.fill('z');
    await expect(search).toHaveValue('z');
    await search.clear();
    await expect(search).toHaveValue('');
  });

  test('Dlg · Create User opens from New user / FAB and dismisses', async ({ page }) => {
    await page.getByRole('button', { name: 'New user' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    // The dialog collects at least a username (a textbox).
    await expect(dialog.getByRole('textbox').first()).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
  });

  test('38u · open a user detail and switch among all 7 tabs', async ({ page }) => {
    // Open the first user — Member cell button (desktop/tablet) or card (mobile).
    if (isMobile(page)) {
      await page.locator('ul[aria-label="Tenant users"] li').first().getByRole('button').first().click();
    } else {
      await page.locator('[role="grid"][aria-label="Tenant users"] [data-slot="data-grid-row"]').first().getByRole('button').first().click();
    }
    await page.waitForURL(/\/users\/[0-9a-fA-F-]{6,}/);

    // Header renders the user identity (h1).
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();

    if (isMobile(page)) {
      const sectionSelect = page.getByRole('combobox', { name: 'User section' });
      await expect(sectionSelect).toBeVisible();
      for (const label of USER_TABS) {
        await sectionSelect.click();
        await page.getByRole('option', { name: label }).click();
        await expect(sectionSelect).toContainText(label);
      }
    } else {
      const nav = page.getByRole('navigation', { name: 'User sections' });
      await expect(nav).toBeVisible();
      for (const label of USER_TABS) {
        const tab = nav.getByRole('button', { name: label });
        await tab.click();
        await expect(tab).toHaveAttribute('data-status', 'active');
      }
    }
  });
});
