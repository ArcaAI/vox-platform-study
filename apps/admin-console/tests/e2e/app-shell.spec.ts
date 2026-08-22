/**
 * App-shell chrome pinning (frame 07 topbar). The page header (breadcrumb
 * topbar) and session banners are shell chrome: they must stay pinned at the
 * viewport top while the page content scrolls. Regression spec for the bug
 * where the chrome scrolled away with the window.
 */

import { expect, test } from '@playwright/test';
import { loginAsAdmin } from './helpers/auth';
import { API_DOWN_MESSAGE, APP_DOWN_MESSAGE, apiAvailable, appAvailable } from './helpers/stack';

test.beforeEach(async ({ page }) => {
  test.skip(!(await appAvailable()), APP_DOWN_MESSAGE);
  test.skip(!(await apiAvailable()), API_DOWN_MESSAGE);
  await loginAsAdmin(page);
});

test.describe('app shell chrome (frame 07)', () => {
  test('topbar with breadcrumb stays pinned while the page scrolls', async ({ page }) => {
    // Short viewport so any seeded dataset makes the page scroll.
    await page.setViewportSize({ width: 1280, height: 480 });
    await page.goto('/users');
    await expect(page.getByRole('heading', { level: 1, name: 'Users' })).toBeVisible();

    const breadcrumb = page.getByRole('navigation', { name: 'breadcrumb' });
    await expect(breadcrumb).toBeInViewport();

    const scrollContainer = page.getByRole('grid', { name: 'Users' });
    const scrolled = await scrollContainer.evaluate((el) => {
      el.scrollTop = el.scrollHeight;
      return el.scrollTop;
    });
    test.skip(scrolled === 0, 'page does not scroll at a 480px viewport — nothing to assert');

    // Chrome must stay pinned: breadcrumb visible, topbar flush with the viewport top.
    await expect(breadcrumb).toBeInViewport();
    const headerBox = await page.locator('header').boundingBox();
    expect(headerBox?.y).toBe(0);
  });

  test('collapsing hides the sidebar off-canvas and leaves the domain rail', async ({ page }) => {
    // TASK-788 changed this behaviour deliberately. The sidebar was
    // `collapsible="icon"`; with a permanent 56px domain rail beside it, an
    // icon-collapsed sidebar is a SECOND column of unlabelled icons — the exact
    // defect the domain rail exists to remove (HOPE-16: 56 routes, collapsed to
    // 56 unlabelled icons). Collapsed now means "rail only".
    await page.setViewportSize({ width: 1280, height: 480 });
    await page.goto('/dashboard');

    // Scope by data-slot, not by landmark name: TASK-788 names the sidebar's nav
    // after the ACTIVE DOMAIN ("Overview navigation", "Tenancy navigation", …) so
    // it is distinguishable from the rail's "Capability domains". The name is
    // therefore route-dependent and not a stable test handle.
    const nav = page.locator('[data-slot="sidebar-content"]');
    const dashboardLink = nav.getByRole('link', { name: 'Dashboard' });
    await expect(dashboardLink).toBeVisible();
    await expect(dashboardLink.locator('svg[aria-hidden="true"]')).toBeVisible();
    expect(await dashboardLink.getAttribute('aria-current')).toBe('page');

    const rail = page.getByRole('navigation', { name: 'Capability domains' });
    await expect(rail).toBeVisible();

    await page.locator('[data-slot="sidebar-trigger"]').click();
    const sidebar = page.locator('[data-slot="sidebar"]');
    await expect(sidebar).toHaveAttribute('data-state', 'collapsed');
    await expect(sidebar).toHaveAttribute('data-collapsible', 'offcanvas');

    // "Left the layout" is the sidebar GAP collapsing to 0 — that is the primitive's
    // actual contract. The fixed panel itself slides to left:-248px and its last
    // 56px still overlaps the viewport behind the opaque rail, so asserting the
    // panel's own position would test an implementation detail, not the behaviour.
    await expect(page.locator('[data-slot="sidebar-gap"]')).toHaveCSS('width', '0px');

    // The rail stays, so every domain is still one click away and nothing
    // collapses to a bare icon column.
    await expect(rail).toBeVisible();
    await expect(rail).toBeInViewport();

    // Toggle round-trip: expanding restores the labelled sidebar.
    await page.locator('[data-slot="sidebar-trigger"]').click();
    await expect(sidebar).toHaveAttribute('data-state', 'expanded');
    await expect(dashboardLink).toContainText('Dashboard');
  });
});
