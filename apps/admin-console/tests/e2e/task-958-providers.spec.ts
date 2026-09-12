/**
 * TASK-958 D-10 — `/ai-providers` on the TENANT tier, where one vendor may now
 * hold SEVERAL accounts.
 *
 * WHAT THIS PINS THAT A UNIT TEST CANNOT. The unit suite stubs `fetch`, so it
 * proves the group renders a payload. It cannot prove that the row the dialog
 * PUTs is the row the gateway stores, that `isDefault: true` really clears the
 * sibling that held it (one transaction, D-2), or that deleting a default with
 * a live sibling comes back 409 `CONNECTION_IS_DEFAULT` and is rendered as
 * guidance rather than swallowed. Those are three systems agreeing, and the
 * only place they meet is a running stack.
 *
 * SERIAL on purpose: every test after the first one reads state the previous
 * test created on the server. A failure therefore skips the rest — which is why
 * cleanup lives in `afterAll` (on its own context) and not in a final test.
 *
 * NO REAL CREDENTIAL IS EVER TYPED. Every row this spec creates is saved
 * `enabled: false` and keyless, which is exactly the state the Add-connection
 * dialog produces. Nothing here needs a vendor key to reach the states it
 * asserts.
 */

import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { WCAG_TAGS, expectDistinctControlNames } from './helpers/a11y';
import { loginAsAdmin, selectWorkingTenant } from './helpers/auth';
import { API_DOWN_MESSAGE, APP_DOWN_MESSAGE, apiAvailable, appAvailable } from './helpers/stack';

const PROVIDER = 'openai';
const PROVIDER_LABEL = 'OpenAI';
const SIBLING_SLUG = 'openai-research';
const SIBLING_NAME = 'Research account';
/** `OpenAI · Research account` — `title` in provider-credential-card.tsx. */
const SIBLING_TITLE = `${PROVIDER_LABEL} · ${SIBLING_NAME}`;
const DEFAULT_MODEL_ID = 'gpt-5.4-mini';
const SIBLING_MODEL_ID = 'gpt-5.4-mini';

const SHOTS = 'test-results/task-958';
/**
 * The session saved by auth.setup.ts. Spelled out rather than imported: that
 * module registers a `setup()` test at import time, so importing it into a spec
 * would graft that test onto this file.
 */
const ADMIN_STORAGE_STATE = 'test-results/.auth/admin.json';

/** Did THIS run create the default `openai` row? Only then does cleanup remove it. */
let createdDefaultRow = false;
/** The a11y block provisions its two rows once, not per test (they live on the server). */
let provisionedForA11y = false;

// ---------------------------------------------------------------------------
// BFF helpers. Every call runs INSIDE the page: the console's session cookie is
// `Secure`, so `page.request` does not send it over plain http (the same reason
// helpers/auth.ts drives its fetches through `page.evaluate`).
// ---------------------------------------------------------------------------

/** The tenant id the screen itself parameterises every read and write by (`useProviderScope`). */
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

/**
 * Create a keyless, disabled connection through the BFF — the same request the
 * Add-connection dialog makes (`If-Match: "0"` is the documented create
 * precondition). Used only to establish a PRECONDITION; the dialog itself is
 * exercised through the UI below.
 */
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

async function deleteConnection(page: Page, tenantId: string, slug: string): Promise<number> {
  return page.evaluate(
    async ({ tenant, connectionSlug }) => {
      const response = await fetch(`/api/hope/admin/providers/llm/${connectionSlug}?tenantId=${encodeURIComponent(tenant)}`, { method: 'DELETE' });
      return response.status;
    },
    { tenant: tenantId, connectionSlug: slug },
  );
}

/**
 * The axe half of the shared gate, on its own.
 *
 * `expectNoA11yViolations` rides `expectDistinctControlNames` along on every axe
 * call site. On this screen that second check currently fails for a reason that
 * has nothing to do with axe (see the recorded defect at the end of this file),
 * and folding them together would hide a passing axe scan behind an unrelated
 * failure. Both checks still run — they are simply reported separately.
 */
async function expectNoAxeViolations(page: Page): Promise<void> {
  // Jump in-flight transitions to their end state, exactly as the shared helper
  // does — axe otherwise samples a transient colour and reports phantom contrast.
  await page.addStyleTag({ content: '*, *::before, *::after { transition: none !important; animation: none !important; }' });
  const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
  expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([]);
}

// ---------------------------------------------------------------------------
// Page objects
// ---------------------------------------------------------------------------

/** The provider's card GROUP — `role="group"`, labelled `"<Provider> connections"`. */
const group = (page: Page) => page.getByRole('group', { name: `${PROVIDER_LABEL} connections`, exact: true });

/**
 * One card. Cards are `<Card aria-labelledby=…>` around an `<h3>`; `.last()` is
 * the innermost `[aria-labelledby]` match (the card itself, not the ancestor
 * `<section>` that is also labelled) — the precedent is task-932-ai-providers.
 */
const card = (page: Page, heading: string) =>
  page
    .locator('[aria-labelledby]')
    .filter({ has: page.getByRole('heading', { level: 3, name: heading, exact: true }) })
    .last();

const defaultCard = (page: Page) => card(page, PROVIDER_LABEL);
const siblingCard = (page: Page) => card(page, SIBLING_TITLE);

/**
 * Open the tab and wait for the OpenAI group to actually carry its cards.
 *
 * The retry is for the GATEWAY'S RATE LIMITER, not for flakiness. This screen
 * issues one read PER CARD plus the list and the platform defaults — a dozen
 * gateway calls per tab — so a dense serial run can trip `TieredThrottlerGuard`
 * and every card then renders "Too Many Requests" instead of its heading. That
 * is the harness crowding the gateway; backing off and re-reading is the honest
 * response, whereas asserting against a throttled page would report a screen
 * defect that is not there.
 */
async function openTextGenerationTab(page: Page): Promise<void> {
  const heading = page.getByRole('heading', { level: 3, name: PROVIDER_LABEL, exact: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    await page.goto('/ai-providers');
    await expect(page.getByRole('heading', { level: 1, name: 'AI providers' })).toBeVisible();
    await page.getByRole('tab', { name: 'Text generation' }).click();
    // The group only exists once the per-tab connection list has settled.
    await expect(group(page)).toBeVisible();
    await expect(heading.or(page.getByText('Too Many Requests').first()).first()).toBeVisible();
    if ((await heading.count()) > 0) return;
    // The tier baselines are DB-backed with a 60s window, so a short back-off
    // just lands in the same bucket. Wait out most of it, once.
    await page.waitForTimeout(35_000);
  }
  await expect(heading, 'the OpenAI cards never loaded — the gateway kept answering 429').toBeVisible();
}

/** Declare ONE model on a card and save the list. */
async function declareModel(page: Page, target: ReturnType<typeof card>, wireModelId: string, displayName: string): Promise<void> {
  await expect(target.getByText('Models this connection serves')).toBeVisible();
  await target.getByRole('button', { name: 'Add model', exact: true }).click();
  const idField = target.getByRole('textbox', { name: 'Model / deployment id' }).last();
  await idField.fill(wireModelId);
  await target.getByRole('textbox', { name: 'Display name' }).last().fill(displayName);
  await target.getByRole('button', { name: /^Save the .* model list$/ }).click();
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
  // The tenant tier IS "elevated + a working tenant" (`useProviderScope`), and
  // the suite ships only a super-admin session — so this is how the tenant tier
  // is reached here.
  await selectWorkingTenant(page);
});

test.afterAll(async ({ browser }) => {
  if (!(await appAvailable()) || !(await apiAvailable())) return;
  // A fresh context: `afterAll` has no `page`, and the saved storage state
  // carries no working tenant (auth.setup.ts never selects one).
  const context = await browser.newContext({ storageState: ADMIN_STORAGE_STATE });
  const page = await context.newPage();
  try {
    await loginAsAdmin(page);
    await selectWorkingTenant(page);
    const tenantId = await scopedTenantId(page);
    // Sibling first: the default cannot be removed while it has one (D-2/OQ-6).
    await deleteConnection(page, tenantId, SIBLING_SLUG);
    if (createdDefaultRow) await deleteConnection(page, tenantId, PROVIDER);
  } finally {
    await context.close();
  }
});

test.describe('TASK-958 — /ai-providers, one vendor with several connections', () => {
  test('the OpenAI group renders its default card, the add button, and no Default badge while it is alone', async ({ page }) => {
    await openTextGenerationTab(page);

    const tenantId = await scopedTenantId(page);
    // Precondition, not an assertion: the delete and models-editor cases below
    // need a STORED default row (`current.version > 0`). Created keyless and
    // disabled — the same shape the dialog produces — and removed in afterAll
    // only if this run is what created it.
    const before = await listConnections(page, tenantId);
    if (!before.some((row) => (row.slug ?? row.provider) === PROVIDER)) {
      const status = await putKeylessConnection(page, tenantId, PROVIDER);
      expect(status, `could not create the ${PROVIDER} default row (HTTP ${status})`).toBeLessThan(300);
      createdDefaultRow = true;
      await page.reload();
      await page.getByRole('tab', { name: 'Text generation' }).click();
    }

    await expect(group(page).getByRole('button', { name: `Add another ${PROVIDER_LABEL} connection`, exact: true })).toBeVisible();
    // D-10: the badge is rendered only where the provider HAS siblings — a lone
    // card is its provider's default by construction, and saying so on every
    // card would be noise. It appears in the next test, once a sibling exists.
    await expect(group(page).getByText('Default', { exact: true })).toHaveCount(0);
  });

  test('a malformed slug is refused INLINE, and nothing is created', async ({ page }) => {
    await openTextGenerationTab(page);
    await group(page).getByRole('button', { name: `Add another ${PROVIDER_LABEL} connection`, exact: true }).click();

    const dialog = page.getByRole('dialog', { name: `Add another ${PROVIDER_LABEL} connection`, exact: true });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('textbox', { name: /Connection id/ }).fill('Bad Slug!');
    await dialog.getByRole('button', { name: 'Create connection', exact: true }).click();

    await expect(dialog.getByRole('alert')).toContainText(/lowercase letters, digits or hyphens/);
    // Refused means refused: the dialog stays open on the rejected value.
    await expect(dialog).toBeVisible();
    await expect(card(page, `${PROVIDER_LABEL} · Bad Slug!`)).toHaveCount(0);
  });

  test('creating openai-research adds a named sibling card, keyless, with the key field focused', async ({ page }) => {
    await openTextGenerationTab(page);
    await group(page).getByRole('button', { name: `Add another ${PROVIDER_LABEL} connection`, exact: true }).click();

    const dialog = page.getByRole('dialog', { name: `Add another ${PROVIDER_LABEL} connection`, exact: true });
    await dialog.getByRole('textbox', { name: /Connection id/ }).fill(SIBLING_SLUG);
    await dialog.getByRole('textbox', { name: 'Display name', exact: true }).fill(SIBLING_NAME);
    await dialog.getByRole('button', { name: 'Create connection', exact: true }).click();

    // The row is created `enabled: false` and KEYLESS — no credential is typed
    // anywhere in this flow, and the gateway accepts it.
    await expect(page.getByText(/created — add its credential to enable it/)).toBeVisible();
    await expect(dialog).toBeHidden();

    const sibling = siblingCard(page);
    await expect(sibling).toBeVisible();
    await expect(sibling.getByText('no key', { exact: true })).toBeVisible();
    // Name AND slug are both legible: the heading carries the name, the card's
    // own mono badge carries the slug it is addressed by.
    await expect(sibling).toContainText(SIBLING_SLUG);

    // D-10: now that the provider has two connections, the default is marked.
    await expect(defaultCard(page).getByText('Default', { exact: true })).toBeVisible();

    // The one thing still missing from the new row takes focus (`autoFocusKey`).
    await expect(sibling.locator('input[id$="-key"]')).toBeFocused();
  });

  test('the models editor appears on the saved sibling, and a model is declared on each connection', async ({ page }) => {
    await openTextGenerationTab(page);

    // The editor exists only once a row is STORED (`current.version > 0`), which
    // is precisely what the dialog's create established.
    await declareModel(page, siblingCard(page), SIBLING_MODEL_ID, 'GPT-5.4 mini (research)');
    await expect(page.getByText(`${SIBLING_TITLE} models saved`)).toBeVisible();

    await declareModel(page, defaultCard(page), DEFAULT_MODEL_ID, 'GPT-5.4 mini (production)');
    await expect(page.getByText(`${PROVIDER_LABEL} models saved`)).toBeVisible();
  });

  test('"Make default" moves the badge onto the sibling, and the previous default loses it', async ({ page }) => {
    await openTextGenerationTab(page);

    await siblingCard(page).getByRole('button', { name: `Make ${SIBLING_TITLE} the default ${PROVIDER_LABEL} connection`, exact: true }).click();
    await expect(page.getByText(`${SIBLING_TITLE} is now the default ${PROVIDER_LABEL} connection`)).toBeVisible();

    // The flip is atomic server-side (D-2) — exactly one card carries the badge.
    await expect(siblingCard(page).getByText('Default', { exact: true })).toBeVisible();
    await expect(defaultCard(page).getByText('Default', { exact: true })).toHaveCount(0);
    await expect(group(page).getByText('Default', { exact: true })).toHaveCount(1);
  });

  test('deleting the default while a sibling lives is refused 409, and the guidance is rendered IN PLACE', async ({ page }) => {
    await openTextGenerationTab(page);

    // Put the default back on the canonical row, so the row under test is a
    // DEFAULT with a live sibling — the state OQ-6 refuses to resolve silently.
    await defaultCard(page).getByRole('button', { name: `Make ${PROVIDER_LABEL} the default ${PROVIDER_LABEL} connection`, exact: true }).click();
    await expect(defaultCard(page).getByText('Default', { exact: true })).toBeVisible();

    const target = defaultCard(page);
    await target.getByRole('button', { name: `Remove the ${PROVIDER_LABEL} connection (use platform default)`, exact: true }).click();
    await target.getByRole('button', { name: 'Confirm remove', exact: true }).click();

    // In place, beside the confirmation that produced it — NOT (only) a toast
    // that vanishes and leaves the row saying nothing about why nothing happened.
    await expect(target.getByRole('alert')).toContainText('Make another connection the default first');
    await expect(target).toBeVisible();
    // And it really was refused: the card is still there.
    await expect(page.getByRole('heading', { level: 3, name: PROVIDER_LABEL, exact: true })).toBeVisible();
  });

  test('removing the sibling withdraws its card, and the default is then removable', async ({ page }) => {
    await openTextGenerationTab(page);

    const sibling = siblingCard(page);
    await sibling.getByRole('button', { name: `Remove the ${SIBLING_TITLE} connection`, exact: true }).click();
    await sibling.getByRole('button', { name: 'Confirm remove', exact: true }).click();

    // The OBSERVABLE outcome, asserted independently of the toast — which does
    // not fire on this path (see the recorded defect below).
    await expect(siblingCard(page)).toHaveCount(0);
    // Alone again: the badge goes with the sibling that made it meaningful.
    await expect(group(page).getByText('Default', { exact: true })).toHaveCount(0);

    if (createdDefaultRow) {
      const target = defaultCard(page);
      await target.getByRole('button', { name: `Remove the ${PROVIDER_LABEL} connection (use platform default)`, exact: true }).click();
      await target.getByRole('button', { name: 'Confirm remove', exact: true }).click();
      // The DEFAULT card is never unmounted by its own removal (the group always
      // renders the canonical slug), so its success toast DOES fire. That
      // contrast is what identifies the sibling defect below.
      await expect(page.getByText(/connection removed — the platform default serves this provider again/)).toBeVisible();
      createdDefaultRow = false;
    }
  });

  /**
   * RECORDED DEFECT — removing a SIBLING connection succeeds SILENTLY.
   *
   * Measured 2026-09-12 against the dev stack (gateway `0.0.0-dev-2-2.719ceaaf`):
   * `DELETE admin/providers/llm/openai-research` answers **200** and the audit
   * log carries `connection-deleted`, but the string "… connection removed"
   * appears in NO DOM snapshot of the whole Playwright trace, while every other
   * toast on this screen (create, models saved, "is now the default") does.
   *
   * Mechanism: `useDeleteProviderConnection`'s hook-level `onSuccess` awaits
   * `invalidateQueries(service)`. That refetch drops the row from the list, the
   * group unmounts the sibling's `ProviderCredentialCard` — and TanStack Query
   * v5 then skips the per-call `mutate(…, { onSuccess })` callbacks, because
   * their observer is gone. `handleRemove`'s `toast.success` lives in exactly
   * that callback. The DEFAULT card never unmounts, which is why only the
   * sibling path is silent.
   *
   * This breaks rule 11 §5 ("every action produces visible feedback"; "never
   * silently succeed"). It is Lane G's to fix, not this lane's.
   *
   * `test.fail()` keeps the CORRECT assertion in the suite without weakening it:
   * the run stays green while the defect is open, and turns red the moment it is
   * fixed ("expected to fail but passed") — which is the signal to delete this
   * marker rather than to edit the assertion.
   */
  test('DEFECT: removing a sibling connection reports success to the user', async ({ page }) => {
    test.fail();

    await page.goto('/ai-providers');
    const tenantId = await scopedTenantId(page);
    const rows = await listConnections(page, tenantId);
    if (!rows.some((row) => (row.slug ?? row.provider) === PROVIDER)) {
      expect(await putKeylessConnection(page, tenantId, PROVIDER)).toBeLessThan(300);
      createdDefaultRow = true;
    }
    if (!rows.some((row) => row.slug === SIBLING_SLUG)) {
      expect(await putKeylessConnection(page, tenantId, SIBLING_SLUG, SIBLING_NAME)).toBeLessThan(300);
    }

    await openTextGenerationTab(page);
    const sibling = siblingCard(page);
    await sibling.getByRole('button', { name: `Remove the ${SIBLING_TITLE} connection`, exact: true }).click();
    await sibling.getByRole('button', { name: 'Confirm remove', exact: true }).click();

    await expect(page.getByText(`${SIBLING_TITLE} connection removed`)).toBeVisible();
  });
});

test.describe('TASK-958 — /ai-providers accessibility, themes and zoom', () => {
  /**
   * A sibling is a PRECONDITION for these: the group's multi-card shape (the
   * badge, "Make default", the sibling's own state vocabulary) is what is being
   * scanned, and a single card would scan the screen TASK-932 already covers.
   */
  test.beforeEach(async ({ page }) => {
    // The retry budget in `openTextGenerationTab` (gateway 429s) does not fit
    // the 30s default.
    test.slow();
    // Provision ONCE for the whole block: the rows live on the server, so
    // re-checking them per test would only add gateway calls to a suite that is
    // already dense enough to trip the rate limiter.
    if (provisionedForA11y) return;
    await page.goto('/ai-providers');
    const tenantId = await scopedTenantId(page);
    const rows = await listConnections(page, tenantId);
    if (!rows.some((row) => (row.slug ?? row.provider) === PROVIDER)) {
      const status = await putKeylessConnection(page, tenantId, PROVIDER);
      expect(status, `could not create the ${PROVIDER} default row (HTTP ${status})`).toBeLessThan(300);
      createdDefaultRow = true;
    }
    if (!rows.some((row) => row.slug === SIBLING_SLUG)) {
      // With its NAME: the card's heading (and therefore every locator below)
      // is `OpenAI · <name>`, falling back to the slug only when unnamed.
      const status = await putKeylessConnection(page, tenantId, SIBLING_SLUG, SIBLING_NAME);
      expect(status, `could not create the ${SIBLING_SLUG} sibling row (HTTP ${status})`).toBeLessThan(300);
    }
    provisionedForA11y = true;
  });

  /**
   * Both states in ONE test per theme, deliberately. Each visit to this screen
   * costs a dozen gateway reads (one per card, plus the list and the platform
   * defaults), and a separate test per state doubled that for no extra coverage:
   * the dialog is opened from the very page the group scan just validated.
   */
  for (const theme of ['light', 'dark'] as const) {
    test(`has no WCAG 2.2 AA violations with card groups, nor with the add dialog open (${theme})`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: theme });
      await openTextGenerationTab(page);
      await expect(siblingCard(page)).toBeVisible();
      // The GROUP element, not the page: this console scrolls INSIDE the shell
      // (`h-svh overflow-hidden`), so `fullPage` captures only the viewport and
      // the cards — the actual subject — sit below the fold.
      await group(page).scrollIntoViewIfNeeded();
      await group(page).screenshot({ path: `${SHOTS}/providers-group-${theme}.png` });
      await expectNoAxeViolations(page);

      await group(page).getByRole('button', { name: `Add another ${PROVIDER_LABEL} connection`, exact: true }).click();
      await expect(page.getByRole('dialog', { name: `Add another ${PROVIDER_LABEL} connection`, exact: true })).toBeVisible();
      await page.screenshot({ path: `${SHOTS}/providers-dialog-${theme}.png`, fullPage: true });
      await expectNoAxeViolations(page);
    });
  }

  test('at 200 % zoom (640 CSS px) the group reflows with no horizontal page scrolling', async ({ page }) => {
    await page.setViewportSize({ width: 640, height: 1000 });
    await openTextGenerationTab(page);
    await expect(siblingCard(page)).toBeVisible();
    await group(page).scrollIntoViewIfNeeded();
    await group(page).screenshot({ path: `${SHOTS}/providers-group-zoom200.png` });

    // WCAG 1.4.10 Reflow: content must not require scrolling in two directions.
    const overflowsHorizontally = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
    expect(overflowsHorizontally, 'the page scrolls horizontally at 200 % zoom').toBe(false);

    // WCAG 2.4.11 Focus Not Obscured: the add button, focused at that width, is
    // fully inside the viewport rather than under pinned chrome.
    const addButton = group(page).getByRole('button', { name: `Add another ${PROVIDER_LABEL} connection`, exact: true });
    await addButton.focus();
    const obscured = await addButton.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      if (rect.top < 0 || rect.bottom > window.innerHeight) return 'outside the viewport after focus';
      // The element at the focused control's own centre must be the control (or
      // inside it) — anything else is pinned chrome sitting on top of it.
      const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      return hit && (element === hit || element.contains(hit)) ? null : 'covered by another element';
    });
    expect(obscured, `the focused "Add another" button is ${obscured}`).toBeNull();
  });

  test('the add dialog is keyboard-operable: slug → name → footer, and Escape closes it', async ({ page }) => {
    await openTextGenerationTab(page);
    const addButton = group(page).getByRole('button', { name: `Add another ${PROVIDER_LABEL} connection`, exact: true });
    await addButton.click();

    const dialog = page.getByRole('dialog', { name: `Add another ${PROVIDER_LABEL} connection`, exact: true });
    await expect(dialog).toBeVisible();

    // The dialog opens ON the field it needs first (`autoFocus` on the slug).
    await expect(dialog.getByRole('textbox', { name: /Connection id/ })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(dialog.getByRole('textbox', { name: 'Display name', exact: true })).toBeFocused();
    await page.keyboard.press('Tab');
    // DOM order in `DialogFooter` is Cancel, then the submit.
    await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(dialog.getByRole('button', { name: 'Create connection', exact: true })).toBeFocused();

    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
  });

  /**
   * RECORDED DEFECT — closing the Add-connection dialog drops focus.
   *
   * Measured 2026-09-12: the tab order inside the dialog is correct and Escape
   * closes it (the test above passes), but focus is NOT returned to the
   * "Add another OpenAI connection" button that opened it — Playwright reports
   * the trigger as `inactive`, and the assertion message below names whatever
   * did receive focus.
   *
   * A keyboard user who opens the dialog, changes their mind and presses Escape
   * is therefore dumped back to the start of the document and has to traverse
   * the whole page again to get back to where they were. Rule 11 §11 asks for
   * exactly the opposite ("dialogs/popovers manage focus — Radix primitives
   * already do; don't break it"), and Radix restores focus to the node that held
   * it at open time, so the likely cause is that the group re-renders while the
   * dialog is open and the remembered node is no longer the one in the document.
   *
   * `test.fail()`: the assertion is correct and stays; the run is green while
   * the defect is open and turns red when focus restoration starts working.
   */
  test('DEFECT: closing the add dialog returns focus to the button that opened it', async ({ page }) => {
    test.fail();

    await openTextGenerationTab(page);
    const addButton = group(page).getByRole('button', { name: `Add another ${PROVIDER_LABEL} connection`, exact: true });
    await addButton.click();
    const dialog = page.getByRole('dialog', { name: `Add another ${PROVIDER_LABEL} connection`, exact: true });
    await expect(dialog).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();

    // Name the element that actually holds focus, so the failure is a finding
    // rather than a bare "not focused".
    const active = await page.evaluate(() => {
      const element = document.activeElement;
      if (!element || element === document.body) return 'document.body (focus was dropped entirely)';
      const label = element.getAttribute('aria-label');
      return `<${element.tagName.toLowerCase()}>${label ? ` aria-label="${label}"` : ''}`;
    });
    await expect(addButton, `focus went to ${active} instead of the trigger`).toBeFocused();
  });

  /**
   * RECORDED DEFECT — two connections of one vendor give a screen-reader user
   * two identically-named buttons.
   *
   * Measured 2026-09-12 on `/ai-providers` with an OpenAI group of two cards:
   *
   *     2x "Add model"             (allowlist entry: '/ai-providers::Add model')
   *     2x "Derive from provider"  (allowlist entry: '/ai-providers::Derive from provider')
   *
   * Each card renders its own `ConnectionModelsEditor`, and those two buttons
   * are the only controls in it that are NOT scoped to the connection — the save
   * button already reads `Save the <connection> model list` and the row delete
   * reads `Remove <model id>`. So a user tabbing the page hears "Add model"
   * twice with nothing to say which account it adds to, which is precisely the
   * ambiguity `expectDistinctControlNames` exists to catch. The remedy the guard
   * itself prescribes is to EXTEND the name, never to replace it (WCAG 2.5.3
   * Label in Name): `Add model to <connection>`.
   *
   * Reachable before TASK-958 with two saved connections of DIFFERENT vendors,
   * but this ticket makes it the headline case — two accounts of ONE vendor —
   * and the pair is not in the helper's `KNOWN_DUPLICATES` allowlist.
   *
   * `test.fail()` again: the assertion is the correct one, the run stays green
   * while the defect is open, and it turns red the moment the names are fixed.
   * Fixing it belongs to the console lane, not to this verification lane; the
   * allowlist is deliberately NOT extended, because that would record the
   * ambiguity as acceptable.
   */
  test('DEFECT: the per-connection model editors have distinct control names', async ({ page }) => {
    test.fail();

    await openTextGenerationTab(page);
    await expect(siblingCard(page)).toBeVisible();
    await expectDistinctControlNames(page);
  });
});
