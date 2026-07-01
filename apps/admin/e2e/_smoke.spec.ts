/**
 * Harness smoke spec — proves the config + auth fixture + the Desktop/Tablet/
 * Mobile projects are wired. Runs across all three viewport projects.
 * Per-ticket specs live beside this file as `task-3XX-<slug>.spec.ts`.
 */
import { test, expect } from './fixtures/auth';

test.describe('admin console — harness smoke', () => {
    test('login page renders', async ({ page }) => {
        await page.goto('/login');
        await expect(page.getByRole('heading', { name: 'HOPE Admin Console' })).toBeVisible();
        await expect(page.locator('#username')).toBeVisible();
        await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
    });
});
