/**
 * Frame 25 (account half) — Account screen spec: authenticated smoke of the
 * session identity region and the rule 11 §11 axe gate in both themes.
 * Requires a running stack (skips otherwise).
 */

import { expect, test, type Page } from '@playwright/test';
import { expectNoA11yViolations } from './helpers/a11y';
import { loginAsAdmin } from './helpers/auth';
import { ADMIN_CREDENTIALS, API_DOWN_MESSAGE, APP_DOWN_MESSAGE, apiAvailable, appAvailable } from './helpers/stack';

test.beforeEach(async ({ page }) => {
    test.skip(!(await appAvailable()), APP_DOWN_MESSAGE);
    test.skip(!(await apiAvailable()), API_DOWN_MESSAGE);
    await loginAsAdmin(page);
});

test.describe('account screen', () => {
    test('renders the identity region from the BFF session', async ({ page }) => {
        await page.goto('/account');
        await expect(page.getByRole('heading', { level: 1, name: 'Account' })).toBeVisible();
        const identity = page.getByRole('region', { name: 'Identity' });
        await expect(identity).toBeVisible();
        await expect(identity).toContainText(ADMIN_CREDENTIALS.username);
    });

    test('has no WCAG 2.2 AA violations (light)', async ({ page }) => {
        await page.emulateMedia({ colorScheme: 'light' });
        await page.goto('/account');
        await expect(page.getByRole('heading', { level: 1, name: 'Account' })).toBeVisible();
        await expect(page.getByRole('region', { name: 'Identity' })).toBeVisible();
        await expectNoA11yViolations(page);
    });

    test('has no WCAG 2.2 AA violations (dark)', async ({ page }) => {
        await page.emulateMedia({ colorScheme: 'dark' });
        await page.goto('/account');
        await expect(page.getByRole('heading', { level: 1, name: 'Account' })).toBeVisible();
        await expect(page.getByRole('region', { name: 'Identity' })).toBeVisible();
        await expectNoA11yViolations(page);
    });
});

/**
 * TASK-440 — Tenant profile redesign (/tenant-profile, tier 20-29): profile
 * tabs + Settings category sub-nav. The seeded global admin may have no working
 * tenant, so every check tolerates the NoTenant empty state as a valid outcome.
 */

/** The tabbed profile OR the frame's NoTenant variant — either is a loaded state. */
function tabsOrEmpty(page: Page) {
    return page.getByRole('tab', { name: 'Organization' }).or(page.getByText('No working tenant selected'));
}

test.describe('tenant profile — tabs + settings sub-nav (TASK-440)', () => {
    test('renders the three profile tabs (or the no-tenant empty state)', async ({ page }) => {
        await page.goto('/tenant-profile');
        await expect(page.getByRole('heading', { level: 1, name: 'Tenant profile' })).toBeVisible();
        await expect(tabsOrEmpty(page).first()).toBeVisible();

        if (await page.getByRole('tab', { name: 'Organization' }).isVisible()) {
            await expect(page.getByRole('tab', { name: 'Plan & usage' })).toBeVisible();
            await expect(page.getByRole('tab', { name: 'Settings' })).toBeVisible();
            await expect(page.getByRole('region', { name: 'Organization' })).toBeVisible();
        }
    });

    test('deep-links to the Plan & usage tab via ?tab=', async ({ page }) => {
        await page.goto('/tenant-profile?tab=plan');
        await expect(page.getByRole('heading', { level: 1, name: 'Tenant profile' })).toBeVisible();
        // Plan region when a tenant is selected; otherwise the no-tenant gate.
        await expect(page.getByRole('region', { name: 'Plan & usage' }).or(page.getByText('No working tenant selected')).first()).toBeVisible();
    });

    test('Settings tab shows the category rail (or an empty settings state)', async ({ page }) => {
        await page.goto('/tenant-profile?tab=settings');
        await expect(page.getByRole('heading', { level: 1, name: 'Tenant profile' })).toBeVisible();

        if (await page.getByRole('tab', { name: 'Settings' }).isVisible()) {
            // Either the category rail, the "no tenant settings" empty state, or a load error is acceptable.
            await expect(
                page
                    .getByRole('navigation', { name: 'Settings categories' })
                    .or(page.getByText('No tenant settings'))
                    .or(page.getByText('No working tenant selected'))
                    .first(),
            ).toBeVisible();
        } else {
            await expect(page.getByText('No working tenant selected')).toBeVisible();
        }
    });

    test('has no WCAG 2.2 AA violations on the Settings tab (light + dark)', async ({ page }) => {
        for (const colorScheme of ['light', 'dark'] as const) {
            await page.emulateMedia({ colorScheme });
            await page.goto('/tenant-profile?tab=settings');
            await expect(page.getByRole('heading', { level: 1, name: 'Tenant profile' })).toBeVisible();
            await expect(tabsOrEmpty(page).first()).toBeVisible();
            await expectNoA11yViolations(page);
        }
    });
});
