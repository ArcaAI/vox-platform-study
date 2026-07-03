/**
 * TASK-407 — tenant-admin tail surfaces (Stores detail · Audio Processing ·
 * Agent Jobs · Harness) — frontend E2E.
 *
 * Drives the real Admin Console (Vite :5174) → real API (:8868) across the
 * three viewport projects (desktop 1280 / tablet 834 / mobile 390). Tests
 * adapt to the active tier by reading the DOM (underline tab-nav vs mobile
 * section Select), mirroring the task-379 spec whose route tree this extends.
 *
 * Data posture is non-destructive and degradation-tolerant:
 *   - object browser accepts rows OR the "No objects" empty state;
 *   - jobs/runs tables accept rows OR their empty states;
 *   - the Harness workflows panel accepts the Temporal table OR the honest
 *     "Harness service unavailable" card (service `:8866` may be down).
 */
import { test, expect } from './fixtures/auth';
import type { Page } from '@playwright/test';

const STABLE_TENANT_KEY = '__GLOBAL__';

/** Open the seeded system tenant from the fleet list (stable on every viewport). */
async function openStableTenant(page: Page): Promise<void> {
  await expect(page.getByRole('heading', { name: 'Tenants' })).toBeVisible();
  // Scope to <main>: the sidebar workspace switcher also renders the tenant
  // key for tenant-admins, and .first() would otherwise click the sidebar.
  await page.getByRole('main').getByText(STABLE_TENANT_KEY, { exact: true }).first().click();
  await page.waitForURL(/\/tenants\/[0-9a-f-]{8}/i);
}

/** Switch to a tenant-detail tab via underline nav (desktop/tablet) or Select (mobile). */
async function goToTab(page: Page, label: string, urlPart: string): Promise<void> {
  const tabNav = page.getByRole('navigation', { name: 'Tenant sections' });
  const sectionSelect = page.getByRole('combobox', { name: 'Tenant section' });
  await expect(tabNav.or(sectionSelect)).toBeVisible();
  if (await tabNav.isVisible()) {
    await tabNav.getByRole('link', { name: label }).click();
  } else {
    await sectionSelect.click();
    await page.getByRole('option', { name: label }).click();
  }
  await page.waitForURL(`**/${urlPart}`);
}

test.describe('TASK-407 — tenant-admin tail surfaces (FE)', () => {
  test('1. the three new tabs are reachable from the tenant detail', async ({ page, loginAs }) => {
    await loginAs('superAdmin');
    await openStableTenant(page);

    const tabNav = page.getByRole('navigation', { name: 'Tenant sections' });
    const sectionSelect = page.getByRole('combobox', { name: 'Tenant section' });
    // Wait out the detail-page skeleton before branching on the active tier.
    await expect(tabNav.or(sectionSelect)).toBeVisible();
    if (await tabNav.isVisible()) {
      for (const label of ['Audio Processing', 'Agent Jobs', 'Harness']) {
        await expect(tabNav.getByRole('link', { name: label }), `${label} tab link`).toBeVisible();
      }
    } else {
      await sectionSelect.click();
      for (const label of ['Audio Processing', 'Agent Jobs', 'Harness']) {
        await expect(page.getByRole('option', { name: label }), `${label} Select option`).toBeVisible();
      }
      await page.keyboard.press('Escape');
    }
  });

  test('2. Stores — bucket list links into the read-only bucket detail', async ({ page, loginAs }) => {
    await loginAs('superAdmin');
    await openStableTenant(page);
    await goToTab(page, 'Storage', 'storage');

    // List view: usage roll-up + buckets table with per-row Browse links.
    await expect(page.getByRole('heading', { name: 'Buckets' })).toBeVisible();
    const browse = page.getByRole('link', { name: 'Browse' }).first();
    await expect(browse).toBeVisible();
    await browse.click();
    await page.waitForURL(/\/storage\/[0-9a-f-]{8}/i);

    // Detail view (design §5.7 `40 · Store Detail`): usage bar + provider
    // config + access keys + read-only object browser. Headings (not raw
    // text) — the sections' empty-state copy repeats the phrases.
    await expect(page.getByRole('heading', { name: 'Provider config' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Access keys' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Objects', exact: true })).toBeVisible();
    await expect(page.getByText('Read-only browser — objects cannot be modified or deleted here.')).toBeVisible();

    // Objects region resolves to rows or the honest empty state — never an error.
    const objectRows = page.getByRole('cell').filter({ hasText: /.+/ });
    const emptyState = page.getByText('No objects', { exact: true });
    await expect(objectRows.or(emptyState).first()).toBeVisible();

    // Back to the bucket list.
    await page.getByRole('link', { name: 'Back to buckets' }).click();
    await page.waitForURL(/\/storage\/?$/);
  });

  test('3. Audio Processing — pipeline card, stat tiles and the jobs table', async ({ page, loginAs }) => {
    await loginAs('superAdmin');
    await openStableTenant(page);
    await goToTab(page, 'Audio Processing', 'audio-processing');

    await expect(page.getByRole('heading', { name: 'Pipeline' })).toBeVisible();
    for (const tile of ['Queued', 'Processing', 'Completed', 'Failed / dead']) {
      await expect(page.getByText(tile, { exact: true }), `${tile} tile`).toBeVisible();
    }
    await expect(page.getByRole('heading', { name: 'Transcription jobs' })).toBeVisible();
    await expect(page.getByRole('combobox', { name: 'Filter by status' })).toBeVisible();

    // Jobs area: rows or the empty state — read-only either way.
    const empty = page.getByText('No transcription jobs');
    const anyJobCell = page.getByLabel(/^Job /).first();
    await expect(empty.or(anyJobCell)).toBeVisible();
    await expect(page.getByText(/read-only supervision, no retry\/cancel actions/)).toBeVisible();
  });

  test('4. Agent Jobs — agents summary + run history', async ({ page, loginAs }) => {
    await loginAs('superAdmin');
    await openStableTenant(page);
    await goToTab(page, 'Agent Jobs', 'agent-jobs');

    await expect(page.getByRole('heading', { name: 'Agents' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Runs' })).toBeVisible();
    await expect(page.getByRole('combobox', { name: 'Filter by agent' })).toBeVisible();

    // Run history: rows or the append-only empty state.
    const emptyRuns = page.getByText('No runs');
    const footer = page.getByText(/prompt-usage records are append-only/);
    await expect(footer).toBeVisible();
    await expect(emptyRuns.or(page.getByRole('table').last())).toBeVisible();
  });

  test('5. Harness — sub-tabs render; Temporal panel degrades honestly', async ({ page, loginAs }) => {
    await loginAs('superAdmin');
    await openStableTenant(page);
    await goToTab(page, 'Harness', 'harness');

    // Sub-tabs per design §5.9: Policy · Eval runs · Audit trail · Gate queue.
    for (const tab of ['Policy', 'Eval runs', 'Audit trail', 'Gate queue']) {
      await expect(page.getByRole('tab', { name: tab }), `${tab} sub-tab`).toBeVisible();
    }

    // Policy (default tab) — resolution source chip + read-only note, or the
    // honest error card if the policy read failed.
    const sourceChip = page.getByText(/Tenant override|Platform default|Code default/).first();
    const policyError = page.getByText(/Couldn’t load the harness policy/);
    await expect(sourceChip.or(policyError)).toBeVisible();

    // Gate queue tab — DB-backed queue + the Temporal workflows panel which
    // must either render or degrade to the unavailable card (never crash).
    await page.getByRole('tab', { name: 'Gate queue' }).click();
    await expect(page.getByText('Awaiting clinician review')).toBeVisible();
    await expect(page.getByText('Document workflows (Temporal)')).toBeVisible();
    const workflowsUnavailable = page.getByText('Harness service unavailable');
    const workflowsEmpty = page.getByText('No document workflows found for this tenant.');
    const workflowsTable = page.getByText('Workflow', { exact: true });
    await expect(workflowsUnavailable.or(workflowsEmpty).or(workflowsTable)).toBeVisible();
  });

  test('6. tenant admin (non-super) can open the new surfaces for their own tenant', async ({ page, loginAs }) => {
    await loginAs('tenantAdmin');
    await openStableTenant(page);
    await goToTab(page, 'Audio Processing', 'audio-processing');
    await expect(page.getByRole('heading', { name: 'Transcription jobs' })).toBeVisible();

    await goToTab(page, 'Harness', 'harness');
    await expect(page.getByRole('tab', { name: 'Policy' })).toBeVisible();
  });
});
