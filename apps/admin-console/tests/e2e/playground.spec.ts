/**
 * Tier 50–59 Playground — the minimalist impersonation canvas (TASK-442,
 * artboard 4a). Verifies the redesigned chrome against a RUNNING stack: the
 * slim top bar with the persona control, NO admin sidebar, the renamed nav
 * labels, and the Agent Playground's three feature tabs. Skips with actionable
 * messages when the app or gateway is down.
 */

import { expect, test } from '@playwright/test';
import { expectNoA11yViolations } from './helpers/a11y';
import { loginAsAdmin, selectWorkingTenant } from './helpers/auth';
import { API_DOWN_MESSAGE, APP_DOWN_MESSAGE, apiAvailable, appAvailable } from './helpers/stack';

test.beforeEach(async ({ page }) => {
    test.skip(!(await appAvailable()), APP_DOWN_MESSAGE);
    test.skip(!(await apiAvailable()), API_DOWN_MESSAGE);
    await loginAsAdmin(page);
});

test.describe('playground canvas (artboard 4a)', () => {
    test('renders minimal chrome: top bar + persona control, no admin sidebar', async ({ page }) => {
        // Voice profiles is user-owned (no working-tenant gate) — the most
        // robust page to assert the shared chrome on.
        await page.goto('/playground/voice-profiles');
        await expect(page.getByRole('heading', { level: 1, name: 'My Voice Enrollment & Profiles' })).toBeVisible();

        // Slim top bar names the page and carries the persona/impersonation control.
        await expect(page.getByText('Playground', { exact: true })).toBeVisible();
        await expect(page.getByRole('button', { name: /acting as/i })).toBeVisible();
        // The under-admin line (not the page description, which also contains "under").
        await expect(page.getByText(/^under \S/i)).toBeVisible();

        // No admin sidebar in the playground (the console sidebar trigger is gone).
        await expect(page.getByRole('button', { name: /toggle sidebar/i })).toHaveCount(0);

        // Exit returns to the console.
        await expect(page.getByRole('link', { name: /exit/i })).toBeVisible();
    });

    test('renamed nav labels are reflected in the top bar', async ({ page }) => {
        await page.goto('/playground/llm');
        await expect(page.getByText('Agent Playground').first()).toBeVisible();
    });

    test('Agent Playground exposes Text generation / Guardrails / NER tabs', async ({ page }) => {
        // The Agent Playground is tenant-scoped (WorkingTenantGate): select a working
        // tenant BEFORE navigating so the gate opens on first render. A working admin
        // uses the TenantSwitcher now present in the playground top bar.
        await selectWorkingTenant(page);
        await page.goto('/playground/llm');
        await expect(page.getByRole('tab', { name: 'Text generation' })).toBeVisible();
        await expect(page.getByRole('tab', { name: 'Guardrails' })).toBeVisible();
        // exact: "NER" is a substring of "Text geNERation".
        await expect(page.getByRole('tab', { name: 'NER', exact: true })).toBeVisible();

        // Guardrails/NER are wired to the ai/* gateway proxy (TASK-446).
        await page.getByRole('tab', { name: 'Guardrails' }).click();
        await expect(page.getByRole('button', { name: /analyze/i })).toBeVisible();
        await page.getByRole('tab', { name: 'NER', exact: true }).click();
        await expect(page.getByRole('button', { name: /extract/i })).toBeVisible();
    });

    test('has no WCAG 2.2 AA violations (light)', async ({ page }) => {
        await page.emulateMedia({ colorScheme: 'light' });
        await page.goto('/playground/voice-profiles');
        await expect(page.getByRole('heading', { level: 1, name: 'My Voice Enrollment & Profiles' })).toBeVisible();
        await expectNoA11yViolations(page);
    });

    test('has no WCAG 2.2 AA violations (dark)', async ({ page }) => {
        await page.emulateMedia({ colorScheme: 'dark' });
        await page.goto('/playground/voice-profiles');
        await expect(page.getByRole('heading', { level: 1, name: 'My Voice Enrollment & Profiles' })).toBeVisible();
        await expectNoA11yViolations(page);
    });
});
