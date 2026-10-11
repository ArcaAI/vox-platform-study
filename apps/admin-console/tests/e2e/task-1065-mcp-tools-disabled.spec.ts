/**
 * TASK-1065 — MCP & Tools is parked: the console gate is locked off and every
 * tools interface is hidden, whatever the backend resolves.
 *
 * Skips with actionable messages when the app or gateway is down.
 */

import { expect, test, type Page } from '@playwright/test';
import { loginAsAdmin } from './helpers/auth';
import { API_DOWN_MESSAGE, APP_DOWN_MESSAGE, apiAvailable, appAvailable } from './helpers/stack';

test.beforeEach(async ({ page }) => {
  test.skip(!(await appAvailable()), APP_DOWN_MESSAGE);
  test.skip(!(await apiAvailable()), API_DOWN_MESSAGE);
  await loginAsAdmin(page);
});

const NOT_FOUND = 'Page not found';

/** A gated route renders either its h1 or the (h1-less) not-found page; returns whether the screen rendered. */
async function screenRendered(page: Page, heading: RegExp): Promise<boolean> {
  const h1 = page.getByRole('heading', { level: 1, name: heading });
  const notFound = page.getByText(NOT_FOUND);
  await expect(h1.or(notFound)).toBeVisible();
  return h1.isVisible();
}

test('the Tools & MCP nav entry is absent', async ({ page }) => {
  await page.goto('/dashboard');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await expect(page.locator('a[href="/tools-mcp"]')).toHaveCount(0);
});

test('/tools-mcp renders not-found, never the screen', async ({ page }) => {
  await page.goto('/tools-mcp');
  expect(await screenRendered(page, /Tools & MCP/)).toBe(false);
  await expect(page.getByText(NOT_FOUND)).toBeVisible();
  await expect(page.getByRole('table', { name: 'MCP servers' })).toHaveCount(0);
});

test('agentic policy has no "MCP external tools" knob', async ({ page }) => {
  await page.goto('/agentic-policy');
  test.skip(!(await screenRendered(page, /Agentic policy/i)), 'agentic policy is feature-gated off in this environment');
  await expect(page.getByText('MCP external tools')).toHaveCount(0);
});

test('harness policy has no Tools group or tools summary', async ({ page }) => {
  await page.goto('/harness/policy');
  test.skip(!(await screenRendered(page, /Harness policy/i)), 'harness policy is feature-gated off in this environment');
  await expect(page.getByText('Tool allowlist')).toHaveCount(0);
  await expect(page.getByText('all allowed')).toHaveCount(0);
});
