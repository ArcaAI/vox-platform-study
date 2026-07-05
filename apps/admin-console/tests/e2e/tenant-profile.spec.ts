/**
 * Frame 25 (tenant half) — Tenant profile screen spec: authenticated smoke of
 * the self-service profile. The seeded global admin may have no working
 * tenant, so both the identity card and the NoTenant empty state are valid
 * outcomes. Axe gate (rule 11 §11) in both themes. Requires a running stack
 * (skips otherwise).
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

/** The profile identity card OR the frame's NoTenant variant — either is a loaded state. */
function profileOrEmpty(page: Page) {
    return page.getByRole('region', { name: 'Organization' }).or(page.getByText('No working tenant selected'));
}

test.describe('tenant profile screen', () => {
    test('renders the heading with the identity card or the no-tenant empty state', async ({ page }) => {
        await page.goto('/tenant-profile');
        await expect(page.getByRole('heading', { level: 1, name: 'Tenant profile' })).toBeVisible();
        await expect(profileOrEmpty(page).first()).toBeVisible();
    });

    test('has no WCAG 2.2 AA violations (light)', async ({ page }) => {
        await page.emulateMedia({ colorScheme: 'light' });
        await page.goto('/tenant-profile');
        await expect(page.getByRole('heading', { level: 1, name: 'Tenant profile' })).toBeVisible();
        await expect(profileOrEmpty(page).first()).toBeVisible();
        await expectNoA11yViolations(page);
    });

    test('has no WCAG 2.2 AA violations (dark)', async ({ page }) => {
        await page.emulateMedia({ colorScheme: 'dark' });
        await page.goto('/tenant-profile');
        await expect(page.getByRole('heading', { level: 1, name: 'Tenant profile' })).toBeVisible();
        await expect(profileOrEmpty(page).first()).toBeVisible();
        await expectNoA11yViolations(page);
    });
});
