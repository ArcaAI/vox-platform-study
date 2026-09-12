/**
 * TASK-958 D-5/D-7 — the two places a tenant READS BACK which key it is about
 * to spend, and which key it spent.
 *
 *  - the agent create wizard's Model step: one provider entry PER CONNECTION,
 *    the model select scoped to the chosen connection, and a fallback list that
 *    names the connection beside a BYO model (`Model · Connection`) while a
 *    Hope-provider model stays a bare name.
 *  - `/ai-operations/consumption`: the "Connection" column, which exists only
 *    when the ledger actually carries `connectionId`.
 *
 * SERIAL, and self-provisioning: the picker cases need two OpenAI connections
 * with declared models, which this file creates through the BFF and removes in
 * `afterAll`. No vendor credential is typed anywhere — both rows are keyless and
 * disabled, which is enough to make the catalogue render one entry per
 * connection (an unusable provider is shown greyed with its reason, never
 * hidden — the rule agents.spec.ts already pins).
 */

import { expect, test, type Page } from '@playwright/test';
import { expectNoA11yViolations } from './helpers/a11y';
import { loginAsAdmin, selectWorkingTenant } from './helpers/auth';
import { API_DOWN_MESSAGE, APP_DOWN_MESSAGE, apiAvailable, appAvailable } from './helpers/stack';

const PROVIDER = 'openai';
const PROVIDER_LABEL = 'OpenAI';
const SIBLING_SLUG = 'openai-picker-research';
const SIBLING_NAME = 'Picker research account';
const SHOTS = 'test-results/task-958';
/** See the note in task-958-providers.spec.ts — imported by value, not from auth.setup.ts. */
const ADMIN_STORAGE_STATE = 'test-results/.auth/admin.json';

/** Rows THIS file created, so cleanup removes only those. */
const created: string[] = [];

// ---------------------------------------------------------------------------
// BFF helpers (inside the page — the session cookie is `Secure`; see
// helpers/auth.ts for the same reason).
// ---------------------------------------------------------------------------

async function scopedTenantId(page: Page): Promise<string> {
  const tenantId = await page.evaluate(async () => {
    const response = await fetch('/api/auth/session');
    if (!response.ok) return null;
    const session = (await response.json()) as { effectiveTenantId?: string; effectiveUser?: { tenantId?: string } };
    return session.effectiveTenantId ?? session.effectiveUser?.tenantId ?? null;
  });
  expect(tenantId, 'the session carries no effective tenant — selectWorkingTenant() did not take').toBeTruthy();
  return tenantId as string;
}

async function listConnections(page: Page, tenantId: string): Promise<Array<{ slug?: string; provider: string }>> {
  return page.evaluate(async (tenant) => {
    const response = await fetch(`/api/hope/admin/providers/llm?tenantId=${encodeURIComponent(tenant)}`);
    if (!response.ok) return [];
    const body = (await response.json()) as Array<{ slug?: string; provider: string }> | { data?: Array<{ slug?: string; provider: string }> };
    return Array.isArray(body) ? body : (body.data ?? []);
  }, tenantId);
}

/** The Add-connection dialog's own request: keyless, disabled, `If-Match: "0"`. */
async function putKeylessConnection(page: Page, tenantId: string, slug: string, name?: string): Promise<number> {
  return page.evaluate(
    async ({ tenant, connectionSlug, displayName }) => {
      const response = await fetch(`/api/hope/admin/providers/llm/${connectionSlug}?tenantId=${encodeURIComponent(tenant)}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', 'if-match': '"0"' },
        body: JSON.stringify({ provider: 'openai', enabled: false, expectedVersion: 0, ...(displayName ? { name: displayName } : {}) }),
      });
      return response.status;
    },
    { tenant: tenantId, connectionSlug: slug, displayName: name },
  );
}

/** `PUT …/:slug/models` — the whole list, no If-Match (it writes registry rows, not the row). */
async function declareModels(page: Page, tenantId: string, slug: string, wireModelId: string, name: string): Promise<number> {
  return page.evaluate(
    async ({ tenant, connectionSlug, wire, displayName }) => {
      const response = await fetch(`/api/hope/admin/providers/llm/${connectionSlug}/models?tenantId=${encodeURIComponent(tenant)}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ models: [{ wireModelId: wire, name: displayName, taskType: 'TEXT_GENERATION' }] }),
      });
      return response.status;
    },
    { tenant: tenantId, connectionSlug: slug, wire: wireModelId, displayName: name },
  );
}

async function deleteConnection(page: Page, tenantId: string, slug: string): Promise<number> {
  return page.evaluate(
    async ({ tenant, connectionSlug }) => {
      const response = await fetch(`/api/hope/admin/providers/llm/${connectionSlug}?tenantId=${encodeURIComponent(tenant)}`, { method: 'DELETE' });
      return response.status;
    },
    { tenant: tenantId, connectionSlug: slug },
  );
}

/** Both connections, each with one declared model. Idempotent. */
async function ensureTwoConnections(page: Page): Promise<void> {
  const tenantId = await scopedTenantId(page);
  const rows = await listConnections(page, tenantId);

  if (!rows.some((row) => (row.slug ?? row.provider) === PROVIDER)) {
    const status = await putKeylessConnection(page, tenantId, PROVIDER);
    expect(status, `could not create the ${PROVIDER} default row (HTTP ${status})`).toBeLessThan(300);
    created.push(PROVIDER);
  }
  if (!rows.some((row) => row.slug === SIBLING_SLUG)) {
    const status = await putKeylessConnection(page, tenantId, SIBLING_SLUG, SIBLING_NAME);
    expect(status, `could not create the ${SIBLING_SLUG} sibling row (HTTP ${status})`).toBeLessThan(300);
    created.push(SIBLING_SLUG);
  }

  // Declared on BOTH, so the model select has something to be scoped TO. The
  // console's own editor offers exactly this on a saved keyless row, so a
  // refusal here would be a console/gateway disagreement, not a bad precondition.
  for (const [slug, wire, name] of [
    [PROVIDER, 'gpt-5.4-mini', 'GPT-5.4 mini (production)'],
    [SIBLING_SLUG, 'gpt-5.4-mini', 'GPT-5.4 mini (research)'],
  ] as const) {
    const status = await declareModels(page, tenantId, slug, wire, name);
    expect(status, `could not declare a model on ${slug} (HTTP ${status})`).toBeLessThan(300);
  }
}

/** Open the create wizard and advance Task → Model. */
async function wizardOnModelStep(page: Page) {
  await page.goto('/agents?create=1');
  const wizard = page.getByRole('dialog', { name: 'New agent' });
  await expect(wizard).toBeVisible();
  await wizard.getByRole('textbox', { name: /^Name/ }).fill(`TASK-958 picker ${Date.now()}`);
  await wizard.getByRole('button', { name: 'Next' }).click();
  // `exact` on both: the same step renders "Fallback models (in order)", which a
  // substring match on "Model" also resolves to (strict mode then fails).
  await expect(wizard.getByLabel('Provider', { exact: true })).toBeVisible();
  await expect(wizard.getByLabel('Model', { exact: true })).toBeVisible();
  return wizard;
}

// ---------------------------------------------------------------------------

test.describe.configure({ mode: 'serial' });

test.beforeEach(async ({ page }) => {
  test.skip(!(await appAvailable()), APP_DOWN_MESSAGE);
  test.skip(!(await apiAvailable()), API_DOWN_MESSAGE);
  // Every test here costs a session bootstrap plus a read-heavy screen, and the
  // gateway's tiered rate limiter will stall a call rather than fail it under a
  // dense serial run. The 30s default leaves no room for that to clear.
  test.slow();
  await loginAsAdmin(page);
  await selectWorkingTenant(page);
});

test.afterAll(async ({ browser }) => {
  if (!(await appAvailable()) || !(await apiAvailable())) return;
  const context = await browser.newContext({ storageState: ADMIN_STORAGE_STATE });
  const page = await context.newPage();
  try {
    await loginAsAdmin(page);
    await selectWorkingTenant(page);
    const tenantId = await scopedTenantId(page);
    // Siblings before the default: a default with a live sibling is refused 409.
    for (const slug of [...created].sort((a) => (a === PROVIDER ? 1 : -1))) {
      await deleteConnection(page, tenantId, slug);
    }
    created.length = 0;
  } finally {
    await context.close();
  }
});

test.describe('TASK-958 — the agent wizard Model step names the connection', () => {
  test('the Provider select lists ONE OpenAI entry per connection, labelled by name or slug, with the default marked', async ({ page }) => {
    await page.goto('/agents');
    await ensureTwoConnections(page);

    const wizard = await wizardOnModelStep(page);
    await wizard.getByLabel('Provider', { exact: true }).click();

    // D-5: one catalogue provider per CONNECTION (`byo:llm:<connectionSlug>`),
    // not one per vendor. Both carry the vendor label; the connection half is
    // what tells them apart.
    const openAiOptions = page.getByRole('option').filter({ hasText: `${PROVIDER_LABEL} (BYO)` });
    await expect(openAiOptions).toHaveCount(2);

    // The sibling is named by its DISPLAY NAME…
    await expect(page.getByRole('option').filter({ hasText: SIBLING_NAME })).toHaveCount(1);
    // …and the default by its slug plus the `Default` marker (`connectionLabel`).
    await expect(page.getByRole('option').filter({ hasText: `${PROVIDER} · Default` })).toHaveCount(1);
  });

  test('the Model select is scoped to the chosen connection', async ({ page }) => {
    await page.goto('/agents');
    await ensureTwoConnections(page);

    const wizard = await wizardOnModelStep(page);

    await wizard.getByLabel('Provider', { exact: true }).click();
    await page.getByRole('option').filter({ hasText: SIBLING_NAME }).click();
    await wizard.getByLabel('Model', { exact: true }).click();
    // Only the model declared on THAT connection — the research row, not the
    // production one, even though both carry the same wire id.
    await expect(page.getByRole('option', { name: /GPT-5\.4 mini \(research\)/ })).toBeVisible();
    await expect(page.getByRole('option', { name: /GPT-5\.4 mini \(production\)/ })).toHaveCount(0);
    await page.keyboard.press('Escape');

    await wizard.getByLabel('Provider', { exact: true }).click();
    await page.getByRole('option').filter({ hasText: `${PROVIDER} · Default` }).click();
    await wizard.getByLabel('Model', { exact: true }).click();
    await expect(page.getByRole('option', { name: /GPT-5\.4 mini \(production\)/ })).toBeVisible();
    await expect(page.getByRole('option', { name: /GPT-5\.4 mini \(research\)/ })).toHaveCount(0);
  });

  test('the fallback select labels a BYO model "Model · Connection" and a Hope model by name alone', async ({ page }) => {
    await page.goto('/agents');
    await ensureTwoConnections(page);

    const wizard = await wizardOnModelStep(page);
    await wizard.getByLabel('Fallback models (in order)', { exact: true }).click();

    // `fallbackModelOptionLabel`: a BYO model carries its connection, because the
    // connection is the only thing that differs between two rows of one vendor —
    // and telling them apart is the point of a fallback.
    await expect(page.getByRole('option', { name: `GPT-5.4 mini (research) · ${SIBLING_NAME}` })).toBeVisible();
    await expect(page.getByRole('option', { name: `GPT-5.4 mini (production) · ${PROVIDER}` })).toBeVisible();

    // A Hope-provider (platform catalogue) model has no connection to name, and
    // must NOT grow a trailing separator. Skipped where the environment offers
    // none rather than asserted into existence.
    const hopeOption = page.getByRole('option').filter({ hasNotText: ' · ' }).first();
    test.skip((await hopeOption.count()) === 0, 'this environment offers no Hope-provider fallback model');
    await expect(hopeOption).not.toHaveText(/ · $/);
  });

  for (const theme of ['light', 'dark'] as const) {
    test(`the wizard picker has no WCAG 2.2 AA violations and is captured (${theme})`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: theme });
      await page.goto('/agents');
      await ensureTwoConnections(page);

      const wizard = await wizardOnModelStep(page);
      await expect(wizard.getByLabel('Provider', { exact: true })).toBeVisible();
      await page.screenshot({ path: `${SHOTS}/agent-picker-${theme}.png`, fullPage: true });
      await expectNoA11yViolations(page);
    });
  }
});

test.describe('TASK-958 D-7 — the consumption screen carries a Connection column', () => {
  /**
   * The column is CONDITIONAL by design: it exists only when the ledger lines
   * carry `connectionId` at all, because an absent field ("the gateway cannot
   * say") is not the same claim as `null` ("the platform's own credential funded
   * this"), and a column of dashes would render the two identically.
   *
   * So this asserts the RULE, not a row count: the header and the table caption
   * must agree. On a dev database with no metered usage the screen renders its
   * empty state instead, which is reported rather than failed — fabricating
   * ledger rows would test the fixture, not the screen.
   */
  test('the Connection column and the table caption agree (or the period has no usage)', async ({ page }) => {
    await page.goto('/ai-operations/consumption');
    await expect(page.getByRole('heading', { level: 1, name: 'Consumption & Cost' })).toBeVisible();

    const emptyState = page.getByText('No metered usage this period');
    const usageTable = page.getByRole('table', { name: /Usage detail/ });
    await expect(emptyState.or(usageTable).first()).toBeVisible();

    if (await emptyState.isVisible()) {
      test.skip(true, 'no metered usage in this period on this database — the usage-detail table does not render');
    }

    const caption = (await usageTable.locator('caption').textContent()) ?? '';
    const hasConnectionColumn = (await usageTable.getByRole('columnheader', { name: 'Connection', exact: true }).count()) > 0;
    expect(
      hasConnectionColumn,
      `the caption says ${caption.includes('connection') ? '' : 'NO '}connection but the column is ${hasConnectionColumn ? 'present' : 'absent'}: "${caption}"`,
    ).toBe(caption.includes('× connection ×'));
  });
});
