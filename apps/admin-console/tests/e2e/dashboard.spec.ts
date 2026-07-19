/**
 * Frame 10 — Platform Dashboard screen spec: loaded regions + the rule 11 §11
 * axe gate in both themes. Skips when the stack is not running.
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

async function assertLoadedDashboard(page: Page): Promise<void> {
    await expect(page.getByRole('heading', { level: 1, name: 'Platform Dashboard' })).toBeVisible();
    // One meaningful region per audience: stat tiles + the audit activity card.
    await expect(page.getByText('Requests / min').first()).toBeVisible();
    await expect(page.getByRole('heading', { level: 2, name: 'Recent admin activity' })).toBeVisible();
    // Scope to main: the sidebar carries an identically named nav link.
    await expect(page.getByRole('main').getByRole('link', { name: /audit logs/i })).toBeVisible();
}

test.describe('platform dashboard', () => {
    test('renders loaded regions with no WCAG 2.2 AA violations (light)', async ({ page }) => {
        await page.emulateMedia({ colorScheme: 'light' });
        await page.goto('/dashboard');
        await assertLoadedDashboard(page);
        await expectNoA11yViolations(page);
    });

    test('renders loaded regions with no WCAG 2.2 AA violations (dark)', async ({ page }) => {
        // next-themes defaultTheme="system": emulating the media query flips
        // the .dark class without touching client storage.
        await page.emulateMedia({ colorScheme: 'dark' });
        await page.goto('/dashboard');
        await assertLoadedDashboard(page);
        await expectNoA11yViolations(page);
    });

    test('shows skeletons before the loaded regions settle', async ({ page }) => {
        await page.emulateMedia({ colorScheme: 'light' });
        await page.goto('/dashboard');
        const skeletons = page.locator('[data-slot="skeleton"]');
        await expect(skeletons.first()).toBeVisible();
        await assertLoadedDashboard(page);
        await expect(skeletons).toHaveCount(0);
    });

    test('navigates to /audit-logs from the recent activity card link', async ({ page }) => {
        await page.emulateMedia({ colorScheme: 'light' });
        await page.goto('/dashboard');
        await assertLoadedDashboard(page);
        await page.getByRole('main').getByRole('link', { name: /audit logs/i }).click();
        await page.waitForURL('**/audit-logs');
        await expect(page.getByRole('heading', { level: 1, name: 'Audit logs' })).toBeVisible();
    });

    test('renders the requests-by-service chart region', async ({ page }) => {
        await page.emulateMedia({ colorScheme: 'light' });
        await page.goto('/dashboard');
        await assertLoadedDashboard(page);
        const chartImage = page.getByRole('img', { name: 'Requests per minute by service' });
        const hasSeries = await chartImage.isVisible().catch(() => false);
        if (hasSeries) {
            await expect(chartImage).toBeVisible();
        } else {
            await expect(page.getByText('No traffic yet')).toBeVisible();
        }
    });

    test('renders recent admin activity rows or the empty state', async ({ page }) => {
        await page.emulateMedia({ colorScheme: 'light' });
        await page.goto('/dashboard');
        await assertLoadedDashboard(page);
        const list = page.getByRole('list', { name: 'Recent admin activity' });
        const hasRows = await list.isVisible().catch(() => false);
        if (hasRows) {
            await expect(list.locator('li').first()).toBeVisible();
        } else {
            await expect(page.getByText('No admin activity yet')).toBeVisible();
        }
    });

    test('renders inline status details for non-healthy services', async ({ page }) => {
        await page.emulateMedia({ colorScheme: 'light' });
        await page.goto('/dashboard');
        await assertLoadedDashboard(page);
        const services = page.getByRole('region', { name: 'Services' });
        await expect(services.locator('[data-slot="skeleton"]')).toHaveCount(0);
        const details = services.locator('span.text-warning-strong, span.text-destructive');
        const nonHealthyStatuses = services.locator(
            '[data-slot="status-dot"][data-color-role="warning"], [data-slot="status-dot"][data-color-role="destructive"]',
        );
        const nonHealthyCount = await nonHealthyStatuses.count();
        await expect(details).toHaveCount(nonHealthyCount);
        const detailTexts = await details.allTextContents();
        for (const [index, text] of detailTexts.entries()) {
            await expect(details.nth(index)).toBeVisible();
            expect(text).toMatch(/^\((?!healthy\b)[^)]+/);
        }
    });
});
