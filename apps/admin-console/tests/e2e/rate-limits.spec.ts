/**
 * Frame 16 — Rate Limits screen spec: authenticated smoke of the policy
 * regions (h1, kill-switch, tier + route tables) and the rule 11 §11 axe
 * gate in both themes. Requires a running stack (skips otherwise).
 */

import { expect, test } from '@playwright/test';
import { expectNoA11yViolations } from './helpers/a11y';
import { loginAsAdmin } from './helpers/auth';
import { API_DOWN_MESSAGE, APP_DOWN_MESSAGE, apiAvailable, appAvailable } from './helpers/stack';

test.beforeEach(async ({ page }) => {
    test.skip(!(await appAvailable()), APP_DOWN_MESSAGE);
    test.skip(!(await apiAvailable()), API_DOWN_MESSAGE);
    await loginAsAdmin(page);
});

test.describe('rate limits screen', () => {
    test('renders the policy heading, kill-switch and both table regions', async ({ page }) => {
        await page.goto('/rate-limits');
        await expect(page.getByRole('heading', { level: 1, name: 'Rate Limits' })).toBeVisible();
        await expect(page.getByRole('switch', { name: 'Rate limiting enabled' })).toBeVisible();
        await expect(page.getByRole('table', { name: 'Tier defaults' })).toBeVisible();
        await expect(page.getByRole('table', { name: 'Route overrides' })).toBeVisible();
    });

    test('has no WCAG 2.2 AA violations (light)', async ({ page }) => {
        await page.emulateMedia({ colorScheme: 'light' });
        await page.goto('/rate-limits');
        await expect(page.getByRole('heading', { level: 1, name: 'Rate Limits' })).toBeVisible();
        await expect(page.getByRole('table', { name: 'Tier defaults' })).toBeVisible();
        await expectNoA11yViolations(page);
    });

    test('has no WCAG 2.2 AA violations (dark)', async ({ page }) => {
        await page.emulateMedia({ colorScheme: 'dark' });
        await page.goto('/rate-limits');
        await expect(page.getByRole('heading', { level: 1, name: 'Rate Limits' })).toBeVisible();
        await expect(page.getByRole('table', { name: 'Tier defaults' })).toBeVisible();
        await expectNoA11yViolations(page);
    });
});
