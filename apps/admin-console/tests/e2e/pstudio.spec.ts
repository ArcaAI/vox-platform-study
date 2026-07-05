/**
 * Frame 19 — Prisma Studio screen spec: the status probe resolves to either
 * the truthful disabled card or the guarded iframe shell (never a broken
 * iframe), with the axe gate in both themes (rule 11 §11).
 */

import { expect, test, type Page } from '@playwright/test';
import { expectNoA11yViolations } from './helpers/a11y';
import { loginAsAdmin } from './helpers/auth';
import { API_DOWN_MESSAGE, APP_DOWN_MESSAGE, apiAvailable, appAvailable } from './helpers/stack';

test.beforeEach(async ({ page }) => {
    test.skip(!(await appAvailable()), APP_DOWN_MESSAGE);
    test.skip(!(await apiAvailable()), API_DOWN_MESSAGE);
    await loginAsAdmin(page);
});

async function openPstudio(page: Page) {
    await page.goto('/pstudio');
    await expect(page.getByRole('heading', { level: 1, name: 'Prisma Studio' })).toBeVisible();
    await expect(page.getByText('Production data')).toBeVisible();
    // Settle the status probe (skeleton surface gives way to card or iframe).
    await expect(page.locator('[data-slot="skeleton"]')).toHaveCount(0);
    // Truthful status surface: enabled -> iframe shell; disabled -> card.
    const surface = page.locator('iframe[title="Prisma Studio"]').or(page.getByText('Prisma Studio is disabled'));
    await expect(surface.first()).toBeVisible();
}

test.describe('prisma studio screen', () => {
    test('renders the status surface with no WCAG 2.2 AA violations (light)', async ({ page }) => {
        await page.emulateMedia({ colorScheme: 'light' });
        await openPstudio(page);
        await expectNoA11yViolations(page);
    });

    test('renders the status surface with no WCAG 2.2 AA violations (dark)', async ({ page }) => {
        await page.emulateMedia({ colorScheme: 'dark' });
        await openPstudio(page);
        await expectNoA11yViolations(page);
    });

    test('pairs the iframe shell with an open-in-new-tab escape hatch when enabled', async ({ page }) => {
        await page.emulateMedia({ colorScheme: 'light' });
        await openPstudio(page);
        const iframe = page.locator('iframe[title="Prisma Studio"]');
        test.skip((await iframe.count()) === 0, 'Prisma Studio is disabled in this environment');
        await expect(iframe).toHaveAttribute('src', '/api/hope/admin/pstudio');
        const openLink = page.getByRole('link', { name: 'Open in new tab' });
        await expect(openLink).toBeVisible();
        await expect(openLink).toHaveAttribute('href', '/api/hope/admin/pstudio');
    });
});
