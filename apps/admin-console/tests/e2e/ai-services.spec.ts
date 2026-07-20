/**
 * TASK-532 (M-09) — AI services screen: guardrail + NLP status/config and the
 * agentic instruction set, with the axe gate in both themes (rule 11 §11).
 *
 * WHY THE ERROR-STATE TEST LIVES HERE AND NOT IN VITEST: the jsdom specs stub a
 * 503 and assert the ErrorState, which is necessary but not sufficient — it
 * cannot observe React Query's RETRY behaviour. A retry only continues while
 * `focusManager.isFocused()` is true (`query-core` retryer), and a headless or
 * backgrounded tab reports `document.visibilityState === 'hidden'`, which parks
 * the query at `fetchStatus: 'paused'` forever and leaves the panel on its
 * skeleton. Playwright drives a genuinely visible page, so this is the only
 * layer that proves a failed read actually REACHES the error state in a browser.
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

async function openAiServices(page: Page) {
    await page.goto('/ai-services');
    await expect(page.getByRole('heading', { level: 1, name: 'AI services' })).toBeVisible();
    for (const name of ['Guardrail', 'NLP', 'Instructions']) {
        await expect(page.getByRole('tab', { name })).toBeVisible();
    }
}

test.describe('ai services screen', () => {
    test('renders the three service tabs with no WCAG 2.2 AA violations (light)', async ({ page }) => {
        await page.emulateMedia({ colorScheme: 'light' });
        await openAiServices(page);
        await expectNoA11yViolations(page);
    });

    test('renders the three service tabs with no WCAG 2.2 AA violations (dark)', async ({ page }) => {
        await page.emulateMedia({ colorScheme: 'dark' });
        await openAiServices(page);
        await expectNoA11yViolations(page);
    });

    /**
     * The guardrail/NLP payloads are UPSTREAM-OWNED and pass through the gateway
     * verbatim, so the panel must render whatever arrives without assuming a
     * shape. A shape the console has never seen must degrade to readable
     * key/values — never a crash, never an error state.
     */
    test('renders an unrecognized upstream document defensively instead of failing', async ({ page }) => {
        // Stub BOTH guardrail reads: leaving `config` unstubbed lets the real
        // (possibly down) service 503 into its own ErrorState, which would make
        // a page-wide "no alert" assertion flap for a reason unrelated to shape
        // handling. Each card owns its own error state by design.
        await page.route('**/api/hope/admin/ai-services/guardrail/status', async (route) => {
            await route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({ totally: { different: ['shape', 42] }, status: null }),
            });
        });
        await page.route('**/api/hope/admin/ai-services/guardrail/config', async (route) => {
            await route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({ medicalValidation: { enabled: true }, analysisTypes: { supported: ['pii'] } }),
            });
        });
        await openAiServices(page);

        // The unknown shape is rendered as readable key/values…
        await expect(page.getByText('different')).toBeVisible();
        // …and nothing about it is treated as a failure. Scoped to <main>: the
        // Next.js dev-tools overlay mounts its own role="alert" outside the app,
        // so a page-wide count would assert against the toolbar, not the screen.
        await expect(page.getByRole('main').getByRole('alert')).toHaveCount(0);
    });

    /**
     * The 503 contract (`ai-service-proxy.client.ts`): a transport failure to the
     * Python service surfaces as 503. The panel must SETTLE into an error state
     * with a retry affordance — the skeleton must not be terminal.
     */
    test('settles a 503 from the guardrail proxy into an error state with retry', async ({ page }) => {
        await page.route('**/api/hope/admin/ai-services/guardrail/status', async (route) => {
            await route.fulfill({
                status: 503,
                contentType: 'application/json',
                body: JSON.stringify({ message: 'AI service request failed (GET /api/health)', statusCode: 503 }),
            });
        });
        await openAiServices(page);

        // The point of the test: the loading state is left behind.
        await expect(page.getByRole('alert').first()).toBeVisible({ timeout: 15_000 });
        await expect(page.getByRole('button', { name: /retry/i }).first()).toBeVisible();
    });
});
