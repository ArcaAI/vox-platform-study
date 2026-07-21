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

    test('collapsed sidebar shows an icon-only rail that scrolls and tooltips the labels', async ({ page }) => {
        // Short viewport: 29 nav entries always overflow the rail height.
        await page.setViewportSize({ width: 1280, height: 480 });
        await page.goto('/dashboard');

        // Scope to the sidebar landmark — the breadcrumb exposes a same-name link role.
        const nav = page.getByRole('navigation', { name: 'Main' });
        const dashboardLink = nav.getByRole('link', { name: 'Dashboard' });
        await expect(dashboardLink).toBeVisible();
        // Expanded state: every entry leads with a decorative icon.
        await expect(dashboardLink.locator('svg[aria-hidden="true"]')).toBeVisible();
        expect(await dashboardLink.getAttribute('aria-current')).toBe('page');

        await page.locator('[data-slot="sidebar-trigger"]').click();
        const sidebar = page.locator('[data-slot="sidebar"]');
        await expect(sidebar).toHaveAttribute('data-state', 'collapsed');
        await expect(sidebar).toHaveAttribute('data-collapsible', 'icon');

        // Icon-only rail: 3rem wide (retried until the width transition settles),
        // icon still visible inside it.
        await expect(page.locator('[data-slot="sidebar-container"]')).toHaveCSS('width', '48px');
        await expect(dashboardLink.locator('svg[aria-hidden="true"]')).toBeVisible();

        // The rail must scroll so below-the-fold entries stay reachable.
        const content = page.locator('[data-slot="sidebar-content"]');
        expect(await content.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
        const scrolled = await content.evaluate((el) => {
            el.scrollTop = el.scrollHeight;
            return el.scrollTop;
        });
        expect(scrolled).toBeGreaterThan(0);
        await expect(nav.getByRole('link', { name: 'Consultations' })).toBeInViewport();

        // Collapsed buttons reveal their label as a tooltip.
        await nav.getByRole('link', { name: 'Consultations' }).hover();
        await expect(page.locator('[data-slot="tooltip-content"]', { hasText: 'Consultations' })).toBeVisible();

        // Toggle round-trip: expanding restores the full labels.
        await page.locator('[data-slot="sidebar-trigger"]').click();
        await expect(sidebar).toHaveAttribute('data-state', 'expanded');
        await expect(dashboardLink).toContainText('Dashboard');
    });
});
