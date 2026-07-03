/**
 * TASK-372 — shared-component FRONTEND E2E (Playwright, full-stack).
 *
 * Exercises the flagship `@arcaai/ui` `VirtualizedDataGrid` exactly as the admin
 * console consumes it, on the **Tenants** surface (`/tenants`) — the post-login
 * landing page, a client-mode grid (search/sort/filter/column-features all
 * client-side), reachable by `super_admin` with no working-tenant gate. It runs
 * across the three approved viewport tiers (desktop / tablet / mobile); the
 * responsive wrapper (`features/data-grid/responsive-data-grid.tsx`) renders the
 * grid on desktop+tablet and a tap-through card-list on mobile (`< md 768`).
 *
 * Covered (per the TASK-372 review brief): sort, faceted filter, global search,
 * column visibility (View), density toggle, and the mobile card-list.
 *
 * NOTE — the other two flagship components have **no admin route**:
 *   - `HistoryTimelineList` is wired on `/history` (clinical consultation data),
 *     not a data-grid surface;
 *   - `LiveTranscript` is wired on `/live` (a live STT stream).
 * Their behavior is covered by the `@arcaai/ui` Vitest suites + the manual QA
 * checklist (MANUAL-E2E-TESTS.md); they are out of scope for this grid-focused
 * admin E2E.
 *
 * Gate without a stack (authored-spec proof):
 *   pnpm exec playwright test --config apps/admin/playwright.config.ts --list
 * Run (needs a seeded stack on :8868 — see e2e/README.md):
 *   pnpm exec playwright test --config apps/admin/playwright.config.ts
 */
import { test, expect } from './fixtures/auth';

/** Tiers that render the real grid; mobile renders the card-list instead. */
const GRID_TIERS = ['desktop', 'tablet'];

test.describe('TASK-372 — VirtualizedDataGrid on the admin Tenants surface', () => {
  test.beforeEach(async ({ loginAs, page }) => {
    // super_admin lands on /tenants (the fixture waits for that URL).
    await loginAs('superAdmin');
    await page.goto('/tenants');
  });

  // ---- Desktop / Tablet: the data grid -------------------------------------

  test('grid renders with accessible roles and data rows', async ({ page }, testInfo) => {
    test.skip(!GRID_TIERS.includes(testInfo.project.name), 'mobile renders a card-list (see the mobile test)');

    const grid = page.getByRole('grid', { name: 'Tenants' });
    await expect(grid).toBeVisible();
    // role="grid" carries the virtualization-aware true row total.
    await expect(grid).toHaveAttribute('aria-rowcount', /\d+/);
    await expect(page.locator('[data-slot="data-grid-row"]').first()).toBeVisible();
  });

  test('global search narrows to the empty state and recovers on clear', async ({ page }, testInfo) => {
    test.skip(!GRID_TIERS.includes(testInfo.project.name), 'mobile search is covered in the card-list test');

    await expect(page.locator('[data-slot="data-grid-row"]').first()).toBeVisible();
    const search = page.getByRole('textbox', { name: 'Search' });

    // A term that cannot match any tenant → deterministic empty state.
    await search.fill('zzz-no-such-tenant-xyz');
    await expect(page.getByText('No results')).toBeVisible();

    await search.fill('');
    await expect(page.locator('[data-slot="data-grid-row"]').first()).toBeVisible();
  });

  test('column header sort flips aria-sort to descending', async ({ page }, testInfo) => {
    test.skip(!GRID_TIERS.includes(testInfo.project.name), 'sort menu is grid-only');

    await page.getByRole('button', { name: 'Name column options' }).click();
    await page.getByRole('menuitemcheckbox', { name: 'Desc' }).click();

    const nameHeader = page.getByRole('columnheader').filter({ has: page.getByRole('button', { name: 'Name column options' }) });
    await expect(nameHeader).toHaveAttribute('aria-sort', 'descending');
  });

  test('faceted Status filter applies (Reset affordance appears)', async ({ page }, testInfo) => {
    test.skip(!GRID_TIERS.includes(testInfo.project.name), 'faceted filters are grid-only');

    await page.getByRole('button', { name: 'Status' }).click();
    // Pick the first facet option from the popover command list.
    await page.getByRole('option').first().click();
    await page.keyboard.press('Escape');

    // An active filter surfaces the toolbar Reset control.
    await expect(page.getByRole('button', { name: 'Reset' })).toBeVisible();
  });

  test('View options can hide a column (column count decreases)', async ({ page }, testInfo) => {
    test.skip(!GRID_TIERS.includes(testInfo.project.name), 'the View menu is grid-only');

    const headers = page.getByRole('columnheader');
    // Wait for the grid to hydrate its header row before capturing the baseline —
    // otherwise `before` is read as 0 (pre-hydration) and `before - 1` is negative.
    await expect(headers.first()).toBeVisible();
    await expect.poll(() => headers.count()).toBeGreaterThan(0);
    const before = await headers.count();

    await page.getByRole('combobox', { name: 'Toggle columns' }).click();
    await page.getByRole('option', { name: 'Key' }).click();
    await page.keyboard.press('Escape');

    await expect(headers).toHaveCount(before - 1);
  });

  test('density toggle switches the grid to compact', async ({ page }, testInfo) => {
    test.skip(!GRID_TIERS.includes(testInfo.project.name), 'the density toggle lives in the grid toolbar');

    const wrapper = page.locator('[data-slot="virtualized-data-grid"]');
    await expect(wrapper).toHaveAttribute('data-density', 'comfortable');

    // Scope to the grid toolbar: the app-shell header hosts a second density toggle
    // with the same aria-label, so an unscoped query is a strict-mode violation.
    await wrapper.getByRole('button', { name: 'Switch to compact density' }).click();
    await expect(wrapper).toHaveAttribute('data-density', 'compact');
    // The control now offers the inverse action.
    await expect(wrapper.getByRole('button', { name: 'Switch to comfortable density' })).toBeVisible();
  });

  // ---- Mobile: the card-list -----------------------------------------------

  test('mobile renders a tap-through card-list with search + FAB', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'mobile', 'desktop/tablet render the grid, not the card-list');

    const list = page.getByRole('list', { name: 'Tenants' });
    await expect(list).toBeVisible();
    await expect(list.getByRole('listitem').first()).toBeVisible();
    // Floating primary action (New tenant) + client search box.
    await expect(page.getByRole('button', { name: 'New tenant' })).toBeVisible();
    await expect(page.getByRole('textbox', { name: 'Search' })).toBeVisible();
  });

  test('mobile card-list search narrows to the empty state', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'mobile', 'mobile-only');

    const list = page.getByRole('list', { name: 'Tenants' });
    await expect(list.getByRole('listitem').first()).toBeVisible();

    const search = page.getByRole('textbox', { name: 'Search' });
    await search.fill('zzz-no-such-tenant-xyz');
    await expect(page.getByText('No results')).toBeVisible();

    await search.fill('');
    await expect(list.getByRole('listitem').first()).toBeVisible();
  });

  test('mobile: tapping a card opens the tenant detail route', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'mobile', 'mobile-only');

    const list = page.getByRole('list', { name: 'Tenants' });
    await list.getByRole('button').first().click();
    await page.waitForURL(/\/tenants\/[0-9a-fA-F-]+/);
  });
});
