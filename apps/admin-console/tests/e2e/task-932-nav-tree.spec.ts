/**
 * TASK-932 §3.1/§3.2 against a RUNNING stack: the reordered nav rail, the
 * retired `/ai-configuration` redirect, and the platform-wide feature gates
 * as a super admin and a tenant admin actually see them.
 *
 * Companion to `shared/navigation/__tests__/nav-config.test.ts` (the jsdom
 * pin of the same inventory) — this proves the SAME order and the SAME
 * gate-driven visibility render in a real browser, against the real BFF
 * `GET admin/settings/features/effective` (Lane S), not a stubbed fetch.
 *
 * Skips with an actionable message when the app or gateway is down.
 */

import { expect, test, type Page } from '@playwright/test';
import { impersonateUser, loginAsAdmin } from './helpers/auth';
import { API_DOWN_MESSAGE, APP_DOWN_MESSAGE, apiAvailable, appAvailable } from './helpers/stack';

test.beforeEach(async ({ page }) => {
  test.skip(!(await appAvailable()), APP_DOWN_MESSAGE);
  test.skip(!(await apiAvailable()), API_DOWN_MESSAGE);
});

/** The 56px capability-domain rail — lists DOMAIN names, not individual route labels. */
function rail(page: Page) {
  return page.getByRole('navigation', { name: 'Capability domains' });
}

test.describe('nav tree order + retirement (TASK-932 §3.1)', () => {
  test('a super admin sees the rail in the new order, with Platform Ops before AI Platform', async ({ page }) => {
    await loginAsAdmin(page);
    await page.goto('/dashboard');

    // The full §3.1 order in one assertion — a super admin (manage:all)
    // reaches every domain, so this pins all nine AND, by construction,
    // that Platform Ops (index 2) precedes AI Platform (index 3): R-2.
    await expect(rail(page).getByRole('link')).toHaveText([
      'Overview',
      'Tenancy',
      'Platform Ops',
      'AI Platform',
      'Knowledge & Agents',
      'Clinical',
      'Workflow & Harness',
      'Identity & Access',
      'Playground',
    ]);
  });

  test('/ai-configuration redirects to /agents?task=SPEECH_TO_TEXT and no "Speech & Voice" link remains anywhere on the page', async ({ page }) => {
    await loginAsAdmin(page);
    await page.goto('/ai-configuration');

    await expect(page).toHaveURL(/\/agents\?task=SPEECH_TO_TEXT/);
    await expect(page.getByRole('heading', { level: 1, name: 'Agents' })).toBeVisible();
    // Not scoped to a landmark: "Speech & Voice" must not survive as a
    // sidebar entry, a ⌘K result, or a breadcrumb — it left NAV_ENTRIES
    // entirely, not just this one route.
    await expect(page.getByRole('link', { name: 'Speech & Voice', exact: true })).toHaveCount(0);
  });

  test('a tenant admin never sees a manage:all-only rail entry (Dashboard, Monitoring, Feature availability, Security policy, …)', async ({ page }) => {
    await loginAsAdmin(page);
    await impersonateUser(page, 'arcaai_admin');
    await page.goto('/departments');

    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    // These six are declared `required: [['manage', 'all']]` in nav-config.ts
    // (Overview's three, plus Platform Ops' Feature availability/Rate limits
    // and Identity & Access's Security policy) — a tenant admin holds none of
    // them, so none may render anywhere on the page, in any component.
    for (const platformOnlyLabel of ['Dashboard', 'Monitoring', 'Releases', 'Feature availability', 'Rate limits', 'Security policy']) {
      await expect(page.getByRole('link', { name: platformOnlyLabel, exact: true })).toHaveCount(0);
    }
    // The Overview domain itself has no reachable entry, so it drops out of
    // the rail — the same derivation `visibleNavDomains` proves in isolation.
    await expect(rail(page).getByRole('link', { name: 'Overview', exact: true })).toHaveCount(0);
  });
});
