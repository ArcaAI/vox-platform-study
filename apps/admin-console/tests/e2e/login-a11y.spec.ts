/**
 * Accessibility gate (rule 11 §11): axe scan with ZERO violations, in both
 * themes. This spec is the pattern every future screen copies once its Figma
 * batch is approved — scan the default state light AND dark.
 */

import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { APP_DOWN_MESSAGE, appAvailable } from './helpers/stack';

const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

// Scans the login page — do NOT restore the shared session from auth.setup.ts
// (an authenticated visit to /login would redirect away).
test.use({ storageState: { cookies: [], origins: [] } });

test.beforeEach(async () => {
    test.skip(!(await appAvailable()), APP_DOWN_MESSAGE);
});

async function scan(page: Page) {
    const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
    // Surface the full finding in the failure output, not just a count.
    expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([]);
}

test.describe('login page accessibility', () => {
    test('has no WCAG 2.2 AA violations (light)', async ({ page }) => {
        await page.emulateMedia({ colorScheme: 'light' });
        await page.goto('/login');
        await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
        await scan(page);
    });

    test('has no WCAG 2.2 AA violations (dark)', async ({ page }) => {
        // next-themes defaultTheme="system": emulating the media query flips
        // the .dark class without touching client storage.
        await page.emulateMedia({ colorScheme: 'dark' });
        await page.goto('/login');
        await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
        await scan(page);
    });
});
