/**
 * Frame 37 — Harness observability against a RUNNING stack (rule 12 gate 3):
 * screen smoke plus axe scans in both themes. Skips with actionable messages
 * when the app or gateway is down. The harness admin endpoints proxy to a
 * Temporal-backed service that may be down in local dev, so "settled" accepts
 * data, empty or the error posture (the chain badge resolves in all three).
 */

import { expect, test, type Page } from '@playwright/test';
import { expectNoA11yViolations } from './helpers/a11y';
import { loginAsAdmin, selectWorkingTenant } from './helpers/auth';
import { API_DOWN_MESSAGE, APP_DOWN_MESSAGE, apiAvailable, appAvailable } from './helpers/stack';

test.beforeEach(async ({ page }) => {
    test.skip(!(await appAvailable()), APP_DOWN_MESSAGE);
    test.skip(!(await apiAvailable()), API_DOWN_MESSAGE);
    await loginAsAdmin(page);
    // Harness observability is tenant-scoped: elevated sessions see the
    // "Select a working tenant" gate until one is chosen.
    await selectWorkingTenant(page);
});

async function waitForSettled(page: Page) {
    await expect(page.getByRole('heading', { level: 1, name: 'Harness Observability' })).toBeVisible();
    // The chain verdict badge leaves its loading skeleton in every terminal
    // state: intact/broken with data, unverified when the audit read failed.
    const verdict = page.getByText('Chain intact').or(page.getByText('Chain broken')).or(page.getByText('Unverified'));
    await expect(verdict.first()).toBeVisible();
}

test.describe('harness observability (frame 37)', () => {
    test('shows the header, filter strip and the three panels', async ({ page }) => {
        await page.goto('/harness/observability');
        await waitForSettled(page);
        await expect(page.getByRole('button', { name: 'Refresh' })).toBeVisible();
        await expect(page.getByLabel('Search audit rows')).toBeVisible();
        for (const name of ['Chain integrity', 'Eval runs', 'Gate queue']) {
            await expect(page.getByRole('heading', { level: 2, name: new RegExp(name) })).toBeVisible();
        }
    });

    test('the audit search syncs to the URL', async ({ page }) => {
        await page.goto('/harness/observability');
        await waitForSettled(page);
        await page.getByLabel('Search audit rows').fill('gate');
        await expect(page).toHaveURL(/search=gate/);
    });

    test('has no WCAG 2.2 AA violations (light)', async ({ page }) => {
        await page.emulateMedia({ colorScheme: 'light' });
        await page.goto('/harness/observability');
        await waitForSettled(page);
        await expectNoA11yViolations(page);
    });

    test('has no WCAG 2.2 AA violations (dark)', async ({ page }) => {
        // next-themes defaultTheme="system": emulating the media query flips
        // the .dark class without touching client storage.
        await page.emulateMedia({ colorScheme: 'dark' });
        await page.goto('/harness/observability');
        await waitForSettled(page);
        await expectNoA11yViolations(page);
    });
});

function chainAuditGrid(page: Page) {
    return page.getByRole('grid', { name: 'WORM audit trail' });
}

test.describe('harness observability — audit filters (frame 37)', () => {
    test('the action filter narrows the audit trail and syncs to the URL', async ({ page }) => {
        await page.goto('/harness/observability');
        await waitForSettled(page);
        await page.getByLabel('Type:').click();
        await page.getByRole('option', { name: 'GATE_DECISION' }).click();
        await expect(page).toHaveURL(/action=GATE_DECISION/);
        const rows = chainAuditGrid(page).locator('[data-slot="data-grid-row"]');
        const rowCount = await rows.count();
        for (let i = 0; i < rowCount; i += 1) {
            await expect(rows.nth(i).locator('[role="gridcell"]').nth(1)).toContainText('GATE_DECISION');
        }
    });

    test('the range filter syncs to the URL', async ({ page }) => {
        await page.goto('/harness/observability');
        await waitForSettled(page);
        await page.getByLabel('Range:').click();
        await page.getByRole('option', { name: '24 h' }).click();
        await expect(page).toHaveURL(/range=24h/);
        await page.getByLabel('Range:').click();
        await page.getByRole('option', { name: 'All time' }).click();
        await expect(page).toHaveURL(/range=all/);
    });

    test('the refresh button reloads without leaving an error state', async ({ page }) => {
        await page.goto('/harness/observability');
        await waitForSettled(page);
        await page.getByRole('button', { name: 'Refresh' }).click();
        await waitForSettled(page);
        await expect(page.getByText('Unverified')).toHaveCount(0);
    });
});

test.describe('harness observability — chain integrity card (frame 37)', () => {
    test('client-side search narrows rows when audit data exists and preserves empty state otherwise', async ({ page }) => {
        await page.goto('/harness/observability');
        await waitForSettled(page);
        const rows = chainAuditGrid(page).locator('[data-slot="data-grid-row"]');
        const rowCount = await rows.count();

        if (rowCount === 0) {
            await expect(page.getByText('No WORM rows in range')).toBeVisible();
            await page.getByLabel('Search audit rows').fill('zzz-no-such-audit-row-zzz');
            await expect(page.getByText('No audit rows match your search')).toBeVisible();
            await page.getByLabel('Search audit rows').fill('');
            await expect(page.getByText('No WORM rows in range')).toBeVisible();
            return;
        }

        const firstAction = (await rows.first().locator('[role="gridcell"]').nth(1).innerText()).trim();
        await page.getByLabel('Search audit rows').fill(firstAction);
        await expect(page).toHaveURL(/search=/);
        const filteredRows = chainAuditGrid(page).locator('[data-slot="data-grid-row"]');
        const filteredCount = await filteredRows.count();
        expect(filteredCount).toBeGreaterThan(0);
        expect(filteredCount).toBeLessThanOrEqual(rowCount);
        for (let i = 0; i < filteredCount; i += 1) {
            const rowText = await filteredRows.nth(i).innerText();
            expect(rowText.toLowerCase()).toContain(firstAction.toLowerCase());
        }
        await page.getByLabel('Search audit rows').fill('');
        await expect(chainAuditGrid(page).locator('[data-slot="data-grid-row"]')).toHaveCount(rowCount);
    });

    test('a search with no matches shows the search-specific empty state', async ({ page }) => {
        await page.goto('/harness/observability');
        await waitForSettled(page);
        await page.getByLabel('Search audit rows').fill('zzz-no-such-audit-row-zzz');
        await expect(page.getByText('No audit rows match your search')).toBeVisible();
        await expect(page.getByText('No WORM rows in range')).toHaveCount(0);
    });
});

test.describe('harness observability — eval runs panel (frame 37)', () => {
    test('clicking a run row opens the detail sheet, with an empty state when none exist', async ({ page }) => {
        await page.goto('/harness/observability');
        await waitForSettled(page);
        const rows = page.getByRole('grid', { name: 'Eval runs' }).locator('[data-slot="data-grid-row"]');
        const rowCount = await rows.count();
        if (rowCount === 0) {
            await expect(page.getByText('No evals run yet')).toBeVisible();
            return;
        }
        await rows.first().click();
        const sheet = page.getByRole('dialog');
        await expect(sheet).toBeVisible();
        await expect(sheet.getByText('Per-case claim verdicts and metric scores for this eval run.')).toBeVisible();
        const loadingOrLoaded = sheet
            .getByText('Golden set')
            .or(sheet.locator('[data-slot="skeleton"]').first())
            .or(sheet.getByText(/^(Failed|Error)/i));
        await expect(loadingOrLoaded.first()).toBeVisible();
        await expect(sheet.getByText(/^Per-case scores \(/)).toBeVisible();
        await page.keyboard.press('Escape');
        await expect(page.getByRole('dialog')).toBeHidden();
    });
});

test.describe('harness observability — gate queue card (frame 37)', () => {
    test('renders the SLA stat rows and per-item badges (or the empty state)', async ({ page }) => {
        await page.goto('/harness/observability');
        await waitForSettled(page);
        const gateQueueCard = page.getByRole('heading', { level: 2, name: 'Gate queue' }).locator('..').locator('..');
        for (const label of ['Pending', 'Oldest', 'Breached SLA', 'Escalated']) {
            await expect(gateQueueCard.getByText(label, { exact: true })).toBeVisible();
        }
        const queueList = page.getByRole('list', { name: 'Consultations awaiting review' });
        const emptyState = page.getByText('No consultations awaiting review');
        await expect(queueList.or(emptyState).first()).toBeVisible();
        const items = queueList.locator('li');
        const itemCount = await items.count().catch(() => 0);
        if (itemCount > 0) {
            const badge = items.first().getByText('Escalated').or(items.first().getByText('SLA breached')).or(items.first().getByText('In SLA'));
            await expect(badge.first()).toBeVisible();
        }
    });
});
