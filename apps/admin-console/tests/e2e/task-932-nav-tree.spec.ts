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

test.beforeEach(async () => {
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
    // reaches every domain EXCEPT Workflow & Harness, whose platform gate
    // defaults to hidden (D-1) — see the dedicated test below. This still
    // pins, by construction, that Platform Ops (index 2) precedes AI
    // Platform (index 3): R-2.
    await expect(rail(page).getByRole('link')).toHaveText([
      'Overview',
      'Tenancy',
      'Platform Ops',
      'AI Platform',
      'Knowledge & Agents',
      'Clinical',
      'Identity & Access',
      'Playground',
    ]);
  });

  test('Workflow & Harness stays hidden by default (D-1) and appears once its platform gate is enabled', async ({ page }) => {
    await loginAsAdmin(page);
    await page.goto('/dashboard');
    await expect(rail(page).getByRole('link', { name: 'Workflow & Harness', exact: true })).toHaveCount(0);

    // `PUT features/matrix` always answers 200 — a per-cell OCC failure lands
    // in the `errors[]` array, not the HTTP status — so a write against an
    // EXISTING row must thread the CURRENT version or 428s silently behind an
    // `ok: true` response. A prior run may have already left a stored row
    // (version > 0), so read it first rather than assuming a fresh key.
    async function currentVersion(page: Page): Promise<number> {
      return page.evaluate(async () => {
        const res = await fetch('/api/hope/admin/settings/features/matrix');
        if (!res.ok) return 0;
        const body = (await res.json()) as { cells: Array<{ key: string; tenantId: string; version: number }> };
        return body.cells.find((c) => c.key === 'console.workflowHarness.enabled' && c.tenantId === 'system')?.version ?? 0;
      });
    }

    async function writeGate(page: Page, value: boolean | null, expectedVersion: number): Promise<{ version?: number; error?: string }> {
      return page.evaluate(
        async ({ cellValue, version }) => {
          const res = await fetch('/api/hope/admin/settings/features/matrix', {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              cells: [
                {
                  key: 'console.workflowHarness.enabled',
                  tenantId: 'system',
                  value: cellValue,
                  // version 0 = no stored row yet — omit the precondition so
                  // the write creates it, matching the registry PUT contract.
                  ...(version > 0 ? { expectedVersion: version } : {}),
                },
              ],
            }),
          });
          if (!res.ok) return { error: `HTTP ${res.status}` };
          const body = (await res.json()) as { cells: Array<{ version: number }>; errors: Array<{ message: string }> };
          if (body.errors.length > 0) return { error: body.errors.map((e) => e.message).join('; ') };
          return { version: body.cells[0]?.version };
        },
        { cellValue: value, version: expectedVersion },
      );
    }

    const startVersion = await currentVersion(page);
    const enabled = await writeGate(page, true, startVersion);
    expect(enabled.error).toBeUndefined();
    try {
      await page.reload();
      await expect(rail(page).getByRole('link', { name: 'Workflow & Harness', exact: true })).toBeVisible();
    } finally {
      // Reset: `null` rewrites the platform row to the descriptor default
      // (hidden, D-1) rather than leaving it copied at `true`.
      const reset = await writeGate(page, null, enabled.version ?? startVersion);
      expect(reset.error).toBeUndefined();
    }
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

  test('a tenant admin never sees a manage:all-only rail entry (Dashboard, Feature availability, Rate limits, Security policy)', async ({ page }) => {
    await loginAsAdmin(page);
    await impersonateUser(page, 'arcaai_admin');
    await page.goto('/departments');

    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    // These four are declared `required: [['manage', 'all']]` (Dashboard is
    // `[['manage', 'PlatformMetrics']]`, equally out of reach) in nav-config.ts
    // — a tenant admin holds none of them, so none may render anywhere on the
    // page, in any component.
    //
    // NOT included: Monitoring and Releases. Both are declared
    // `required: [['manage', 'all'], ['read', 'TenantTelemetry']]` — an
    // "any pair" OR gate — and the seeded ArcaAI tenant admin legitimately
    // holds `read:TenantTelemetry` scoped to its own tenant (01-policy.ts:
    // "tenant admins read their own tenant's service sessions/health/uptime"),
    // so those two routes — and by construction the Overview domain itself —
    // ARE reachable to it. See the companion test below.
    for (const platformOnlyLabel of ['Dashboard', 'Feature availability', 'Rate limits', 'Security policy']) {
      await expect(page.getByRole('link', { name: platformOnlyLabel, exact: true })).toHaveCount(0);
    }
  });

  test('a tenant admin reaches Overview via its own tenant-telemetry read (Monitoring, Releases), never Dashboard', async ({ page }) => {
    await loginAsAdmin(page);
    await impersonateUser(page, 'arcaai_admin');
    await page.goto('/departments');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();

    // The rail shows the domain; its own routes render in the secondary
    // sidebar only once that domain is ACTIVE (the current page is Tenancy),
    // so open Overview via the rail rather than asserting on /departments.
    await expect(rail(page).getByRole('link', { name: 'Overview', exact: true })).toBeVisible();
    await rail(page).getByRole('link', { name: 'Overview', exact: true }).click();

    // Landing lands on /monitoring (Dashboard is hidden), which puts
    // "Monitoring" on the page TWICE — the secondary sidebar link and the
    // current-page breadcrumb — so scope to the sidebar region by name.
    const secondary = page.getByRole('navigation', { name: 'Overview navigation' });
    await expect(secondary.getByRole('link', { name: 'Monitoring', exact: true })).toBeVisible();
    await expect(secondary.getByRole('link', { name: 'Releases', exact: true })).toBeVisible();
    await expect(secondary.getByRole('link', { name: 'Dashboard', exact: true })).toHaveCount(0);
  });
});
