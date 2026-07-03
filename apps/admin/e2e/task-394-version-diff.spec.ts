/**
 * TASK-394 P0-2 — Agent version-diff wired to the TASK-389 server diff (FE E2E).
 *
 * The version-history view now drives `usePrompts().compareVersionsDetailed`
 * (the server-backed `PromptVersionDiff` superset) instead of the old client
 * line-diff, and surfaces the per-field breakdown (`content` vs `variables`) as
 * header chips. This spec navigates the proven `task-382` path
 * (Tenants → Global → Departments → Cardiology → Agent instructions → an
 * instruction → Version history) and asserts the diff view renders a valid
 * server-computed state.
 *
 * Data-tolerant + non-destructive: the deep dive is skipped when the seed ships
 * no department instruction; the per-field breakdown is asserted only when the
 * opened prompt has ≥ 2 versions (otherwise the "pick two versions" hint is the
 * valid state). No version is ever activated/rolled back.
 *
 * @see task-382-agent-management.spec.ts (navigation) · features/agents/version-diff.tsx
 */
import { test, expect, type Page } from './fixtures/auth';

/** Tenants → «Global» → Departments → «Cardiology» → Agent instructions (mirrors task-382). */
async function openCardiologyAgents(page: Page): Promise<void> {
  await page.getByText('Global', { exact: true }).first().click();
  await page.waitForURL(/\/tenants\/[^/]+\/overview/, { timeout: 15_000 });

  const tenantId = page.url().match(/\/tenants\/([^/]+)\//)?.[1];
  expect(tenantId, 'tenant id resolved from the overview URL').toBeTruthy();
  await page.goto(`/tenants/${tenantId}/departments`);

  const search = page.getByLabel('Search departments');
  await search.waitFor({ timeout: 15_000 });
  await search.fill('Cardiology');
  await page.getByRole('button', { name: 'Manage' }).first().click();

  await page.getByRole('link', { name: 'Agent instructions' }).click();
  await page.waitForURL(/\/departments\/[^/]+\/agents\/?$/, { timeout: 15_000 });
  await expect(page.getByRole('heading', { name: 'Default agents' })).toBeVisible();
}

test.describe('TASK-394 P0-2 — server-backed version diff', () => {
  test('version history renders the server diff + per-field breakdown', async ({ page, loginAs }) => {
    await loginAs('superAdmin');
    await openCardiologyAgents(page);

    const library = page.getByRole('list', { name: 'Agent instructions' });
    const emptyState = page.getByText('No agent instructions yet');
    await expect(library.or(emptyState).first()).toBeVisible();
    test.skip((await library.count()) === 0, 'No department-scoped instruction on this seed — diff dive skipped.');

    // Open the first instruction → workspace → Version history (the /diff route).
    await library.getByRole('button').first().click();
    await page.waitForURL(/\/agents\/[^/]+$/, { timeout: 15_000 });
    await page.getByRole('link', { name: 'Version history' }).click();
    await page.waitForURL(/\/diff$/, { timeout: 15_000 });

    // The diff view loaded (proves the `compareVersionsDetailed` wiring): the
    // Base + Compare version pickers render.
    await expect(page.getByLabel('Base')).toBeVisible();
    await expect(page.getByLabel('Compare')).toBeVisible();

    // A valid server-computed state: either the per-field breakdown (≥ 2
    // versions differ) or the single-version "pick two versions" hint.
    const breakdown = page.getByTestId('diff-field-breakdown');
    const sameHint = page.getByText('Select two different versions to compare.');
    await expect(breakdown.or(sameHint).first()).toBeVisible();

    // When the seed has ≥ 2 versions, the breakdown surfaces the changed fields.
    if (await breakdown.count()) {
      await expect(breakdown.getByText('Changed fields:')).toBeVisible();
      await expect(breakdown.getByText('content', { exact: true })).toBeVisible();
    }
  });
});
