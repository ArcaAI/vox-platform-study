/**
 * TASK-382 — Agent Management by Department (frames 30–33): frontend E2E.
 *
 * Browser-driven FE→BE journey across the three viewport projects (desktop /
 * tablet / mobile). Authored to run against a seeded stack (see e2e/README.md);
 * discover without a stack via:
 *   pnpm exec playwright test --config apps/admin/playwright.config.ts --list
 *
 * Route: Tenants → «Global» → Departments → «Cardiology» → Agent instructions
 *        (= frame 30) → an instruction → Editor (31) / Version history (32) /
 *        Test playground (33).
 *
 * We drive as `super_admin` and open the seeded **Global / Cardiology** department,
 * which ships department-scoped PromptTemplates (`07-prompt-template.ts` — "Cardiology
 * Department Prompt", "SMR System Prompt - Cardiology"), so the instruction library is
 * populated and the workspace dive is exercisable. The deep dive is still GUARDED
 * (skips if a future seed empties the library) so the spec never flakes on data.
 *
 * Scope notes:
 *  - Generic responsive primitives (sidebar rail, grid→card collapse, FAB) are owned
 *    by TASK-384 and asserted there — this spec asserts the agent surfaces only.
 *  - The DNA writing-style slot is now backed (TASK-387 #7) and asserted as a real
 *    wireable slot (no longer a TARGET flag); test sub-metrics are not asserted.
 */
import { test, expect, type Page } from './fixtures/auth';

/** Tenants → «Global» → Departments → «Cardiology» → Agent instructions (frame 30). */
async function openCardiologyAgents(page: Page): Promise<void> {
    // /tenants grid (desktop table / mobile cards) — open the seeded Global tenant.
    // Viewing a tenant makes it the super-admin's working tenant.
    await page.getByText('Global', { exact: true }).first().click();
    await page.waitForURL(/\/tenants\/[^/]+\/overview/, { timeout: 15_000 });

    // Jump straight to the tenant's Departments tab by URL (viewport-agnostic — the
    // tenant tab bar is a nav on desktop/tablet but a Select on mobile; TASK-384 owns
    // that primitive, so we don't re-test it here).
    const tenantId = page.url().match(/\/tenants\/([^/]+)\//)?.[1];
    expect(tenantId, 'tenant id resolved from the overview URL').toBeTruthy();
    await page.goto(`/tenants/${tenantId}/departments`);

    // Card-grid → filter to Cardiology → Manage.
    const search = page.getByLabel('Search departments');
    await search.waitFor({ timeout: 15_000 });
    await search.fill('Cardiology');
    await page.getByRole('button', { name: 'Manage' }).first().click();

    // Department detail (Members) → Agent instructions sub-tab (overflow nav on all
    // viewports — same in every project).
    await page.getByRole('link', { name: 'Agent instructions' }).click();
    await page.waitForURL(/\/departments\/[^/]+\/agents\/?$/, { timeout: 15_000 });
    await expect(page.getByRole('heading', { name: 'Default agents' })).toBeVisible();
}

test.describe('TASK-382 — agent management (frames 30–33)', () => {
    test('frame 30 — default-agent slots + instruction library render for the department', async ({ page, loginAs }) => {
        await loginAs('superAdmin');
        await openCardiologyAgents(page);

        // Two sections: Default agents + Instruction library.
        await expect(page.getByRole('heading', { name: 'Default agents' })).toBeVisible();
        await expect(page.getByRole('heading', { name: 'Instruction library' })).toBeVisible();

        // Exactly four slot cards: pre-summary · new-visit · re-visit · DNA writing-style.
        await expect(page.locator('[data-slot="agent-slot-card"]')).toHaveCount(4);

        // TASK-387 #7 — the DNA writing-style slot is now backed (Department.dnaWritingStylePromptId),
        // so it renders as a real wireable slot: its card is present and the old TARGET flags are gone.
        await expect(page.getByText('DNA STYLE').first()).toBeVisible();
        await expect(page.getByText('No backing column yet')).toHaveCount(0);
        await expect(page.getByText('Target')).toHaveCount(0);

        // The library region is present (populated list OR the empty state).
        const library = page.getByRole('list', { name: 'Agent instructions' });
        const emptyState = page.getByText('No agent instructions yet');
        await expect(library.or(emptyState).first()).toBeVisible();
    });

    test('frames 31–33 — open an instruction → editor, version diff, test playground', async ({ page, loginAs }) => {
        await loginAs('superAdmin');
        await openCardiologyAgents(page);

        const library = page.getByRole('list', { name: 'Agent instructions' });
        const emptyState = page.getByText('No agent instructions yet');
        await expect(library.or(emptyState).first()).toBeVisible();

        const hasInstructions = (await library.count()) > 0;
        test.skip(!hasInstructions, 'No department-scoped instruction on this seed — workspace dive skipped.');

        // Open the first library row → instruction workspace (Editor / frame 31).
        await library.getByRole('button').first().click();
        await page.waitForURL(/\/agents\/[^/]+$/, { timeout: 15_000 });
        // `exact`: the editor's `<Label>Prompt body</Label>` text is also contained by its
        // wrapping field group, so a substring match resolves to >1 element.
        await expect(page.getByText('Prompt body', { exact: true })).toBeVisible();
        await expect(page.locator('#prompt-content')).toBeVisible();

        // Version history (frame 32 — side-by-side diff): the base/compare pickers.
        await page.getByRole('link', { name: 'Version history' }).click();
        await page.waitForURL(/\/diff$/, { timeout: 15_000 });
        await expect(page.getByLabel('Base')).toBeVisible();
        await expect(page.getByLabel('Compare')).toBeVisible();

        // Test playground (frame 33 — variable inputs → Run → score + output).
        await page.getByRole('link', { name: 'Test playground' }).click();
        await page.waitForURL(/\/playground$/, { timeout: 15_000 });
        await expect(page.getByText('Resolved variables')).toBeVisible();

        // Mobile: the workspace sub-tabs stay reachable as a scrollable mode nav
        // (the diff stacks + the editor goes full-height via the component grids).
        if (test.info().project.name === 'mobile') {
            await expect(page.getByRole('link', { name: 'Editor' })).toBeVisible();
            await expect(page.getByRole('link', { name: 'Version history' })).toBeVisible();
            await expect(page.getByRole('link', { name: 'Test playground' })).toBeVisible();
        }
    });
});
