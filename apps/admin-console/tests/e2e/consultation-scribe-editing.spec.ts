/**
 * + W2 — runtime verification of the clinician path against a
 * RUNNING gateway. Compiling is not working, and rendering is not writing:
 * these specs assert what actually goes on the WIRE.
 *
 * W1 (C-3/R5): the SOAP note is editable and the edit is persisted through
 *              `PATCH :id/summary/:summaryId` carrying an `If-Match`
 *              precondition (the route is 428 without one).
 * W2 (H-4/R4): `POST /consultations/open` carries `departmentId`, which is the
 *              input the department prompt tier and the workflow-assignment
 *              cascade both resolve from.
 */

import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { WCAG_TAGS, expectNoA11yViolations } from './helpers/a11y';
import { loginAsAdmin, selectWorkingTenant } from './helpers/auth';
import { API_DOWN_MESSAGE, APP_DOWN_MESSAGE, apiAvailable, appAvailable } from './helpers/stack';

const SCRIBE = '/playground/consultation';

test.beforeEach(async ({ page }) => {
  test.skip(!(await appAvailable()), APP_DOWN_MESSAGE);
  test.skip(!(await apiAvailable()), API_DOWN_MESSAGE);
  await loginAsAdmin(page);
  await selectWorkingTenant(page);
});

test.describe('Consultation Scribe — the clinician path', () => {
  test('the workspace renders its three columns and the case-note surface', async ({ page }) => {
    await page.goto(SCRIBE);
    await expect(page.getByRole('heading', { level: 1, name: 'Consultation Scribe' })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Consultations' })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Case note' })).toBeVisible();
  });

  test('W2: opening a consultation sends departmentId on the wire', async ({ page }) => {
    await page.goto(SCRIBE);
    await expect(page.getByRole('region', { name: 'Consultations' })).toBeVisible();

    // Departments come from the admin plane; without any the picker is hidden
    // by design and there is nothing to prove here.
    const departments = await page.evaluate(async () => {
      const res = await fetch('/api/hope/admin/departments?page=1&limit=100');
      if (!res.ok) return [] as Array<{ id: string; name: string }>;
      const body = (await res.json()) as Array<{ id: string; name: string }> | { data?: Array<{ id: string; name: string }> };
      return Array.isArray(body) ? body : (body.data ?? []);
    });
    test.skip(departments.length === 0, 'No departments seeded in the working tenant.');

    const openBody = page.waitForRequest(
      (request) => request.url().includes('/api/hope/consultations/open') && request.method() === 'POST',
    );

    await page.getByRole('button', { name: /^new$/i }).click();
    await page.getByLabel(/patient id/i).fill(`e2e-${Date.now()}`);

    // Choose the first real department in the picker.
    await page.getByLabel('Department').click();
    await page.getByRole('option', { name: departments[0].name }).click();

    await page.getByRole('button', { name: /^open$/i }).click();

    const request = await openBody;
    const payload = request.postDataJSON() as { patientId: string; departmentId?: string };
    expect(payload.departmentId, 'departmentId must reach the gateway — H-4').toBe(departments[0].id);
  });

  test('W1: an existing draft is editable and the save carries If-Match', async ({ page }) => {
    await page.goto(SCRIBE);
    await expect(page.getByRole('region', { name: 'Case note' })).toBeVisible();

    // Find a consultation that already has a persisted summary to edit.
    const target = await page.evaluate(async () => {
      const list = await fetch('/api/hope/consultations?limit=50');
      if (!list.ok) return null;
      const body = (await list.json()) as { data?: Array<{ id: string; patientId: string }> };
      for (const row of body.data ?? []) {
        const summary = await fetch(`/api/hope/consultations/${row.id}/summary/latest`);
        if (summary.ok) {
          const parsed = (await summary.json()) as { id: string; version: number };
          if (parsed?.id) return { consultationId: row.id, patientId: row.patientId, version: parsed.version };
        }
      }
      return null;
    });
    test.skip(!target, 'No seeded consultation carries a generated summary to edit.');

    await page.getByRole('button', { name: new RegExp(target!.patientId, 'i') }).first().click();

    const editButton = page.getByRole('button', { name: /edit note/i });
    await expect(editButton).toBeVisible();
    await editButton.click();

    const editor = page.getByRole('textbox', { name: /case note/i });
    await expect(editor).toBeVisible();
    await editor.fill('E2E clinician edit — this text must reach the server verbatim.');

    const patch = page.waitForRequest(
      (request) => request.method() === 'PATCH' && /\/api\/hope\/consultations\/.+\/summary\/.+/.test(request.url()),
    );
    await page.getByRole('button', { name: /^save note$/i }).click();

    const request = await patch;
    // Without If-Match this route answers 428 and never writes.
    expect(request.headers()['if-match'], 'PATCH must carry the If-Match precondition').toBe(`"${target!.version}"`);
    const body = request.postDataJSON() as { content: string; expectedVersion: number; changeSource: string };
    expect(body.content).toBe('E2E clinician edit — this text must reach the server verbatim.');
    expect(body.expectedVersion).toBe(target!.version);
    expect(body.changeSource).toBe('doctor_edit');

    const response = await (await request.response())!.status();
    expect(response, 'the edit must actually persist').toBe(200);
  });

/**
   * The seeded stack carries no generated summary (summary generation needs
   * apps/text, which is not running here), so the edit path is exercised with
   * the summary reads/writes ROUTE-MOCKED at the BFF boundary. Everything
   * above that boundary is the real thing: the production Next build, real
   * React, real Radix, real CSS — and the assertions are made on the actual
   * outgoing HTTP request.
   */
  async function withMockedDraft(page: import('@playwright/test').Page, patch: { status: number; body?: object }) {
    const draft = { id: 'sum-e2e', consultationId: 'c-e2e', type: 'summary', content: 'S: seeded draft content.', version: 7 };
    await page.route('**/api/hope/consultations?*', (route) =>
      route.fulfill({ json: { data: [{ id: 'c-e2e', patientId: 'P-E2E', status: 'CLOSED', createdAt: new Date().toISOString() }], count: 1 } }),
    );
    await page.route('**/api/hope/consultations/c-e2e', (route) => route.fulfill({ json: { ...draft, id: 'c-e2e', patientId: 'P-E2E', status: 'CLOSED' } }));
    await page.route('**/api/hope/consultations/c-e2e/summary/latest', (route) =>
      route.fulfill({ headers: { etag: '"7"' }, json: draft }),
    );
    await page.route('**/api/hope/consultations/c-e2e/summary/sum-e2e', (route) =>
      route.fulfill({ status: patch.status, json: patch.body ?? { message: 'Precondition Failed' } }),
    );
  }

  test('W1: the editor issues a PATCH carrying If-Match (real browser, mocked gateway)', async ({ page }) => {
    await withMockedDraft(page, { status: 200, body: { id: 'sum-e2e', consultationId: 'c-e2e', type: 'summary', content: 'edited', version: 8 } });
    await page.goto(SCRIBE);

    await page.getByRole('button', { name: /P-E2E/i }).first().click();
    await page.getByRole('button', { name: /edit note/i }).click();

    const editor = page.getByRole('textbox', { name: /case note/i });
    await editor.fill('S: penicillin allergy — DO NOT PRESCRIBE.');

    const patchRequest = page.waitForRequest((r) => r.method() === 'PATCH' && r.url().includes('/summary/sum-e2e'));
    await page.getByRole('button', { name: /^save note$/i }).click();

    const request = await patchRequest;
    expect(request.headers()['if-match'], 'the route is 428 without this').toBe('"7"');
    const body = request.postDataJSON() as { content: string; expectedVersion: number; changeSource: string };
    expect(body.content).toBe('S: penicillin allergy — DO NOT PRESCRIBE.');
    expect(body.expectedVersion).toBe(7);
    expect(body.changeSource).toBe('doctor_edit');
  });

  test('R5: a 412 keeps the clinician text on screen and offers a resolution', async ({ page }) => {
    await withMockedDraft(page, { status: 412 });
    await page.goto(SCRIBE);

    await page.getByRole('button', { name: /P-E2E/i }).first().click();
    await page.getByRole('button', { name: /edit note/i }).click();

    const editor = page.getByRole('textbox', { name: /case note/i });
    await editor.fill('S: allergic to penicillin. Anaphylaxis 2019.');
    await page.getByRole('button', { name: /^save note$/i }).click();

    await expect(page.getByText(/changed while you were editing/i)).toBeVisible();
    // The one unacceptable outcome: clinician text silently discarded.
    await expect(editor).toHaveValue('S: allergic to penicillin. Anaphylaxis 2019.');
    await expect(page.getByRole('button', { name: /overwrite with my version/i })).toBeVisible();
  });

  test('has no WCAG 2.2 AA violations with the editor open and in conflict (light)', async ({ page }) => {
    await withMockedDraft(page, { status: 412 });
    await page.goto(SCRIBE);
    await page.getByRole('button', { name: /P-E2E/i }).first().click();
    await page.getByRole('button', { name: /edit note/i }).click();
    await page.getByRole('textbox', { name: /case note/i }).fill('conflicted text');
    await page.getByRole('button', { name: /^save note$/i }).click();
    await expect(page.getByText(/changed while you were editing/i)).toBeVisible();
    await expectNoA11yViolations(page);
  });

  test('has no WCAG 2.2 AA violations (light)', async ({ page }) => {
    await page.goto(SCRIBE);
    await expect(page.getByRole('region', { name: 'Case note' })).toBeVisible();
    await expectNoA11yViolations(page);
  });

  /**
   * Dark mode carries ONE pre-existing, out-of-boundary contrast defect, so
   * this scan is scoped rather than skipped.
   *
   * `select.tsx:32` styles the unset state `data-[placeholder]:text-muted-
   * foreground` over `dark:bg-input/30`, giving #a0a0a0 on #3b3a3a = 4.33:1
   * against a 4.5:1 requirement. It fires on EVERY Select left unset in dark
   * mode console-wide — here the footer's "Language" and "Note assistant"
   * pickers, both of which predate (base commit 6b066dd0f) and live
   * in `packages/ui`, which does not own. Reported to the
   * orchestrator; excluded here so this spec still guards the surfaces this
   * ticket DOES own.
   *
   * own pickers are deliberately NOT affected: they default to a
   * real sentinel option ("No department" / "Default style") instead of a
   * placeholder, so `data-placeholder` is never set on them.
 */
  test('has no WCAG 2.2 AA violations (dark), outside one known packages/ui defect', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.goto(SCRIBE);
    await expect(page.getByRole('region', { name: 'Case note' })).toBeVisible();
    await page.addStyleTag({ content: '*, *::before, *::after { transition: none !important; animation: none !important; }' });

    const results = await new AxeBuilder({ page })
      .withTags(WCAG_TAGS)
      .exclude('#stt-language-mode')
      .exclude('button[aria-label="Note assistant"]')
      .analyze();
    expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([]);
  });

});
