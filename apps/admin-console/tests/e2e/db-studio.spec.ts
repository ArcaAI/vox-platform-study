/**
 * Frame 19 — Database Studio screen spec: the status probe resolves to either
 * the truthful disabled card or the guarded iframe shell (never a broken
 * iframe), with the axe gate in both themes (rule 11 §11).
 *
 * The console surface was renamed from `/pstudio` to `/db-studio`, and its
 * copy from "Prisma Studio" to "Database Studio". The GATEWAY paths below stay
 * `/api/hope/admin/pstudio*` on purpose — the rename was console-only — so the
 * mixed naming in this file is intentional, not stale.
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

async function openDbStudio(page: Page) {
  await page.goto('/db-studio');
  await expect(page.getByRole('heading', { level: 1, name: 'Database Studio' })).toBeVisible();
  await expect(page.getByText('Production data')).toBeVisible();
  // Settle the status probe (skeleton surface gives way to card or iframe).
  await expect(page.locator('[data-slot="skeleton"]')).toHaveCount(0);
  // Truthful status surface: enabled -> iframe shell; disabled -> card.
  const surface = page.locator('iframe[title="Database Studio"]').or(page.getByText('Database Studio is disabled'));
  await expect(surface.first()).toBeVisible();
}

test.describe('database studio screen', () => {
  test('renders the status surface with no WCAG 2.2 AA violations (light)', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'light' });
    await openDbStudio(page);
    await expectNoA11yViolations(page);
  });

  test('renders the status surface with no WCAG 2.2 AA violations (dark)', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await openDbStudio(page);
    await expectNoA11yViolations(page);
  });

  test('pairs the iframe shell with an open-in-new-tab escape hatch when enabled', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'light' });
    await openDbStudio(page);
    const iframe = page.locator('iframe[title="Database Studio"]');
    await expect(iframe).toBeVisible();
    await expect(iframe).toHaveAttribute('src', '/api/hope/admin/pstudio');
    const openLink = page.getByRole('link', { name: 'Open in new tab' });
    await expect(openLink).toBeVisible();
    await expect(openLink).toHaveAttribute('href', '/api/hope/admin/pstudio');
    await expect(page.getByText('Studio enabled')).toBeVisible();
  });

  test('states the fail-closed permission requirement on the disabled card', async ({ page }) => {
    await page.route('**/api/hope/admin/pstudio/status', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ enabled: false }),
      });
    });
    await openDbStudio(page);
    await expect(page.getByText('Database Studio is disabled')).toBeVisible();
    await expect(page.getByText('ENABLE_PRISMA_STUDIO=true')).toBeVisible();
    await expect(page.getByText('manage:PrismaStudio')).toBeVisible();
    await expect(page.getByText('Studio disabled')).toBeVisible();
  });

  /**
   * The served shell posts queries back to the path it was served from, so
   * the session-cookie-authenticated proxy carries the credential on the
   * POST too — posting directly to the gateway would carry an empty bearer
   * and every query would 401. Runs in-page so the httpOnly session cookie
   * applies (page.request drops it — see helpers/auth.ts).
   */
  test('executes a studio query through the session-guarded proxy', async ({ page }) => {
    await openDbStudio(page);
    const iframe = page.locator('iframe[title="Database Studio"]');
    await expect(iframe).toBeVisible();

    const result = await page.evaluate(async () => {
      const shell = await fetch('/api/hope/admin/pstudio');
      const query = await fetch('/api/hope/admin/pstudio', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query: { sql: 'select 1 as ok', parameters: [] } }),
      });
      return {
        shellStatus: shell.status,
        shellContentType: shell.headers.get('content-type'),
        shellCacheControl: shell.headers.get('cache-control'),
        queryStatus: query.status,
        queryBody: (await query.json()) as [unknown, Array<{ ok: number }>?],
      };
    });

    expect(result.shellStatus).toBe(200);
    expect(result.shellContentType).toContain('text/html');
    expect(result.shellCacheControl).toBe('no-store');
    expect(result.queryStatus).toBe(200);
    const [queryError, rows] = result.queryBody;
    expect(queryError).toBeNull();
    expect(rows?.[0]?.ok).toBe(1);
  });
});
