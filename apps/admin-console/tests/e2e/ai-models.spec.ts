/**
 * Frame 15 — AI Model Registry screen spec: authenticated smoke of the list
 * shell (h1 + registry region) and the rule 11 §11 axe gate in both themes.
 * Requires a running stack (skips otherwise, see helpers/stack.ts).
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

test.describe('AI model registry screen', () => {
    test('renders the registry heading, filter bar and list region', async ({ page }) => {
        await page.goto('/ai-models');
        await expect(page.getByRole('heading', { level: 1, name: 'AI Model Registry' })).toBeVisible();
        await expect(page.getByLabel('Search models')).toBeVisible();
        await expect(page.getByRole('button', { name: 'Register model' }).first()).toBeVisible();
        await expect(page.getByRole('table', { name: 'AI models' })).toBeVisible();
    });

    test('has no WCAG 2.2 AA violations (light)', async ({ page }) => {
        await page.emulateMedia({ colorScheme: 'light' });
        await page.goto('/ai-models');
        await expect(page.getByRole('heading', { level: 1, name: 'AI Model Registry' })).toBeVisible();
        await expect(page.getByRole('table', { name: 'AI models' })).toBeVisible();
        await expectNoA11yViolations(page);
    });

    test('has no WCAG 2.2 AA violations (dark)', async ({ page }) => {
        await page.emulateMedia({ colorScheme: 'dark' });
        await page.goto('/ai-models');
        await expect(page.getByRole('heading', { level: 1, name: 'AI Model Registry' })).toBeVisible();
        await expect(page.getByRole('table', { name: 'AI models' })).toBeVisible();
        await expectNoA11yViolations(page);
    });
});
