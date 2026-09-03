/**
 * the unified AI Platform console (`/ai-platform`) against a RUNNING
 * stack.
 *
 * WHY THIS FILE EXISTS. The consolidation's central claim is that tenancy is a
 * CONTROL rather than a route: the SYSTEM tier and the working tenant are the
 * two tiers of one cascade, and switching between them re-parameterises every
 * read on the screen. jsdom can prove the component asks for the right tenant;
 * only a browser against a real gateway can prove the screen a super admin
 * actually lands on is the one they can use, that the retired route forwards,
 * and that a tenant admin sees the tenant-shaped variant rather than a wall of
 * 403s. This spec is that proof.
 *
 * Skips with actionable messages when the app or gateway is down.
 */

import { expect, test, type Page } from '@playwright/test';
import { expectNoA11yViolations } from './helpers/a11y';
import { impersonateUser, loginAsAdmin, selectWorkingTenant } from './helpers/auth';
import { API_DOWN_MESSAGE, APP_DOWN_MESSAGE, apiAvailable, appAvailable } from './helpers/stack';

const TABS = ['Providers', 'Tasks', 'Model catalogue', 'Model store', 'Engines'] as const;

test.beforeEach(async ({ page }) => {
  test.skip(!(await appAvailable()), APP_DOWN_MESSAGE);
  test.skip(!(await apiAvailable()), API_DOWN_MESSAGE);
  await loginAsAdmin(page);
});

async function openScreen(page: Page, search = '') {
  await page.goto(`/ai-platform${search}`);
  await expect(page.getByRole('heading', { level: 1, name: 'AI Platform' })).toBeVisible();
}

test.describe('AI Platform — the consolidated screen', () => {
  test('presents the five intent-shaped tabs, and each one mounts', async ({ page }) => {
    await openScreen(page);

    for (const name of TABS) {
      const tab = page.getByRole('tab', { name });
      await expect(tab).toBeVisible();
      await tab.click();
      await expect(tab).toHaveAttribute('data-state', 'active');
    }
  });

  test('keeps the selected tab in the URL, so a tab is a linkable place', async ({ page }) => {
    await openScreen(page, '?tab=store');

    await expect(page.getByRole('tab', { name: 'Model store' })).toHaveAttribute('data-state', 'active');
  });
});

test.describe('AI Platform — tenancy is a selector, not a route', () => {
  test('a super admin lands on the platform tier and can switch to the working tenant', async ({ page }) => {
    await selectWorkingTenant(page);
    await openScreen(page);

    const platformTier = page.getByRole('radio', { name: /Platform default/i });
    await expect(platformTier).toHaveAttribute('aria-checked', 'true');

    // The tenant button names the tenant it switches TO — not the tier that is
    // currently active, which is what it did before the unit tests caught it.
    const tenantTier = page.getByRole('radio', { name: /^Tenant configuration —/ });
    await expect(tenantTier).toBeEnabled();
    await tenantTier.click();

    await expect(tenantTier).toHaveAttribute('aria-checked', 'true');
    // The footer names the scope every read on the screen is parameterised by,
    // so it is the visible proof the switch took effect.
    await expect(page.getByText(/^Scope: /)).toBeVisible();
    await expect(page.getByText('Scope: Platform default (SYSTEM)')).toBeHidden();
  });

  test('an elevated session with NO working tenant is told why the tenant tier is unavailable', async ({ page }) => {
    // Deliberately does NOT call selectWorkingTenant: a disabled control with
    // no stated reason is the anti-pattern this assertion exists to prevent.
    await openScreen(page);

    const tenantTier = page.getByRole('radio', { name: /Tenant configuration — unavailable/i });
    await expect(tenantTier).toBeDisabled();
    await expect(page.getByText(/Select a working tenant in the top bar/i)).toBeVisible();
  });

  test('a tenant admin gets the tenant-shaped screen with no tier switch at all', async ({ page }) => {
    await impersonateUser(page, 'tenant_admin');
    await openScreen(page);

    // One tier means no switch — not a disabled switch implying a scope they
    // could reach.
    await expect(page.getByRole('radio', { name: /Platform default/i })).toHaveCount(0);
    await expect(page.getByText(/Tenant configuration —/)).toBeVisible();
  });
});

test.describe('AI Platform — the SUPER_ADMIN-only routing plane', () => {
  test('reads a 403 as "managed by the platform" rather than as a failure', async ({ page }) => {
    await impersonateUser(page, 'tenant_admin');
    await openScreen(page);

    // `admin/routing-policies` answers 403 to a tenant admin by design. A
    // privilege boundary is an answer, so the screen must not offer a retry
    // that can never succeed.
    const managed = page.getByText('Managed by the platform');
    const configurations = page.getByRole('heading', { name: 'Provider configurations' });
    await expect(managed.or(configurations)).toBeVisible();
    if (await managed.isVisible()) {
      await expect(page.getByRole('button', { name: /retry/i })).toHaveCount(0);
    }
  });
});

test.describe('AI Platform — export never discloses a credential', () => {
  test('shows the credential locator and nothing that looks like a key', async ({ page }) => {
    await openScreen(page);

    await page.getByRole('button', { name: /export \/ import/i }).click();
    const drawer = page.getByRole('dialog', { name: 'Transfer provider configurations' });
    await expect(drawer).toBeVisible();
    await expect(drawer.getByText('This artifact contains no credentials')).toBeVisible();

    // Whatever the tenant's configurations are, no rendered token may look like
    // vendor key material. The gateway's `assertNoSecretMaterial` guards the
    // artifact; this guards the screen that displays it.
    const body = (await drawer.innerText()).toLowerCase();
    expect(body).not.toMatch(/sk-[a-z0-9]{8,}/);
    expect(body).not.toMatch(/bearer\s+[a-z0-9._-]{16,}/);
  });
});

test.describe('AI Platform — retired routes', () => {
  test('/ai-task-defaults forwards to the Tasks tab of the unified screen', async ({ page }) => {
    await page.goto('/ai-task-defaults');

    await expect(page).toHaveURL(/\/ai-platform\?tab=tasks/);
    await expect(page.getByRole('heading', { level: 1, name: 'AI Platform' })).toBeVisible();
    // A redirect that lands on the wrong tab is still a broken bookmark.
    await expect(page.getByRole('tab', { name: 'Tasks' })).toHaveAttribute('data-state', 'active');
  });

  test('/ai-runtime-profiles still resolves — it left the rail, not the app', async ({ page }) => {
    await page.goto('/ai-runtime-profiles');

    await expect(page).toHaveURL(/\/ai-runtime-profiles/);
    await expect(page.getByRole('heading', { level: 1, name: 'AI runtime profiles' })).toBeVisible();
  });

  test('the Providers tab links to the runtime profiles it tunes', async ({ page }) => {
    await openScreen(page);

    await expect(page.getByRole('link', { name: /open runtime profiles/i })).toHaveAttribute('href', '/ai-runtime-profiles');
  });

  test('/ai-configuration survives, narrowed, and points at where its other tabs went', async ({ page }) => {
    await selectWorkingTenant(page);
    await page.goto('/ai-configuration');

    await expect(page.getByRole('heading', { level: 1, name: 'Speech & Voice' })).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Models' })).toHaveCount(0);
    await expect(page.getByRole('tab', { name: 'Providers' })).toHaveCount(0);
    await expect(page.getByRole('link', { name: /providers & models/i })).toHaveAttribute('href', '/ai-platform');
  });
});

test.describe('AI Platform — accessibility', () => {
  for (const [label, search] of [
    ['providers', ''],
    ['tasks', '?tab=tasks'],
    ['catalogue', '?tab=catalogue'],
    ['store', '?tab=store'],
    ['engines', '?tab=engines'],
  ] as const) {
    test(`has no axe violations on the ${label} tab`, async ({ page }) => {
      await selectWorkingTenant(page);
      await openScreen(page, search);

      await expectNoA11yViolations(page);
    });
  }
});
